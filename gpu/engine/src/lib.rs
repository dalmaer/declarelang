//! The render=gpu engine. One object, driven from the worker's host (gpu/src/host.ts):
//!
//! - **Fonts.** `add_font` takes a font file's bytes (TTF, OTF, WOFF or WOFF2 — the web
//!   formats are decoded here) and registers its faces; the host's fallback table decides
//!   which registered family a style's family names resolve to.
//! - **Text.** A line of text is shaped once by Parley (HarfRust shaping, per-character
//!   font fallback, bidi within the line) and cached; `measure` answers the runtime's
//!   measurer, and `text` draws the same cached glyph runs, so what is measured is what
//!   is drawn. Where lines break is the runtime's decision, not the engine's.
//! - **Drawing.** A frame is encoded into a Vello scene by calls that each carry their
//!   own transform (the host composes them): rounded boxes filled with a colour or a
//!   gradient, inside borders, blurred box shadows, glyph runs, and layers that clip and
//!   fade a subtree. `render` rasterizes the scene on the GPU and presents it.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use parley::fontique::Blob as FontBlob;
use parley::{FontContext, FontFamily, FontStyle, FontWeight, LayoutContext, PositionedLayoutItem, StyleProperty};
use skrifa::MetadataProvider;
use vello::kurbo::{Affine, Point, Rect, RoundedRect, RoundedRectRadii, Stroke};
use vello::peniko::{BlendMode, Color, ColorStop, Extend, Fill, FontData, Gradient};
use vello::{AaConfig, AaSupport, Glyph, RenderParams, Renderer, RendererOptions, Scene};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

mod layers;
mod compose;
mod host;
mod paint;
mod timing;

/// One run of a shaped line: the glyphs of one face, positioned from the line's start on
/// its baseline.
struct Run {
    font: FontData,
    size: f32,
    vcoords: Vec<i16>,
    embolden: bool,
    skew: Option<f32>,
    glyphs: Vec<Glyph>,
    /// The face as the glyph atlas knows it: font, instance, synthesis.
    face: u64,
    /// The face has colour glyphs (drawn by Vello, not from the atlas).
    color: bool,
}

/// A shaped line, cached by everything that shapes it.
struct Shaped {
    width: f32,
    ascent: f32,
    descent: f32,
    runs: Vec<Run>,
}

#[derive(Hash, PartialEq, Eq)]
struct ShapeKey {
    families: String,
    size: u32,
    weight: u32,
    italic: bool,
    spacing: u32,
    text: String,
}

const SHAPE_CAP: usize = 20_000;

#[wasm_bindgen]
pub struct Engine {
    fcx: FontContext,
    lcx: LayoutContext<[u8; 4]>,
    shaped: HashMap<ShapeKey, Rc<Shaped>>,
    /// Shaped lines by handle (`line`), for the frame's command buffer (`run`). Cleared with
    /// the cache; `generation` tells the host its handles are gone.
    lines: Vec<Rc<Shaped>>,
    line_of: HashMap<ShapeKey, u32>,
    /// Whether a face (its data's id and index) has colour glyphs, found once.
    color_faces: HashMap<(u64, u32), bool>,
    generation: u32,
    /// Applied before every command's own transform (`set_offset`).
    offset: Affine,
    /// Decoded images by handle (`add_image`), drawn by `run`'s image command.
    images: HashMap<u32, vello::peniko::ImageBrush>,
    /// Shape clips (a view's `clip` path), by view id.
    shapes: HashMap<u32, vello::kurbo::BezPath>,
    /// While a layer is made: the texture's rect. A command that draws wholly outside it is
    /// skipped (a frost's backdrop is the whole frame's commands, for a card-sized texture).
    cull: Option<Rect>,
    scene: Scene,
    /// Drawings, each its own scene, encoded when the drawing changes and appended to
    /// the frame by transform alone (`picture_draw`).
    pictures: HashMap<u32, Scene>,
    /// Where each drawing reaches, in its own space: the union of its marks, gathered as it is
    /// recorded (paint.rs batches drawings that do not overlap what is drawn between them).
    picture_reach: HashMap<u32, Rect>,
    /// While a picture is being encoded, the calls go to it (`picture_begin`).
    /// Pictures and layers being recorded, innermost last (a layer made while a drawing is
    /// recorded nests inside it); empty when the frame itself is the target.
    recording: Vec<(u32, Scene)>,
    /// The glyph atlas's places (paint.rs); its texture is the GPU's.
    atlas: paint::Atlas,
    /// Drawings rastered once, as sprites (paint.rs).
    sprites: paint::Sprites,
    /// Ordinary content drawn as quads (paint.rs); off, every command is Vello's.
    quads: bool,
    /// Between `layers_begin` and `layers_end`: the layers asked for, made together.
    pending_layers: Option<Vec<PendingLayer>>,
    gpu: Option<Gpu>,
    /// The runtime's layer tree, drawn through this engine (host/).
    host: Option<Box<host::Host>>,
    /// Kept subtrees' plans, by the host's key (paint.rs Kept), and what invalidates them all:
    /// the atlases' resets. `keep_plans` false (`&nokeep`) plans every subtree each frame.
    kept_plans: HashMap<u32, paint::Kept>,
    plan_epoch: u32,
    keep_plans: bool,
    /// Opacity groups' textures kept while their view's subtree stands (paint.rs KeptGroup),
    /// by view; the textures are the Gpu's `groups`.
    kept_groups: HashMap<u32, paint::KeptGroup>,
}

/// A layer asked for while layers are gathered (`layer`'s arguments).
struct PendingLayer { id: u32, cmds: Vec<f64>, ox: f64, oy: f64, w: u32, h: u32, passes: Vec<f64>, scale: f64 }

/// How wide the texture the gathered layers are rendered into is, and how tall it may grow.
const GATHER_W: u32 = 2048;
const GATHER_H: u32 = 4096;

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        // a panic says what and where on the worker's console before the module aborts
        std::panic::set_hook(Box::new(|info| {
            let console = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("console")).ok();
            let error = console.as_ref().and_then(|c| js_sys::Reflect::get(c, &JsValue::from_str("error")).ok());
            if let (Some(c), Some(f)) = (console, error.and_then(|f| f.dyn_into::<js_sys::Function>().ok())) {
                let _ = f.call1(&c, &JsValue::from_str(&format!("[engine] {info}")));
            }
        }));
        Engine { fcx: FontContext::new(), lcx: LayoutContext::new(), shaped: HashMap::new(), lines: Vec::new(),
                 line_of: HashMap::new(), color_faces: HashMap::new(), generation: 0, offset: Affine::IDENTITY, images: HashMap::new(), shapes: HashMap::new(), cull: None, scene: Scene::new(),
                 pictures: HashMap::new(), picture_reach: HashMap::new(), recording: Vec::new(), atlas: paint::Atlas::default(), sprites: paint::Sprites::default(), quads: true,
                 pending_layers: None, gpu: None, host: None, kept_plans: HashMap::new(), plan_epoch: 0, keep_plans: true, kept_groups: HashMap::new() }
    }

    // ── the host (host/): the runtime's commits in, frames out ─────────────────────

    /// Start the host for a page of `width` × `height` at `dpr`. `flags`: cull, damage,
    /// layers, census, nosharpen, nofrost, imgq (-1: by the view), noclip.
    pub fn host_init(&mut self, flags: &[f64], width: f64, height: f64, dpr: f64, time_origin: f64) {
        let f = |i: usize| flags.get(i).copied().unwrap_or(0.0);
        let mut h = host::Host::new(host::Flags { cull: f(0) != 0.0, damage: f(1) != 0.0, layers: f(2) != 0.0, census: f(3) != 0.0,
            nosharpen: f(4) != 0.0, nofrost: f(5) != 0.0, imgq: f(6), noclip: f(7) != 0.0 });
        h.width = width; h.height = height; h.dpr = dpr;
        h.set_time_origin(time_origin);
        self.host = Some(Box::new(h));
    }
    /// A commit: the ops (JSON) and `n` geometry records [seq, id, x, y, w, h] (MacHost.commitGeom).
    pub fn host_commit(&mut self, json: &str, geoms: &[f64], n: usize) { self.with_host(|h, e| h.commit(e, json, geoms, n)); }
    /// Draw a frame if anything changed.
    pub fn host_paint(&mut self) { self.with_host(|h, e| h.paint_now(e)); }
    /// Something changed that a frame must show.
    pub fn host_dirty(&self) -> bool { self.host.as_ref().is_some_and(|h| h.dirty) }
    /// What the platform is asked for since the last call: 1 a tick (glides), 2 a frame at the
    /// next tick (drawings to sharpen).
    pub fn host_take_wants(&mut self) -> u32 {
        let Some(h) = self.host.as_mut() else { return 0 };
        let w = std::mem::take(&mut h.wants);
        (if w.tick { 1 } else { 0 }) | (if w.sharpen { 2 } else { 0 })
    }
    pub fn host_has_facts(&self) -> bool { self.host.as_ref().is_some_and(|h| h.has_facts()) }
    /// The scroll facts the runtime hears (JSON rows), "" when none.
    pub fn host_take_facts(&mut self) -> String { self.host.as_mut().map(|h| h.take_facts()).unwrap_or_default() }
    /// What the page must do (JSON rows), "" when nothing.
    pub fn host_take_shell(&mut self) -> String { self.host.as_mut().map(|h| h.take_shell()).unwrap_or_default() }
    /// The Texts to lay out before the next frame (JSON rows), "" when none.
    pub fn host_text_wanted(&mut self) -> String { self.host.as_mut().map(|h| h.text_wanted()).unwrap_or_default() }
    pub fn host_text_answer(&mut self, json: &str) { if let Some(h) = self.host.as_mut() { h.text_answer(json); } }
    /// The views out of their plane, whose projections the next frame needs.
    pub fn host_three(&self) -> Vec<u32> { self.host.as_ref().map(|h| h.three()).unwrap_or_default() }
    pub fn host_set_projection(&mut self, id: u32, h9: &[f64]) { if let Some(h) = self.host.as_mut() { h.set_projection(id, h9); } }
    pub fn host_image_size(&mut self, handle: u32, w: f64, h: f64) { if let Some(x) = self.host.as_mut() { x.image_size(handle, w, h); } }
    pub fn host_image_landed(&mut self, handle: u32) { if let Some(h) = self.host.as_mut() { h.image_landed(handle); } }
    /// A view's drawing was recorded: its reach (x y w h pad; empty when unknown).
    pub fn host_picture_made(&mut self, id: u32, b: &[f64]) { if let Some(h) = self.host.as_mut() { h.picture_made(id, b); } }
    pub fn host_fonts_changed(&mut self) { if let Some(h) = self.host.as_mut() { h.fonts_changed(); } }
    /// The page shows a DOM field over field `id` (on), or took it away.
    pub fn host_field_shown(&mut self, id: u32, on: bool) { if let Some(h) = self.host.as_mut() { h.field_shown(id, on); } }
    pub fn host_resize(&mut self, width: f64, height: f64, dpr: f64) { self.with_host(|h, e| h.resize(e, width, height, dpr)); }
    /// A wheel: [0] nothing took it, [1] a claimant hears it, [2, owners…] a scroller took it.
    pub fn host_wheel(&mut self, x: f64, y: f64, dx: f64, dy: f64, pinch: bool, notch: bool) -> Vec<f64> {
        self.host.as_mut().map(|h| h.wheel(x, y, dx, dy, pinch, notch)).unwrap_or_else(|| vec![0.0])
    }
    /// A wheel stream over this scroller went quiet.
    pub fn host_quiet(&mut self, id: u32) { if let Some(h) = self.host.as_mut() { h.quiet(id); } }
    /// A pointer event, before the program hears it: true when the scrollbar took it.
    pub fn host_bar_pointer(&mut self, kind: &str, x: f64, y: f64, pointer: &str) -> bool {
        self.host.as_mut().is_some_and(|h| h.bar_pointer(kind, x, y, pointer))
    }
    /// The pane a touch would scroll at a page point (-1: none).
    /// The page scrolls the window for the root (a whole-page app).
    pub fn host_set_page_native(&mut self, on: bool) { if let Some(h) = self.host.as_mut() { h.page_native = on; h.dirty = true; } }
    /// The page scrolled the window to `y`.
    pub fn host_page_scroll(&mut self, y: f64) { if let Some(h) = self.host.as_mut() { h.page_scroll(y); } }
    /// Views that take a finger, added and removed.
    pub fn host_touch_claims(&mut self, add: &[f64], remove: &[f64]) { if let Some(h) = self.host.as_mut() { h.touch_claims(add, remove); } }
    /// A finger is dragging a scrollbar (the touch session stands down).
    pub fn host_bar_scrubbing(&self) -> bool { self.host.as_ref().is_some_and(|h| h.bar_scrubbing()) }
    pub fn host_pane_at(&self, x: f64, y: f64) -> i32 { self.host.as_ref().and_then(|h| h.pane_at(x, y)).map(|v| v as i32).unwrap_or(-1) }
    pub fn host_scroll_info(&self, id: u32) -> Vec<f64> { self.host.as_ref().map(|h| h.scroll_info(id)).unwrap_or_default() }
    pub fn host_touch_start(&mut self, id: u32) { if let Some(h) = self.host.as_mut() { h.touch_start(id); } }
    pub fn host_touch_live(&mut self, id: u32) { if let Some(h) = self.host.as_mut() { h.touch_live(id); } }
    pub fn host_touch_apply(&mut self, id: u32, ox: f64, oy: f64, over_x: f64, over_y: f64) { if let Some(h) = self.host.as_mut() { h.touch_apply(id, ox, oy, over_x, over_y); } }
    pub fn host_touch_end(&mut self, id: u32) { if let Some(h) = self.host.as_mut() { h.touch_end(id); } }
    /// Step the glides: true while any is left.
    pub fn host_tick(&mut self) -> bool { self.host.as_mut().is_some_and(|h| h.tick_glides()) }
    /// The earliest input not yet answered by a frame (its page timestamp), unless one is held.
    pub fn host_input(&mut self, ts: f64) { if let Some(h) = self.host.as_mut() { if h.pending_input.is_none() { h.pending_input = Some(ts); } } }
    /// Frames, frame times, census and counts for the timing rig (JSON); `clear` starts anew.
    pub fn host_stats(&mut self, clear: bool) -> String { self.with_host(|h, e| h.stats(e, clear)).unwrap_or_default() }
    /// Diagnostic: nodes by text, or `#id`'s subtree (JSON).
    pub fn host_probe(&self, text: &str) -> String { self.host.as_ref().map(|h| h.probe(text)).unwrap_or_default() }

    /// Register a font file's faces. Returns the family names it added, one per line.
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<String, JsValue> {
        let data = match bytes.get(0..4) {
            Some(b"wOF2") => wuff::decompress_woff2(&bytes).map_err(|e| JsValue::from_str(&format!("woff2: {e:?}")))?,
            Some(b"wOFF") => wuff::decompress_woff1(&bytes).map_err(|e| JsValue::from_str(&format!("woff: {e:?}")))?,
            _ => bytes,
        };
        let added = self.fcx.collection.register_fonts(FontBlob::new(Arc::new(data)), None);
        self.lines.clear();
        self.line_of.clear();
        self.generation += 1;
        let mut names = Vec::new();
        for (family, _) in added {
            if let Some(n) = self.fcx.collection.family_name(family) {
                names.push(n.to_string());
            }
        }
        self.shaped.clear();
        Ok(names.join("\n"))
    }

    /// The runtime's measurer: [width, fontAscent, fontDescent, inkAscent, inkDescent] in px.
    pub fn measure(&mut self, families: &str, size: f32, weight: f32, italic: bool, spacing: f32, text: &str) -> Vec<f32> {
        let s = self.shape(families, size, weight, italic, spacing, text);
        vec![s.width, s.ascent, s.descent]
    }

    /// A line's ink above and below its baseline: [ascent, descent]. Read from the glyphs'
    /// outlines, so asked for only where it is wanted (a cap or x height).
    pub fn ink(&mut self, families: &str, size: f32, weight: f32, italic: bool, spacing: f32, text: &str) -> Vec<f32> {
        let s = self.shape(families, size, weight, italic, spacing, text);
        let (mut up, mut down) = (0.0f32, 0.0f32);
        for r in &s.runs {
            let Ok(f) = skrifa::FontRef::from_index(r.font.data.as_ref(), r.font.index) else { continue };
            let coords: Vec<skrifa::instance::NormalizedCoord> = r.vcoords.iter().map(|&c| skrifa::instance::NormalizedCoord::from_bits(c)).collect();
            let gm = f.glyph_metrics(skrifa::instance::Size::new(r.size), skrifa::instance::LocationRef::new(&coords));
            for g in &r.glyphs {
                if let Some(bb) = gm.bounds(skrifa::GlyphId::new(g.id)) {
                    up = up.max(bb.y_max - g.y);
                    down = down.max(-bb.y_min + g.y);
                }
            }
        }
        vec![up, down]
    }

    /// A shaped line's handle, for `run`'s text commands. Valid until `generation` changes.
    pub fn line(&mut self, families: &str, size: f32, weight: f32, italic: bool, spacing: f32, text: &str) -> u32 {
        let key = ShapeKey {
            families: families.to_string(), size: size.to_bits(), weight: weight.to_bits(), italic,
            spacing: spacing.to_bits(), text: text.to_string(),
        };
        if let Some(&h) = self.line_of.get(&key) {
            return h;
        }
        let s = self.shape(families, size, weight, italic, spacing, text);
        let h = self.lines.len() as u32;
        self.lines.push(s);
        self.line_of.insert(key, h);
        h
    }

    /// Keep a decoded image (straight-alpha RGBA, `width` × `height`) under `handle`.
    pub fn add_image(&mut self, handle: u32, width: u32, height: u32, rgba: Vec<u8>) {
        let data = vello::peniko::ImageData {
            data: vello::peniko::Blob::new(Arc::new(rgba)),
            format: vello::peniko::ImageFormat::Rgba8,
            alpha_type: vello::peniko::ImageAlphaType::Alpha,
            width, height,
        };
        self.images.insert(handle, vello::peniko::ImageBrush::new(data));
    }

    /// A view's shape clip from SVG path data in its own space; false when it does not parse.
    pub fn set_shape(&mut self, id: u32, d: &str) -> bool {
        match vello::kurbo::BezPath::from_svg(d) {
            Ok(p) => { self.shapes.insert(id, p); true }
            Err(_) => { self.shapes.remove(&id); false }
        }
    }

    pub fn drop_shape(&mut self, id: u32) {
        self.shapes.remove(&id);
    }

    pub fn drop_image(&mut self, handle: u32) {
        self.images.remove(&handle);
        if let Some(g) = self.gpu.as_mut() {
            if let Some(p) = g.painter.as_mut() { p.drop_image(handle); }
            if let Some((t, img)) = g.bitmaps.remove(&handle) { g.renderer.unregister_texture(img); g.pool.retire(t); }
        }
    }

    /// What the painter did since the last call (paint.rs Counts), in its order; `clear` starts anew.
    pub fn paint_counts(&mut self, clear: bool) -> Vec<f64> {
        let c = &self.atlas.counts;
        let v = vec![c.glyphs as f64, c.atlas_draws as f64, c.resets as f64, c.vello as f64, c.backdrops as f64, c.insts as f64, c.plans as f64,
            c.sprites as f64, c.sprite_resets as f64, c.pictures as f64,
            c.sprite_miss[0] as f64, c.sprite_miss[1] as f64, c.sprite_miss[2] as f64, c.sprite_miss[3] as f64, c.sprite_miss[4] as f64,
            c.sprite_laid as f64, c.kept_plans as f64, c.kept_recorded as f64, c.kept_groups as f64, c.groups_made as f64];
        if clear { self.atlas.counts = paint::Counts::default(); }
        v
    }

    /// Keep what an unchanged subtree draws between frames — its commands (the host) and its
    /// plan (the painter) — the default; off (`&nokeep`) each is made every frame.
    pub fn set_keep(&mut self, on: bool) {
        self.keep_plans = on;
        if !on { self.kept_plans.clear(); }
        if let Some(h) = self.host.as_mut() { h.keep = on; }
    }

    /// Keep subtrees' plans only (the host still keeps their walks): `&nokeepplans`, to tell
    /// the two apart.
    pub fn set_keep_plans(&mut self, on: bool) { self.keep_plans = on; if !on { self.kept_plans.clear(); } }

    /// Draw ordinary content as quads (the default), or every command with Vello.
    pub fn set_quads(&mut self, on: bool) {
        self.quads = on;
        if let Some(g) = self.gpu.as_mut() { g.quads_on = on; }
    }

    /// Time each stage of a frame on the GPU too (timing.rs; `gpu_stages`).
    pub fn set_timing_detail(&mut self, on: bool) {
        let Some(g) = self.gpu.as_mut() else { return };
        let Some(t) = g.timer.as_ref() else { return };
        let s = t.stamps.clone();
        s.detail.set(on);
        g.renderer.set_encoder_hook(if on {
            Some(Box::new(move |enc: &mut wgpu::CommandEncoder, start: bool| s.write(enc, if start { "gap" } else { s.vello.get() })))
        } else { None });
    }

    /// The stages timed since the last call (`set_timing_detail`): a line each, name, GPU
    /// milliseconds and spans, tab-separated, the largest first.
    pub fn gpu_stages(&mut self) -> String { timing::take_stages() }

    /// The engine's textures, in MB, by holder: the frame (target and scratch), the backdrop
    /// snapshot, the pool, scroll tiles, scroll caches, layers' results, bitmaps, large
    /// drawings, kept groups, the quads' atlas, sprites and images; then how many kept groups.
    pub fn texture_bytes(&self) -> Vec<f64> {
        let Some(g) = self.gpu.as_ref() else { return Vec::new() };
        let mb = |t: &wgpu::Texture| (t.width() as u64 * t.height() as u64 * 4) as f64 / 1048576.0;
        let sum = |it: &mut dyn Iterator<Item = &wgpu::Texture>| it.map(mb).sum::<f64>();
        let painter = g.painter.as_ref().map_or(0.0, |p| p.texture_mb());
        vec![mb(&g.target) + mb(&g.scratch), g.snap.as_ref().map_or(0.0, |s| mb(&s.0)), g.pool.mb(),
            sum(&mut g.tiles.values()), sum(&mut g.caches.values()), sum(&mut g.kept.values().map(|k| &k.0)),
            sum(&mut g.bitmaps.values().map(|k| &k.0)), sum(&mut g.big.values()), sum(&mut g.groups.values()), painter,
            g.groups.len() as f64, g.pool.counts[0] as f64, g.pool.counts[1] as f64, g.pool.counts[2] as f64, g.pool.counts[3] as f64]
    }

    /// Time frames on the GPU (`&timing`, when the adapter can), or not: off by default, as
    /// reading the timestamps back costs the GPU process about 0.3 ms a frame.
    pub fn set_timing(&mut self, on: bool) {
        if !on { if let Some(g) = self.gpu.as_mut() { g.timer = None; } }
    }

    /// The drawings laid from another raster (moving) since the last call, once each: the host
    /// draws their area again, so that held still they are rastered exactly.
    pub fn take_sampled(&mut self) -> Vec<u32> {
        let mut v = std::mem::take(&mut self.sprites.sampled);
        v.sort_unstable();
        v.dedup();
        v
    }

    /// Moving drawings laid from their last raster (the default), or rastered exactly at
    /// every place and scale, at most 512 pixels (`&oldsprites`).
    pub fn set_moving_sprites(&mut self, on: bool) {
        self.sprites.exact_only = !on;
    }

    /// The handles' generation: when it moves, every handle `line` gave is gone.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// A shaped line's advance width.
    pub fn line_width(&self, h: u32) -> f32 {
        self.lines.get(h as usize).map(|s| s.width).unwrap_or(0.0)
    }

    /// Encode a frame's commands into the scene — one call for the whole frame. Each command
    /// is a code followed by its numbers; every drawing command carries its transform (6).
    ///   0 fill box        m x y w h r4 rgba
    ///   1 gradient box    m x y w h r4 kind angle cx cy radius n stops(2n)
    ///   2 border          m x y w h r4 width rgba
    ///   3 shadow          m x y w h radius blur rgba
    ///   4 layer           m alpha x y w h r4        (w < 0: no clip)
    ///   5 pop
    ///   6 picture         m id
    ///   7 text            m handle x baseline rgba
    ///   8 gradient text   m handle x baseline bx by bw bh angle n stops(2n)
    ///   9 fill path       m evenodd n path(n) b brush(b)
    ///  10 clip path       m evenodd n path(n)
    ///  11 image           m handle dx dy dw dh crop(0/1) boxW boxH quality(0 low/nearest, 1 medium, 2 high) tint(rgba, 0 = none)
    ///  16 sides           m x y w h r4 top right bottom left rgba   (a border whose sides differ in width)
    ///  17 kept mark       m key generation length  … 18 its end (paint.rs Kept)
    ///  19 group key       m view generation x0 y0 x1 y1   (the group next: paint.rs KeptGroup; the
    ///                     rect a moving layer draws in, device pixels)
    pub fn run(&mut self, c: &[f64]) {
        let mut i = 0;
        let n = c.len();
        while i < n {
            let code = c[i] as u32;
            i += 1;
            if code == 5 {
                self.target().pop_layer();
                continue;
            }
            if i + 6 > n { break; }
            let m = self.offset * affine(&c[i..i + 6]);
            i += 6;
            match code {
                0 => {
                    if !self.misses(m, Rect::new(c[i], c[i + 1], c[i] + c[i + 2], c[i + 1] + c[i + 3])) {
                        let shape = rrect(c[i], c[i + 1], c[i + 2], c[i + 3], &c[i + 4..i + 8]);
                        let col = color(c[i + 8] as u32);
                        self.target().fill(Fill::NonZero, m, col, None, &shape);
                    }
                    i += 9;
                }
                1 => {
                    let k = (c[i + 13] as usize) * 2;
                    if !self.misses(m, Rect::new(c[i], c[i + 1], c[i] + c[i + 2], c[i + 1] + c[i + 3])) {
                        let shape = rrect(c[i], c[i + 1], c[i + 2], c[i + 3], &c[i + 4..i + 8]);
                        let g = gradient(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 8] as u32, c[i + 9], c[i + 10], c[i + 11], c[i + 12], &c[i + 14..i + 14 + k]);
                        self.target().fill(Fill::NonZero, m, &g, None, &shape);
                    }
                    i += 14 + k;
                }
                2 => {
                    let (x, y, w, h, width) = (c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 8]);
                    let half = width / 2.0;
                    let inner: Vec<f64> = c[i + 4..i + 8].iter().map(|v| (v - half).max(0.0)).collect();
                    let shape = rrect(x + half, y + half, (w - width).max(0.0), (h - width).max(0.0), &inner);
                    let col = color(c[i + 9] as u32);
                    if !self.misses(m, Rect::new(x, y, x + w, y + h)) { self.target().stroke(&Stroke::new(width), m, col, None, &shape); }
                    i += 10;
                }
                3 => {
                    let rect = Rect::new(c[i], c[i + 1], c[i] + c[i + 2], c[i + 1] + c[i + 3]);
                    let col = color(c[i + 6] as u32);
                    let (radius, blur) = (c[i + 4], c[i + 5]);
                    if !self.misses(m, rect.inflate(blur * 1.5, blur * 1.5)) {
                        self.target().draw_blurred_rounded_rect(m, rect, col, radius, (blur / 2.0).max(0.01));
                    }
                    i += 7;
                }
                4 => {
                    let alpha = c[i] as f32;
                    let clip = if c[i + 3] < 0.0 { RoundedRect::new(-1e7, -1e7, 1e7, 1e7, 0.0) } else { rrect(c[i + 1], c[i + 2], c[i + 3], c[i + 4], &c[i + 5..i + 9]) };
                    self.target().push_layer(Fill::NonZero, BlendMode::default(), alpha, m, &clip);
                    i += 9;
                }
                6 => {
                    // into whatever is being made: the frame, or a layer's own scene
                    let id = c[i] as u32;
                    let pictures = std::mem::take(&mut self.pictures);
                    if let Some(p) = pictures.get(&id) {
                        self.target().append(p, Some(m));
                    }
                    self.pictures = pictures;
                    i += 1;
                }
                15 => {
                    // a layer's finished image (Engine::layer) over the device rect x y w h
                    let id = c[i] as u32;
                    let (x, y, w, h) = (c[i + 1], c[i + 2], c[i + 3], c[i + 4]);
                    i += 5;
                    let img = self.gpu.as_ref().and_then(|g| g.kept.get(&id)).map(|(_, im)| im.clone());
                    if let Some(img) = img {
                        let (iw, ih) = (img.width as f64, img.height as f64);
                        let t = m * Affine::translate((x, y)) * Affine::scale_non_uniform(w / iw, h / ih);
                        let brush = vello::peniko::ImageBrush::new(img).with_quality(vello::peniko::ImageQuality::Medium);
                        self.target().draw_image(&brush, t);
                    }
                }
                7 => {
                    if let Some(s) = self.lines.get(c[i] as usize).cloned() {
                        let t = m * Affine::translate((c[i + 1], c[i + 2]));
                        if self.misses(t, Self::line_rect(&s)) { i += 4; continue; }
                        let brush = vello::peniko::Brush::Solid(color(c[i + 3] as u32));
                        draw_runs(self.target(), &s, t, &brush);
                    }
                    i += 4;
                }
                14 => {
                    // a line's glyphs stroked (a text outline): handle x baseline width rgba
                    if let Some(s) = self.lines.get(c[i] as usize).cloned() {
                        let t = m * Affine::translate((c[i + 1], c[i + 2]));
                        if self.misses(t, Self::line_rect(&s)) { i += 5; continue; }
                        let brush = vello::peniko::Brush::Solid(color(c[i + 4] as u32));
                        let st = Stroke::new(c[i + 3]).with_join(vello::kurbo::Join::Round);
                        draw_runs_as(self.target(), &s, t, &brush, Some(&st));
                    }
                    i += 5;
                }
                8 => {
                    let k = (c[i + 8] as usize) * 2;
                    if let Some(s) = self.lines.get(c[i] as usize).cloned() {
                        let (x, baseline) = (c[i + 1], c[i + 2]);
                        let t = m * Affine::translate((x, baseline));
                        if self.misses(t, Self::line_rect(&s)) { i += 9 + k; continue; }
                        let g = gradient(c[i + 3] - x, c[i + 4] - baseline, c[i + 5], c[i + 6], 0, c[i + 7], 0.5, 0.5, 1.0, &c[i + 9..i + 9 + k]);
                        draw_runs(self.target(), &s, t, &vello::peniko::Brush::Gradient(g));
                    }
                    i += 9 + k;
                }
                9 => {
                    let even_odd = c[i] != 0.0;
                    let pn = c[i + 1] as usize;
                    let p = path(&c[i + 2..i + 2 + pn]);
                    let bn = c[i + 2 + pn] as usize;
                    let br = brush(&c[i + 3 + pn..i + 3 + pn + bn]);
                    let rule = if even_odd { Fill::EvenOdd } else { Fill::NonZero };
                    if !self.misses(m, vello::kurbo::Shape::bounding_box(&p)) { self.target().fill(rule, m, &br, None, &p); }
                    i += 3 + pn + bn;
                }
                10 => {
                    let even_odd = c[i] != 0.0;
                    let pn = c[i + 1] as usize;
                    let p = path(&c[i + 2..i + 2 + pn]);
                    let rule = if even_odd { Fill::EvenOdd } else { Fill::NonZero };
                    self.target().push_layer(rule, BlendMode::default(), 1.0, m, &p);
                    i += 2 + pn;
                }
                11 => {
                    let handle = c[i] as u32;
                    let (dx, dy, dw, dh) = (c[i + 1], c[i + 2], c[i + 3], c[i + 4]);
                    let crop = c[i + 5] != 0.0;
                    let (bw, bh) = (c[i + 6], c[i + 7]);
                    let quality = match c[i + 8] as u32 { 0 => vello::peniko::ImageQuality::Low, 1 => vello::peniko::ImageQuality::Medium, _ => vello::peniko::ImageQuality::High };
                    let tint = c[i + 9] as u32;
                    i += 10;
                    // a decoded image's pixels, or the texture copied from its bitmap (a video's frame too)
                    let img = match self.images.get(&handle).cloned() {
                        Some(i) => i,
                        None => match self.gpu.as_ref().and_then(|g| g.bitmaps.get(&handle)) {
                            Some((_, im)) => vello::peniko::ImageBrush::new(im.clone()),
                            None => continue,
                        },
                    };
                    let (nw, nh) = (img.image.width as f64, img.image.height as f64);
                    if nw <= 0.0 || nh <= 0.0 || dw <= 0.0 || dh <= 0.0 { continue; }
                    let t = m * Affine::translate((dx, dy)) * Affine::scale_non_uniform(dw / nw, dh / nh);
                    if self.misses(m, Rect::new(dx, dy, dx + dw, dy + dh)) { continue; }
                    let brush = img.with_quality(quality);
                    let natural = Rect::new(0.0, 0.0, nw, nh);
                    let target = match self.recording.last_mut() { Some((_, s)) => s, None => &mut self.scene };
                    if crop { target.push_layer(Fill::NonZero, BlendMode::default(), 1.0, m, &Rect::new(0.0, 0.0, bw, bh)); }
                    if tint == 0 {
                        target.draw_image(&brush, t);
                    } else {
                        // the tint fills the image's own alpha: the image, then the colour composited onto it
                        target.push_layer(Fill::NonZero, BlendMode::default(), 1.0, t, &natural);
                        target.draw_image(&brush, t);
                        target.push_layer(Fill::NonZero, BlendMode::new(vello::peniko::Mix::Normal, vello::peniko::Compose::SrcIn), 1.0, t, &natural);
                        target.fill(Fill::NonZero, t, color(tint), None, &natural);
                        target.pop_layer();
                        target.pop_layer();
                    }
                    if crop { target.pop_layer(); }
                }
                16 => {
                    // the ring between the box and its inner edge, whose corners shrink by the
                    // wider side beside them
                    let (x, y, w, h) = (c[i], c[i + 1], c[i + 2], c[i + 3]);
                    let r = &c[i + 4..i + 8];
                    let (t, rr, b, l) = (c[i + 8], c[i + 9], c[i + 10], c[i + 11]);
                    let col = color(c[i + 12] as u32);
                    i += 13;
                    if self.misses(m, Rect::new(x, y, x + w, y + h)) { continue; }
                    let outer = rrect(x, y, w, h, r);
                    let ir = [(r[0] - l.max(t)).max(0.0), (r[1] - rr.max(t)).max(0.0), (r[2] - rr.max(b)).max(0.0), (r[3] - l.max(b)).max(0.0)];
                    let inner = rrect(x + l, y + t, (w - l - rr).max(0.0), (h - t - b).max(0.0), &ir);
                    let mut ring = vello::kurbo::Shape::to_path(&outer, 0.1);
                    ring.extend(vello::kurbo::Shape::path_elements(&inner, 0.1));
                    self.target().fill(Fill::EvenOdd, m, col, None, &ring);
                }
                12 => {
                    // a view's shape clip, by its id (set_shape)
                    let id = c[i] as u32;
                    i += 1;
                    let shape = self.shapes.get(&id).cloned().unwrap_or_default();
                    self.target().push_layer(Fill::NonZero, BlendMode::default(), 1.0, m, &shape);
                }
                13 => {
                    // a blend group (push_blend's numbers; 0 = an isolated plain group)
                    let mode = c[i] as u32;
                    i += 1;
                    self.push_blend(mode);
                }
                // a kept subtree's marks (the painter's): nothing to draw
                17 => i += 3,
                18 => {}
                19 => i += 6,
                _ => break,
            }
        }
    }

    /// Clear the scene for a new frame.
    pub fn begin(&mut self) {
        self.scene.reset();
    }

    /// A rounded box filled with a colour (`rgba` is 0xRRGGBBAA).
    #[allow(clippy::too_many_arguments)]
    pub fn fill_box(&mut self, m: &[f64], x: f64, y: f64, w: f64, h: f64, r: &[f64], rgba: u32) {
        let shape = rrect(x, y, w, h, r);
        self.target().fill(Fill::NonZero, affine(m), color(rgba), None, &shape);
    }

    /// A rounded box filled with a gradient. `kind` 0 linear (CSS angle in degrees, the
    /// line through the box's centre), 1 radial (centre cx, cy as fractions of the box,
    /// radius r as a fraction of the farthest corner), 2 conic (from `angle`). `stops`
    /// is offset, rgba pairs.
    #[allow(clippy::too_many_arguments)]
    pub fn fill_box_gradient(&mut self, m: &[f64], x: f64, y: f64, w: f64, h: f64, r: &[f64],
                             kind: u32, angle: f64, cx: f64, cy: f64, radius: f64, stops: &[f64]) {
        let shape = rrect(x, y, w, h, r);
        let g = gradient(x, y, w, h, kind, angle, cx, cy, radius, stops);
        self.target().fill(Fill::NonZero, affine(m), &g, None, &shape);
    }

    /// A border drawn inside the box's edge (CSS border-box semantics).
    #[allow(clippy::too_many_arguments)]
    pub fn stroke_box(&mut self, m: &[f64], x: f64, y: f64, w: f64, h: f64, r: &[f64], width: f64, rgba: u32) {
        let half = width / 2.0;
        let inner: Vec<f64> = r.iter().map(|v| (v - half).max(0.0)).collect();
        let shape = rrect(x + half, y + half, (w - width).max(0.0), (h - width).max(0.0), &inner);
        self.target().stroke(&Stroke::new(width), affine(m), color(rgba), None, &shape);
    }

    /// A box shadow: the box's rounded rectangle offset and blurred (`blur` is the CSS
    /// blur radius; the Gaussian's deviation is half of it).
    #[allow(clippy::too_many_arguments)]
    pub fn shadow(&mut self, m: &[f64], x: f64, y: f64, w: f64, h: f64, radius: f64, blur: f64, rgba: u32) {
        let rect = Rect::new(x, y, x + w, y + h);
        self.target().draw_blurred_rounded_rect(affine(m), rect, color(rgba), radius, (blur / 2.0).max(0.01));
    }

    /// Open a layer: what is drawn until `pop` is clipped to the rounded box and faded by
    /// `alpha`. A layer with no clip passes `w` < 0.
    #[allow(clippy::too_many_arguments)]
    pub fn push(&mut self, m: &[f64], alpha: f32, x: f64, y: f64, w: f64, h: f64, r: &[f64]) {
        let clip = if w < 0.0 { RoundedRect::new(-1e7, -1e7, 1e7, 1e7, 0.0) } else { rrect(x, y, w, h, r) };
        self.target().push_layer(Fill::NonZero, BlendMode::default(), alpha, affine(m), &clip);
    }

    pub fn pop(&mut self) {
        self.target().pop_layer();
    }

    /// Open a layer that composites what is drawn until `pop` onto what is beneath it by
    /// Canvas2D's `globalCompositeOperation` `mode` (drawing.ts COMPOSITE numbers the
    /// names); unclipped. Mode 0 (source-over) is the plain group a drawing that composites
    /// is isolated in, so its operators act on its own marks only.
    pub fn push_blend(&mut self, mode: u32) {
        use vello::peniko::{Compose as C, Mix as X};
        let blend = match mode {
            1 => BlendMode::new(X::Multiply, C::SrcOver), 2 => BlendMode::new(X::Screen, C::SrcOver),
            3 => BlendMode::new(X::Overlay, C::SrcOver), 4 => BlendMode::new(X::Darken, C::SrcOver),
            5 => BlendMode::new(X::Lighten, C::SrcOver), 6 => BlendMode::new(X::ColorDodge, C::SrcOver),
            7 => BlendMode::new(X::ColorBurn, C::SrcOver), 8 => BlendMode::new(X::HardLight, C::SrcOver),
            9 => BlendMode::new(X::SoftLight, C::SrcOver), 10 => BlendMode::new(X::Difference, C::SrcOver),
            11 => BlendMode::new(X::Exclusion, C::SrcOver), 12 => BlendMode::new(X::Hue, C::SrcOver),
            13 => BlendMode::new(X::Saturation, C::SrcOver), 14 => BlendMode::new(X::Color, C::SrcOver),
            15 => BlendMode::new(X::Luminosity, C::SrcOver),
            20 => BlendMode::new(X::Normal, C::Copy), 21 => BlendMode::new(X::Normal, C::SrcIn),
            22 => BlendMode::new(X::Normal, C::SrcOut), 23 => BlendMode::new(X::Normal, C::SrcAtop),
            24 => BlendMode::new(X::Normal, C::DestOver), 25 => BlendMode::new(X::Normal, C::DestIn),
            26 => BlendMode::new(X::Normal, C::DestOut), 27 => BlendMode::new(X::Normal, C::DestAtop),
            28 => BlendMode::new(X::Normal, C::Xor), 29 => BlendMode::new(X::Normal, C::Plus),
            _ => BlendMode::default(),
        };
        self.target().push_layer(Fill::NonZero, blend, 1.0, Affine::IDENTITY, &Rect::new(-1e7, -1e7, 1e7, 1e7));
    }

    /// Canvas2D's `drawImage`: the source rectangle (image pixels) of a loaded image into
    /// the destination rectangle, under `m`, faded by `alpha`; quality 0 is nearest-pixel.
    #[allow(clippy::too_many_arguments)]
    pub fn draw_image_rect(&mut self, m: &[f64], handle: u32, sx: f64, sy: f64, sw: f64, sh: f64,
                           dx: f64, dy: f64, dw: f64, dh: f64, quality: u32, alpha: f32) {
        // a decoded image's pixels, or the texture copied from its bitmap
        let img = match self.images.get(&handle).cloned() {
            Some(i) => i,
            None => match self.gpu.as_ref().and_then(|g| g.bitmaps.get(&handle)) {
                Some((_, im)) => vello::peniko::ImageBrush::new(im.clone()),
                None => return,
            },
        };
        if sw <= 0.0 || sh <= 0.0 || dw == 0.0 || dh == 0.0 { return; }
        let m = affine(m);
        self.reach(m, Rect::new(dx.min(dx + dw), dy.min(dy + dh), dx.max(dx + dw), dy.max(dy + dh)));
        let q = match quality { 0 => vello::peniko::ImageQuality::Low, 1 => vello::peniko::ImageQuality::Medium, _ => vello::peniko::ImageQuality::High };
        let whole = sx <= 0.0 && sy <= 0.0 && sx + sw >= img.image.width as f64 && sy + sh >= img.image.height as f64;
        let brush = img.with_quality(q).with_alpha(alpha);
        let t = m * Affine::translate((dx, dy)) * Affine::scale_non_uniform(dw / sw, dh / sh) * Affine::translate((-sx, -sy));
        let target = self.target();
        if !whole { target.push_layer(Fill::NonZero, BlendMode::default(), 1.0, m, &Rect::new(dx.min(dx + dw), dy.min(dy + dh), dx.max(dx + dw), dy.max(dy + dh))); }
        target.draw_image(&brush, t);
        if !whole { target.pop_layer(); }
    }

    /// A line of text, its start at (x, baseline) in the transform's space.
    #[allow(clippy::too_many_arguments)]
    pub fn text(&mut self, m: &[f64], families: &str, size: f32, weight: f32, italic: bool, spacing: f32,
                text: &str, x: f64, baseline: f64, rgba: u32) {
        let s = self.shape(families, size, weight, italic, spacing, text);
        let t = affine(m) * Affine::translate((x, baseline));
        let brush = vello::peniko::Brush::Solid(color(rgba));
        draw_runs(self.target(), &s, t, &brush);
    }

    /// A line of text filled with a linear gradient laid over the box (x, y, w, h) — Text's
    /// gradient `textFill`.
    #[allow(clippy::too_many_arguments)]
    pub fn text_gradient(&mut self, m: &[f64], families: &str, size: f32, weight: f32, italic: bool, spacing: f32,
                         text: &str, x: f64, baseline: f64, bx: f64, by: f64, bw: f64, bh: f64, angle: f64, stops: &[f64]) {
        let s = self.shape(families, size, weight, italic, spacing, text);
        let t = affine(m) * Affine::translate((x, baseline));
        // the ramp is laid in the box's space; the glyphs' transform moves them by
        // (x, baseline), so the brush is moved back by the same amount
        let g = gradient(bx - x, by - baseline, bw, bh, 0, angle, 0.5, 0.5, 1.0, stops);
        draw_runs(self.target(), &s, t, &vello::peniko::Brush::Gradient(g));
    }

    /// Start encoding drawing `id`: the calls that follow, until `picture_end`, make it.
    pub fn picture_begin(&mut self, id: u32) {
        let mut sc = self.pictures.remove(&id).unwrap_or_default();
        sc.reset();
        self.picture_reach.remove(&id);
        let v = self.sprites.versions.entry(id).or_insert((0, 0));
        *v = (v.0 + 1, self.atlas.plan_no());
        self.recording.push((id, sc));
    }

    pub fn picture_end(&mut self) {
        if let Some((id, sc)) = self.recording.pop() {
            self.pictures.insert(id, sc);
        }
    }

    /// Place drawing `id` in the frame under transform `m`.
    pub fn picture_draw(&mut self, m: &[f64], id: u32) {
        if let Some(p) = self.pictures.get(&id) {
            self.scene.append(p, Some(affine(m)));
        }
    }

    pub fn picture_drop(&mut self, id: u32) {
        self.picture_reach.remove(&id);
        self.sprites.versions.remove(&id);
        self.pictures.remove(&id);
        // a large drawing's own raster goes with it
        if self.sprites.big.remove(&id).is_some() {
            if let Some(g) = self.gpu.as_mut() { if let Some(t) = g.big.remove(&id) { g.pool.give(t); } }
        }
    }

    /// Fill a path (see `path`) with a brush (see `brush`), the brush placed by `bt`.
    pub fn fill_path(&mut self, m: &[f64], d: &[f64], even_odd: bool, b: &[f64], bt: &[f64]) {
        let p = path(d);
        let br = brush(b);
        let rule = if even_odd { Fill::EvenOdd } else { Fill::NonZero };
        self.reach(affine(m), vello::kurbo::Shape::bounding_box(&p));
        self.target().fill(rule, affine(m), &br, Some(affine(bt)), &p);
    }

    /// Stroke a path. `cap` 0 butt 1 round 2 square; `join` 0 miter 1 round 2 bevel.
    #[allow(clippy::too_many_arguments)]
    pub fn stroke_path(&mut self, m: &[f64], d: &[f64], width: f64, cap: u32, join: u32, miter: f64,
                       dash: &[f64], dash_offset: f64, b: &[f64], bt: &[f64]) {
        let p = path(d);
        let br = brush(b);
        let c = match cap { 1 => vello::kurbo::Cap::Round, 2 => vello::kurbo::Cap::Square, _ => vello::kurbo::Cap::Butt };
        let j = match join { 1 => vello::kurbo::Join::Round, 2 => vello::kurbo::Join::Bevel, _ => vello::kurbo::Join::Miter };
        let mut st = Stroke::new(width).with_caps(c).with_join(j).with_miter_limit(miter);
        if !dash.is_empty() {
            st = st.with_dashes(dash_offset, dash.iter().copied());
        }
        let grow = width / 2.0 * miter.max(1.0) + 1.0;
        self.reach(affine(m), vello::kurbo::Shape::bounding_box(&p).inflate(grow, grow));
        self.target().stroke(&st, affine(m), &br, Some(affine(bt)), &p);
    }

    /// Clip what follows, until `pop`, to a path.
    pub fn push_clip_path(&mut self, m: &[f64], d: &[f64], even_odd: bool) {
        let p = path(d);
        let rule = if even_odd { Fill::EvenOdd } else { Fill::NonZero };
        self.target().push_layer(rule, BlendMode::default(), 1.0, affine(m), &p);
    }

    /// A line of text in a drawing, filled with a brush (see `brush`).
    #[allow(clippy::too_many_arguments)]
    pub fn text_brush(&mut self, m: &[f64], families: &str, size: f32, weight: f32, italic: bool, spacing: f32,
                      text: &str, x: f64, baseline: f64, b: &[f64]) {
        let s = self.shape(families, size, weight, italic, spacing, text);
        let t = affine(m) * Affine::translate((x, baseline));
        self.reach(t, Self::line_rect(&s));
        let br = brush(b);
        draw_runs(self.target(), &s, t, &br);
    }

    /// A line of text in a drawing, its glyphs stroked with a brush (Canvas2D's strokeText):
    /// the stroke as `stroke_path` takes it.
    #[allow(clippy::too_many_arguments)]
    pub fn text_stroke_brush(&mut self, m: &[f64], families: &str, size: f32, weight: f32, italic: bool, spacing: f32,
                             text: &str, x: f64, baseline: f64, width: f64, cap: u32, join: u32, miter: f64,
                             dash: &[f64], dash_offset: f64, b: &[f64]) {
        let s = self.shape(families, size, weight, italic, spacing, text);
        let t = affine(m) * Affine::translate((x, baseline));
        let grow = width / 2.0 * miter.max(1.0) + 1.0;
        self.reach(t, Self::line_rect(&s).inflate(grow, grow));
        let c = match cap { 1 => vello::kurbo::Cap::Round, 2 => vello::kurbo::Cap::Square, _ => vello::kurbo::Cap::Butt };
        let j = match join { 1 => vello::kurbo::Join::Round, 2 => vello::kurbo::Join::Bevel, _ => vello::kurbo::Join::Miter };
        let mut st = Stroke::new(width).with_caps(c).with_join(j).with_miter_limit(miter);
        if !dash.is_empty() { st = st.with_dashes(dash_offset, dash.iter().copied()); }
        let br = brush(b);
        draw_runs_as(self.target(), &s, t, &br, Some(&st));
    }

    /// The advance width of a line (a drawing's textAlign).
    pub fn width(&mut self, families: &str, size: f32, weight: f32, italic: bool, spacing: f32, text: &str) -> f32 {
        self.shape(families, size, weight, italic, spacing, text).width
    }

    /// Attach the GPU this engine draws with.
    pub fn attach(&mut self, mut gpu: Gpu) {
        gpu.quads_on = self.quads;
        self.gpu = Some(gpu);
    }

    /// Render commands `cmds` (moved by (-ox, -oy), then scaled by `scale`) into a texture
    /// of their own, w×h times `scale`, run `passes` over it (layers.rs; lengths already in
    /// its texels), and keep the result as layer `id`'s image, which command 15 draws over
    /// the w×h rect. A layer that is blurred whole is made small and drawn stretched: what
    /// a wide blur leaves has no detail to lose. Rendered now, ahead of the frame using it.
    #[allow(clippy::too_many_arguments)]
    pub fn layer(&mut self, id: u32, cmds: &[f64], ox: f64, oy: f64, w: u32, h: u32, passes: &[f64], scale: f64) -> Result<(), JsValue> {
        if let Some(p) = self.pending_layers.as_mut() {
            p.push(PendingLayer { id, cmds: cmds.to_vec(), ox, oy, w, h, passes: passes.to_vec(), scale });
            // its texture now, at the size it will have, so what draws it before it is made
            // (command 15 in the drawing being recorded) names the texture it will be made in
            let k = scale.clamp(1.0 / 64.0, 1.0);
            let (tw, th) = ((((w as f64) * k).ceil() as u32).clamp(1, 8192), (((h as f64) * k).ceil() as u32).clamp(1, 8192));
            if let Some(g) = self.gpu.as_mut() { g.ensure_kept(id, tw, th); }
            return Ok(());
        }
        self.layer_now(id, cmds, ox, oy, w, h, passes, scale)
    }

    /// Gather the layers asked for from here to `layers_end`, to make them together.
    pub fn layers_begin(&mut self) { if self.quads { self.pending_layers.get_or_insert_with(Vec::new); } }

    /// Make the layers gathered since `layers_begin`. Those that are one picture each
    /// (command 6) are laid on shelves in one texture and rendered by one plan — a Vello batch
    /// for all of them rather than one each — then each is copied out and run through its
    /// passes; any other is made alone.
    pub fn layers_end(&mut self) -> Result<(), JsValue> {
        let Some(mut list) = self.pending_layers.take() else { return Ok(()) };
        // a layer asked for again (its drawing recorded again) is made as last asked
        let mut last: HashMap<u32, usize> = HashMap::new();
        for (i, l) in list.iter().enumerate() { last.insert(l.id, i); }
        let mut i = 0;
        list.retain(|l| { let keep = last.get(&l.id) == Some(&i); i += 1; keep });
        let mut batch: Vec<(PendingLayer, u32, u32, u32, u32)> = Vec::new();
        let (mut x, mut y, mut row) = (0u32, 0u32, 0u32);
        let mut result = Ok(());
        for l in list {
            let k = l.scale.clamp(1.0 / 64.0, 1.0);
            let (w, h) = ((((l.w as f64) * k).ceil() as u32).max(1), (((l.h as f64) * k).ceil() as u32).max(1));
            if l.cmds.len() != 8 || l.cmds[0] != 6.0 || w > GATHER_W || h > GATHER_H {
                let r = self.layer_now(l.id, &l.cmds, l.ox, l.oy, l.w, l.h, &l.passes, l.scale);
                if result.is_ok() { result = r; }
                continue;
            }
            if x + w > GATHER_W { x = 0; y += row + 1; row = 0; }
            if y + h > GATHER_H {
                let r = self.make_gathered(std::mem::take(&mut batch), y + row);
                if result.is_ok() { result = r; }
                (x, y, row) = (0, 0, 0);
            }
            batch.push((l, x, y, w, h));
            x += w + 1; row = row.max(h);
        }
        let r = self.make_gathered(batch, y + row);
        if result.is_ok() { result = r; }
        result
    }

    /// Render gathered layers, each a picture laid at its slot inside a clip of it, into one
    /// texture `height` tall, then copy each slot out and keep it as its layer.
    fn make_gathered(&mut self, batch: Vec<(PendingLayer, u32, u32, u32, u32)>, height: u32) -> Result<(), JsValue> {
        if batch.is_empty() { return Ok(()); }
        if batch.len() == 1 {
            let (l, ..) = &batch[0];
            return self.layer_now(l.id, &l.cmds, l.ox, l.oy, l.w, l.h, &l.passes, l.scale);
        }
        let mut cmds: Vec<f64> = Vec::with_capacity(batch.len() * 27);
        for (l, x, y, w, h) in &batch {
            let k = l.scale.clamp(1.0 / 64.0, 1.0);
            let m = Affine::translate((*x as f64, *y as f64)) * Affine::scale(k) * Affine::translate((-l.ox, -l.oy))
                * Affine::new([l.cmds[1], l.cmds[2], l.cmds[3], l.cmds[4], l.cmds[5], l.cmds[6]]);
            // a clip path of the slot (command 10: m, nonzero, the path's numbers)
            let (x0, y0, x1, y1) = (*x as f64, *y as f64, (*x + *w) as f64, (*y + *h) as f64);
            cmds.extend_from_slice(&[10.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 13.0,
                0.0, x0, y0, 1.0, x1, y0, 1.0, x1, y1, 1.0, x0, y1, 4.0]);
            cmds.push(6.0);
            cmds.extend_from_slice(&m.as_coeffs());
            cmds.push(l.cmds[7]);
            cmds.push(5.0);
        }
        let saved = self.offset;
        self.offset = Affine::IDENTITY;
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        let all = g.pool.take(&g.device, GATHER_W, height.max(1));
        let r = self.paint_into(&cmds, GATHER_W, height.max(1), &all, 0, 0);
        self.offset = saved;
        let g = self.gpu.as_mut().unwrap();
        if r.is_ok() {
            for (l, x, y, w, h) in batch {
                let tex = g.pool.take(&g.device, w, h);
                let mut enc = g.take_enc();
                enc.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo { texture: &all, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                    tex.as_image_copy(), wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
                g.enc = Some(enc);
                g.keep(l.id, tex, &l.passes);
            }
        }
        g.pool.give(all);
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn layer_now(&mut self, id: u32, cmds: &[f64], ox: f64, oy: f64, w: u32, h: u32, passes: &[f64], scale: f64) -> Result<(), JsValue> {
        let saved_offset = self.offset;

        let k = scale.clamp(1.0 / 64.0, 1.0);
        self.offset = Affine::scale(k) * Affine::translate((-ox, -oy));
        let (w, h) = (((w as f64) * k).ceil() as u32, ((h as f64) * k).ceil() as u32);
        if self.quads {
            let (w, h) = (w.clamp(1, 8192), h.clamp(1, 8192));
            let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
            let tex = g.pool.take(&g.device, w, h);
            let r = self.paint_into(cmds, w, h, &tex, 0, 0);
            self.offset = saved_offset;
            r?;
            self.gpu.as_mut().unwrap().keep(id, tex, passes);
            return Ok(());
        }
        self.recording.push((u32::MAX, Scene::new()));
        let saved_cull = self.cull.replace(Rect::new(-2.0, -2.0, w as f64 + 2.0, h as f64 + 2.0));
        self.run(cmds);
        self.cull = saved_cull;
        let scene = self.recording.pop().map(|(_, s)| s).unwrap_or_default();
        self.offset = saved_offset;
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.layer(id, &scene, w.clamp(1, 8192), h.clamp(1, 8192), passes)
    }

    /// A video's current frame, as image `handle`: copied on the GPU into a texture kept for
    /// it (registered with the renderer, as a layer's is), which command 11 draws like any
    /// image. The texture follows the frame's size.
    pub fn video_frame(&mut self, handle: u32, frame: web_sys::ImageBitmap) {
        self.copy_bitmap(handle, frame);
    }

    /// A decoded image, as image `handle`: copied from its bitmap on the GPU into a texture
    /// kept for it, as a video's frame is (no pixels read back). False when it cannot be
    /// (no GPU, or larger than a texture can be): the caller hands over its pixels instead.
    pub fn add_image_bitmap(&mut self, handle: u32, bitmap: web_sys::ImageBitmap) -> bool {
        let Some(g) = self.gpu.as_ref() else { return false };
        let max = g.device.limits().max_texture_dimension_2d;
        if bitmap.width() == 0 || bitmap.height() == 0 || bitmap.width() > max || bitmap.height() > max { return false; }
        self.images.remove(&handle);
        if let Some(p) = self.gpu.as_mut().and_then(|g| g.painter.as_mut()) { p.drop_image(handle); }
        self.copy_bitmap(handle, bitmap);
        true
    }

    /// Copy `frame` on the GPU into the texture kept for image `handle`, made anew when its size changes.
    fn copy_bitmap(&mut self, handle: u32, frame: web_sys::ImageBitmap) {
        let Some(g) = self.gpu.as_mut() else { return };
        let (w, h) = (frame.width().max(1), frame.height().max(1));
        let fresh = g.bitmaps.get(&handle).is_none_or(|(t, _)| t.width() != w || t.height() != h);
        if fresh {
            if let Some((t, img)) = g.bitmaps.remove(&handle) { g.renderer.unregister_texture(img); g.pool.retire(t); }
            let t = g.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("declare bitmap"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_DST
                    | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let img = g.renderer.register_texture(t.clone());
            g.bitmaps.insert(handle, (t, img));
        }
        let (t, img) = g.bitmaps.get(&handle).unwrap();
        g.queue.copy_external_image_to_texture(
            &wgpu::CopyExternalImageSourceInfo { source: wgpu::ExternalImageSource::ImageBitmap(frame), origin: wgpu::Origin2d::ZERO, flip_y: false },
            wgpu::CopyExternalImageDestInfo { texture: t, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All,
                color_space: wgpu::PredefinedColorSpace::Srgb, premultiplied_alpha: false },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        g.renderer.mark_override_image_dirty(img);
    }

    // ── the frame, composed (compose.rs) ───────────────────────────────────────────

    /// Start a frame over the device region (x, y, w, h) of the kept frame (the whole of it
    /// for a whole frame), over `base`.
    pub fn frame_start(&mut self, x: u32, y: u32, w: u32, h: u32, base: u32) {
        if let Some(g) = self.gpu.as_mut() {
            if let Some(t) = g.timer.as_ref() { t.begin(&g.device, &g.queue); }
            g.frame_start(x, y, w, h, color(base));
        }
    }

    /// A Vello pass: these commands (device space) over the region, laid over what is there.
    pub fn frame_pass(&mut self, cmds: &[f64]) -> Result<(), JsValue> {
        if self.quads { return self.paint_frame(cmds); }
        let Some((x, y, ..)) = self.gpu.as_ref().map(|g| g.region) else { return Err(JsValue::from_str("no gpu attached")) };
        let saved = self.offset;
        self.offset = Affine::translate((-(x as f64), -(y as f64)));
        self.scene.reset();
        self.run(cmds);
        self.offset = saved;
        let scene = std::mem::take(&mut self.scene);
        let r = self.gpu.as_mut().unwrap().frame_pass(&scene);
        self.scene = scene;
        r
    }

    /// Keep the frame's region as it stands as cache `id`.
    pub fn frame_keep(&mut self, id: u32) { if let Some(g) = self.gpu.as_mut() { g.frame_keep(id); } }
    /// Keep the next Vello pass as cache `id` too.
    pub fn frame_keep_next(&mut self, id: u32) { if let Some(g) = self.gpu.as_mut() { g.keep_next = Some(id); } }
    /// Lay cache `id` over the region, or (over = false) put it there; false if it is not kept at this size.
    pub fn frame_blit(&mut self, id: u32, over: bool) -> bool { self.gpu.as_mut().is_some_and(|g| g.frame_blit(id, over)) }
    pub fn cache_drop(&mut self, id: u32) { if let Some(g) = self.gpu.as_mut() { if let Some(t) = g.caches.remove(&id) { g.pool.retire(t); } } }
    /// A filled rounded rectangle over the frame (device pixels; rgba 0xRRGGBBAA), inside the clip.
    #[allow(clippy::too_many_arguments)]
    pub fn frame_rrect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, radius: f32, rgba: u32, cx0: f32, cy0: f32, cx1: f32, cy1: f32) {
        let Some(g) = self.gpu.as_mut() else { return };
        if g.passes_done == 0 { let _ = g.base_pass(); }
        let (x, y, w, h) = g.region;
        let sc = [cx0.max(x as f32).floor() as u32, cy0.max(y as f32).floor() as u32, cx1.min((x + w) as f32).ceil() as u32, cy1.min((y + h) as f32).ceil() as u32];
        let c = [((rgba >> 24) & 255) as f32 / 255.0, ((rgba >> 16) & 255) as f32 / 255.0, ((rgba >> 8) & 255) as f32 / 255.0, (rgba & 255) as f32 / 255.0];
        let mut enc = g.take_enc();
        g.quads.as_ref().unwrap().rrect(&g.device, &mut enc, &g.target, [x0, y0, x1, y1], radius, c, sc);
        g.enc = Some(enc);
        g.mark("scrollbars");
    }

    /// Tile `id` over the device rect (dx, dy, dw, dh), inside the device clip (x0 y0 x1 y1).
    #[allow(clippy::too_many_arguments)]
    pub fn frame_tile(&mut self, id: u32, dx: f32, dy: f32, dw: f32, dh: f32, x0: f32, y0: f32, x1: f32, y1: f32) {
        if let Some(g) = self.gpu.as_mut() {
            if g.passes_done == 0 { let _ = g.base_pass(); }
            g.frame_tile(id, dx, dy, dw, dh, [x0, y0, x1, y1]);
        }
    }

    /// The frame as it stands over the device rect, kept at `scale` as the shared backdrop.
    pub fn frame_snapshot(&mut self, x: u32, y: u32, w: u32, h: u32, scale: f64) {
        if let Some(g) = self.gpu.as_mut() {
            if g.passes_done == 0 { let _ = g.base_pass(); }
            g.frame_snapshot(x, y, w, h, scale);
        }
    }

    /// Show the frame; `frame` names it for `gpu_done`.
    pub fn frame_present(&mut self, frame: u32) -> Result<(), JsValue> {
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        if g.passes_done == 0 { g.base_pass()?; }
        g.present()?;
        if let Some(t) = g.timer.as_ref() { t.end(&g.device, &g.queue, frame); }
        g.queue.on_submitted_work_done(move || {
            DONE.with(|d| d.borrow_mut().push((frame, now())));
        });
        Ok(())
    }

    /// A scroller's tile: commands (moved by (-ox, -oy)) into a w×h texture of its own.
    pub fn tile(&mut self, id: u32, cmds: &[f64], ox: f64, oy: f64, w: u32, h: u32) -> Result<(), JsValue> {
        if self.quads {
            let (w, h) = (w.clamp(1, 8192), h.clamp(1, 8192));
            let t = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?.tile_texture(id, w, h);
            let saved = self.offset;
            self.offset = Affine::translate((-ox, -oy));
            let r = self.paint_tile(cmds, w, h, &t, 0, 0);
            self.offset = saved;
            return r;
        }
        let saved_offset = self.offset;
        self.offset = Affine::translate((-ox, -oy));
        self.recording.push((u32::MAX, Scene::new()));
        let saved_cull = self.cull.replace(Rect::new(-2.0, -2.0, w as f64 + 2.0, h as f64 + 2.0));
        self.run(cmds);
        self.cull = saved_cull;
        let scene = self.recording.pop().map(|(_, s)| s).unwrap_or_default();
        self.offset = saved_offset;
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.tile(id, &scene, w.clamp(1, 8192), h.clamp(1, 8192))
    }

    /// Draw part of kept tile `id` again: the area (x, y, w, h) of it, from commands in the
    /// same space as `tile`'s. False when the tile is not there or the area is larger than the
    /// scratch (the caller draws the whole tile).
    #[allow(clippy::too_many_arguments)]
    pub fn tile_patch(&mut self, id: u32, cmds: &[f64], ox: f64, oy: f64, x: u32, y: u32, w: u32, h: u32) -> Result<bool, JsValue> {
        if self.quads {
            let Some(t) = self.gpu.as_ref().and_then(|g| g.tiles.get(&id)).cloned() else { return Ok(false) };
            if w == 0 || h == 0 || x + w > t.width() || y + h > t.height() { return Ok(false); }
            let saved = self.offset;
            self.offset = Affine::translate((-ox - x as f64, -oy - y as f64));
            let r = self.paint_tile(cmds, w, h, &t, x, y);
            self.offset = saved;
            return r.map(|_| true);
        }
        let saved_offset = self.offset;
        self.offset = Affine::translate((-ox - x as f64, -oy - y as f64));
        self.recording.push((u32::MAX, Scene::new()));
        let saved_cull = self.cull.replace(Rect::new(-2.0, -2.0, w as f64 + 2.0, h as f64 + 2.0));
        self.run(cmds);
        self.cull = saved_cull;
        let scene = self.recording.pop().map(|(_, s)| s).unwrap_or_default();
        self.offset = saved_offset;
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.tile_patch(id, &scene, x, y, w, h)
    }

    pub fn tile_drop(&mut self, id: u32) {
        if let Some(g) = self.gpu.as_mut() { if let Some(t) = g.tiles.remove(&id) { g.pool.retire(t); } }
    }

    /// Render commands `cmds` (moved by (-ox, -oy), scaled by `scale`) as the frame's shared
    /// backdrop: several frosted views that nothing drawn between them overlaps read their
    /// backdrop from one render, not one each (host.ts paintBackdrop decides).
    #[allow(clippy::too_many_arguments)]
    pub fn snapshot(&mut self, cmds: &[f64], ox: f64, oy: f64, w: u32, h: u32, scale: f64) -> Result<(), JsValue> {
        let saved_offset = self.offset;
        let k = scale.clamp(1.0 / 64.0, 1.0);
        self.offset = Affine::scale(k) * Affine::translate((-ox, -oy));
        let (tw, th) = ((((w as f64) * k).ceil() as u32).clamp(1, 8192), (((h as f64) * k).ceil() as u32).clamp(1, 8192));
        if self.quads {
            let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
            let tex = g.pool.take(&g.device, tw, th);
            let r = self.paint_into(cmds, tw, th, &tex, 0, 0);
            self.offset = saved_offset;
            r?;
            let g = self.gpu.as_mut().unwrap();
            if let Some((old, ..)) = g.snap.replace((tex, ox, oy, k)) { g.pool.give(old); }
            return Ok(());
        }
        self.recording.push((u32::MAX, Scene::new()));
        let saved_cull = self.cull.replace(Rect::new(-2.0, -2.0, tw as f64 + 2.0, th as f64 + 2.0));
        self.run(cmds);
        self.cull = saved_cull;
        let scene = self.recording.pop().map(|(_, s)| s).unwrap_or_default();
        self.offset = saved_offset;
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.snapshot(&scene, tw, th, ox, oy, k)
    }

    /// Layer `id` from the device rect (x, y, w, h) of the frame's snapshot, through
    /// `passes` (in the snapshot's texels). False when there is no snapshot.
    pub fn layer_from_snapshot(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64, passes: &[f64]) -> bool {
        match self.gpu.as_mut() { Some(g) => g.layer_from_snapshot(id, x, y, w, h, passes), None => false }
    }

    /// Layer `id`'s image over the rect x y w h under `m`, into whatever is being made (a
    /// drawing's picture: a filtered op's layer). Command 15's twin, for direct callers.
    pub fn draw_layer(&mut self, m: &[f64], id: u32, x: f64, y: f64, w: f64, h: f64) {
        let img = self.gpu.as_ref().and_then(|g| g.kept.get(&id)).map(|(_, im)| im.clone());
        if let Some(img) = img {
            let (iw, ih) = (img.width as f64, img.height as f64);
            let t = affine(m) * Affine::translate((x, y)) * Affine::scale_non_uniform(w / iw, h / ih);
            let brush = vello::peniko::ImageBrush::new(img).with_quality(vello::peniko::ImageQuality::Medium);
            self.reach(affine(m), Rect::new(x, y, x + w, y + h));
            self.target().draw_image(&brush, t);
        }
    }

    /// Forget layer `id`'s image.
    pub fn layer_drop(&mut self, id: u32) {
        if let Some(g) = self.gpu.as_mut() {
            if let Some((t, img)) = g.kept.remove(&id) { g.renderer.unregister_texture(img); g.pool.retire(t); }
        }
    }

    /// The drawing surface's size in device pixels changed.
    pub fn resize(&mut self, width: u32, height: u32) {
        if let Some(g) = self.gpu.as_mut() {
            g.resize(width.max(1), height.max(1));
        }
    }

    /// Rasterize the scene and present it, over `base` (0xRRGGBBAA). `frame` names the
    /// frame for `gpu_done`.
    pub fn render(&mut self, base: u32, frame: u32) -> Result<(), JsValue> {
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.render(&self.scene, color(base))?;
        g.queue.on_submitted_work_done(move || {
            DONE.with(|d| d.borrow_mut().push((frame, now())));
        });
        Ok(())
    }

    /// Render only the region (x, y, w, h) of the frame — the commands having been run with
    /// `set_offset(x, y)` — and present the kept frame.
    #[allow(clippy::too_many_arguments)]
    pub fn render_region(&mut self, base: u32, frame: u32, x: u32, y: u32, w: u32, h: u32) -> Result<(), JsValue> {
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.render_region(&self.scene, color(base), x, y, w.max(1), h.max(1))?;
        g.queue.on_submitted_work_done(move || {
            DONE.with(|d| d.borrow_mut().push((frame, now())));
        });
        Ok(())
    }

    /// Where the next `run` draws from: its commands are moved by (-x, -y), so a region's
    /// corner lands at the origin of a partial render. (0, 0) for a whole frame.
    pub fn set_offset(&mut self, x: f64, y: f64) {
        self.offset = Affine::translate((-x, -y));
    }

    /// The frames the GPU has finished since the last call: frame, time (performance.now
    /// in this worker), in pairs.
    pub fn gpu_done(&mut self) -> Vec<f64> {
        DONE.with(|d| d.borrow_mut().drain(..).flat_map(|(f, t)| [f as f64, t]).collect())
    }

    /// The frames timed on the GPU since the last call (timestamp queries): frame,
    /// milliseconds, in pairs. Empty where the adapter has no timestamps.
    pub fn gpu_times(&mut self) -> Vec<f64> {
        timing::take()
    }

    /// How many shaped lines are cached (diagnostics).
    pub fn cached_lines(&self) -> usize {
        self.shaped.len()
    }
}

impl Engine {
    /// Run `f` with the host and the engine it draws through (the host is lent out meanwhile).
    fn with_host<R>(&mut self, f: impl FnOnce(&mut host::Host, &mut Engine) -> R) -> Option<R> {
        let mut h = self.host.take()?;
        let r = f(&mut h, self);
        self.host = Some(h);
        Some(r)
    }

    /// Does `r` under `m` miss the layer being made (never, outside one)?
    fn misses(&self, m: Affine, r: Rect) -> bool {
        match self.cull {
            None => false,
            Some(c) => { let b = m.transform_rect_bbox(r); b.x1 < c.x0 || b.x0 > c.x1 || b.y1 < c.y0 || b.y0 > c.y1 }
        }
    }
    /// A shaped line's reach from its start at the baseline.
    fn line_rect(s: &Shaped) -> Rect {
        Rect::new(-4.0, -(s.ascent as f64) * 1.5 - 4.0, s.width as f64 + 4.0, (s.descent as f64) * 1.5 + 4.0)
    }
    /// A mark over `r` under `m` widens the reach of the drawing being recorded.
    fn reach(&mut self, m: Affine, r: Rect) {
        if let Some(&(id, _)) = self.recording.last() {
            if id == u32::MAX { return; }
            let b = m.transform_rect_bbox(r);
            let e = self.picture_reach.entry(id).or_insert(b);
            *e = e.union(b);
        }
    }
    fn target(&mut self) -> &mut Scene {
        match self.recording.last_mut() { Some((_, sc)) => sc, None => &mut self.scene }
    }

    fn shape(&mut self, families: &str, size: f32, weight: f32, italic: bool, spacing: f32, text: &str) -> Rc<Shaped> {
        let key = ShapeKey {
            families: families.to_string(), size: size.to_bits(), weight: weight.to_bits(), italic,
            spacing: spacing.to_bits(), text: text.to_string(),
        };
        if let Some(s) = self.shaped.get(&key) {
            return s.clone();
        }
        if self.shaped.len() >= SHAPE_CAP {
            self.shaped.clear();
            self.lines.clear();
            self.line_of.clear();
            self.generation += 1;
        }
        // an empty line still has the face's ascent and descent: shape a space for them
        let shaped_text = if text.is_empty() { " " } else { text };
        let mut b = self.lcx.ranged_builder(&mut self.fcx, shaped_text, 1.0, true);
        b.push_default(StyleProperty::FontFamily(FontFamily::Source(std::borrow::Cow::Borrowed(families))));
        b.push_default(StyleProperty::FontSize(size));
        b.push_default(StyleProperty::FontWeight(FontWeight::new(weight)));
        if italic {
            b.push_default(StyleProperty::FontStyle(FontStyle::Italic));
        }
        if spacing != 0.0 {
            b.push_default(StyleProperty::LetterSpacing(spacing));
        }
        let mut layout = b.build(shaped_text);
        layout.break_all_lines(None);
        let mut runs = Vec::new();
        let (mut ascent, mut descent) = (0.0f32, 0.0f32);
        for line in layout.lines() {
            for item in line.items() {
                let PositionedLayoutItem::GlyphRun(gr) = item else { continue };
                let run = gr.run();
                let fm = run.font_metrics();
                ascent = ascent.max(fm.ascent);
                descent = descent.max(fm.descent);
                let font = run.font().clone();
                let synth = run.synthesis();
                let base = gr.baseline();
                let glyphs: Vec<Glyph> = gr.positioned_glyphs().map(|g| Glyph { id: g.id as u32, x: g.x, y: g.y - base }).collect();
                let vcoords: Vec<i16> = run.normalized_coords().iter().map(|c| c.to_bits()).collect();
                let face = {
                    use std::hash::{Hash, Hasher};
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    (font.data.id(), font.index, &vcoords, synth.embolden(), synth.skew().map(f32::to_bits)).hash(&mut h);
                    h.finish()
                };
                let color = *self.color_faces.entry((font.data.id(), font.index)).or_insert_with(|| {
                    skrifa::FontRef::from_index(font.data.as_ref(), font.index).is_ok_and(|f| {
                        [b"COLR", b"CBDT", b"sbix", b"SVG "].iter().any(|t| f.table_data(skrifa::Tag::new(t)).is_some())
                    })
                });
                runs.push(Run {
                    font, size: run.font_size(), vcoords, embolden: synth.embolden(), skew: synth.skew(), glyphs, face, color,
                });
            }
        }
        let width = if text.is_empty() { 0.0 } else { layout.full_width() };
        if text.is_empty() {
            runs.clear();
        }
        let s = Rc::new(Shaped { width, ascent, descent, runs });
        self.shaped.insert(key, s.clone());
        s
    }
}

fn draw_runs(scene: &mut Scene, s: &Shaped, t: Affine, brush: &vello::peniko::Brush) {
    draw_runs_as(scene, s, t, brush, None);
}

/// The glyphs filled, or stroked when `stroke` is given (a text outline).
fn draw_runs_as(scene: &mut Scene, s: &Shaped, t: Affine, brush: &vello::peniko::Brush, stroke: Option<&Stroke>) {
    for run in &s.runs {
        let skew = run.skew.map(|deg| Affine::skew((deg as f64).to_radians().tan(), 0.0));
        let mut d = scene.draw_glyphs(&run.font).font_size(run.size).transform(t).glyph_transform(skew)
            .normalized_coords(&run.vcoords).brush(brush).hint(false);
        if run.embolden {
            let a = run.size as f64 / 48.0;
            d = d.font_embolden(vello::FontEmbolden::new(vello::kurbo::Diagonal2 { xx: a, yy: a }));
        }
        match stroke {
            Some(st) => d.draw(st, run.glyphs.iter().copied()),
            None => d.draw(Fill::NonZero, run.glyphs.iter().copied()),
        }
    }
}

/// A path as numbers: 0 x y move, 1 x y line, 2 cx cy x y quad, 3 c1x c1y c2x c2y x y cubic, 4 close.
fn path(d: &[f64]) -> vello::kurbo::BezPath {
    let mut p = vello::kurbo::BezPath::new();
    let mut i = 0;
    while i < d.len() {
        match d[i] as u32 {
            0 if i + 2 < d.len() => { p.move_to((d[i + 1], d[i + 2])); i += 3; }
            1 if i + 2 < d.len() => { p.line_to((d[i + 1], d[i + 2])); i += 3; }
            2 if i + 4 < d.len() => { p.quad_to((d[i + 1], d[i + 2]), (d[i + 3], d[i + 4])); i += 5; }
            3 if i + 6 < d.len() => { p.curve_to((d[i + 1], d[i + 2]), (d[i + 3], d[i + 4]), (d[i + 5], d[i + 6])); i += 7; }
            4 => { p.close_path(); i += 1; }
            _ => break,
        }
    }
    p
}

/// A brush as numbers: [0, rgba] solid; [1, x0, y0, x1, y1, n, stops…] linear;
/// [2, x0, y0, r0, x1, y1, r1, n, stops…] radial; [3, angle, x, y, n, stops…] conic —
/// stops as offset, rgba pairs, in the space `bt` places.
fn brush(b: &[f64]) -> vello::peniko::Brush {
    let stops = |at: usize| -> Vec<ColorStop> {
        let n = b.get(at).copied().unwrap_or(0.0) as usize;
        (0..n).filter_map(|k| {
            let o = at + 1 + 2 * k;
            Some(ColorStop::from((*b.get(o)? as f32, color(*b.get(o + 1)? as u32))))
        }).collect()
    };
    let g = match b.first().copied().unwrap_or(0.0) as u32 {
        1 if b.len() > 5 => Gradient::new_linear((b[1], b[2]), (b[3], b[4])).with_stops(stops(5).as_slice()),
        2 if b.len() > 7 => Gradient::new_two_point_radial((b[1], b[2]), b[3] as f32, (b[4], b[5]), b[6] as f32).with_stops(stops(7).as_slice()),
        3 if b.len() > 4 => {
            let n = b[4] as usize;
            let raw: Vec<(f32, u32)> = (0..n).filter_map(|k| Some((*b.get(5 + 2 * k)? as f32, *b.get(6 + 2 * k)? as u32))).collect();
            sweep(Point::new(b[2], b[3]), b[1], &raw)
        }
        _ => return vello::peniko::Brush::Solid(color(b.get(1).copied().unwrap_or(0.0) as u32)),
    };
    vello::peniko::Brush::Gradient(g.with_extend(Extend::Pad))
}

fn affine(m: &[f64]) -> Affine {
    if m.len() < 6 { Affine::IDENTITY } else { Affine::new([m[0], m[1], m[2], m[3], m[4], m[5]]) }
}

/// A conic gradient starting at angle `a` (radians, clockwise from +x). Vello's sweep maps
/// the angle onto [start, end] without wrapping, so a start other than 0 would clamp the
/// last stretch to the end colour: the sweep runs 0..2π and the stops turn by `a` instead,
/// split where the turn wraps.
fn sweep(c: Point, a: f64, stops: &[(f32, u32)]) -> Gradient {
    let cs: Vec<ColorStop> = sweep_stops(a, stops).iter().map(|&(o, c)| ColorStop::from((o.clamp(0.0, 1.0), color(c)))).collect();
    Gradient::new_sweep(c, 0.0, std::f32::consts::TAU).with_stops(cs.as_slice())
}

/// A conic gradient's stops turned by `a` (radians), for a sweep that runs 0..2π.
fn sweep_stops(a: f64, stops: &[(f32, u32)]) -> Vec<(f32, u32)> {
    let tau = std::f64::consts::TAU;
    let shift = (a.rem_euclid(tau) / tau) as f32;
    let mut out: Vec<(f32, u32)> = Vec::new();
    if stops.is_empty() || shift == 0.0 {
        out.extend_from_slice(stops);
    } else {
        // the colour at the wrap point, offset 1 - shift in the stops' own terms
        let at = 1.0 - shift;
        let lerp = |p: (f32, u32), q: (f32, u32), t: f32| -> u32 {
            let ch = |v: u32, k: u32| ((v >> k) & 255) as f32;
            let mix = |k: u32| ((ch(p.1, k) + (ch(q.1, k) - ch(p.1, k)) * t).round().clamp(0.0, 255.0) as u32) << k;
            mix(24) | mix(16) | mix(8) | mix(0)
        };
        let wrap = {
            let first = stops[0];
            let last = *stops.last().unwrap();
            if at <= first.0 { first.1 } else if at >= last.0 { last.1 } else {
                let k = stops.windows(2).position(|w| w[0].0 <= at && at <= w[1].0).unwrap_or(0);
                let (p, q) = (stops[k], stops[k + 1]);
                lerp(p, q, if q.0 > p.0 { (at - p.0) / (q.0 - p.0) } else { 0.0 })
            }
        };
        out.push((0.0, wrap));
        for &(o, c) in stops.iter().filter(|s| s.0 >= at) { out.push((o - at, c)); }
        for &(o, c) in stops.iter().filter(|s| s.0 < at) { out.push((o + shift, c)); }
        out.push((1.0, wrap));
    }
    out.iter().map(|&(o, c)| (o.clamp(0.0, 1.0), c)).collect()
}

fn color(rgba: u32) -> Color {
    Color::from_rgba8((rgba >> 24) as u8, (rgba >> 16) as u8, (rgba >> 8) as u8, rgba as u8)
}

fn rrect(x: f64, y: f64, w: f64, h: f64, r: &[f64]) -> RoundedRect {
    let radii = match r.len() {
        0 => RoundedRectRadii::from_single_radius(0.0),
        1 | 2 | 3 => RoundedRectRadii::from_single_radius(r[0]),
        _ => RoundedRectRadii::new(r[0], r[1], r[2], r[3]),
    };
    RoundedRect::from_rect(Rect::new(x, y, x + w.max(0.0), y + h.max(0.0)), radii)
}

#[allow(clippy::too_many_arguments)]
fn gradient(x: f64, y: f64, w: f64, h: f64, kind: u32, angle: f64, cx: f64, cy: f64, radius: f64, stops_in: &[f64]) -> Gradient {
    let stops: Vec<ColorStop> = stops_in.chunks_exact(2)
        .map(|p| ColorStop::from((p[0] as f32, color(p[1] as u32))))
        .collect();
    let c = Point::new(x + w * cx, y + h * cy);
    let g = match kind {
        1 => {
            // the farthest corner from the centre is the ramp's end at r = 1
            let far = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)].iter()
                .map(|(px, py)| ((px - c.x).powi(2) + (py - c.y).powi(2)).sqrt()).fold(0.0, f64::max);
            Gradient::new_radial(c, (far * radius) as f32)
        }
        2 => {
            // CSS: 0deg points up and turns clockwise; the sweep's 0 is +x
            let raw: Vec<(f32, u32)> = stops_in.chunks_exact(2).map(|p| (p[0] as f32, p[1] as u32)).collect();
            return sweep(c, (angle - 90.0).to_radians(), &raw).with_extend(Extend::Pad);
        }
        _ => {
            // CSS: 0deg points up, angles turn clockwise; the line's length makes the
            // corners land on 0 and 1
            let t = angle.to_radians();
            let (dx, dy) = (t.sin(), -t.cos());
            let half = (w * dx.abs() + h * dy.abs()) / 2.0;
            let mid = Point::new(x + w / 2.0, y + h / 2.0);
            Gradient::new_linear((mid.x - dx * half, mid.y - dy * half), (mid.x + dx * half, mid.y + dy * half))
        }
    };
    g.with_stops(stops.as_slice()).with_extend(Extend::Pad)
}

thread_local! {
    static DONE: std::cell::RefCell<Vec<(u32, f64)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// An error on the worker's console.
pub(crate) fn log(msg: &str) {
    let console = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("console")).ok();
    let error = console.as_ref().and_then(|c| js_sys::Reflect::get(c, &JsValue::from_str("error")).ok());
    if let (Some(c), Some(f)) = (console, error.and_then(|f| f.dyn_into::<js_sys::Function>().ok())) {
        let _ = f.call1(&c, &JsValue::from_str(msg));
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

/// performance.now() in this worker.
pub(crate) fn now() -> f64 { performance_now() }

/// The GPU side: a WebGPU device drawing into an OffscreenCanvas.
#[wasm_bindgen]
pub struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    renderer: Renderer,
    /// The frame, kept: a full render writes it, a partial one copies its region into it,
    /// and every present shows it.
    target: wgpu::Texture,
    view: wgpu::TextureView,
    /// Where a partial render is made, at its own size from the corner, before the copy.
    scratch: wgpu::Texture,
    scratch_view: wgpu::TextureView,
    blitter: wgpu::util::TextureBlitter,
    /// Layers (layers.rs): the passes, made on first use; textures by size; and each
    /// layer's kept result, registered with the renderer as an image.
    passes: Option<layers::Passes>,
    pool: layers::Pool,
    /// The frame's shared backdrop (Engine::snapshot): texture, its device origin, its scale.
    snap: Option<(wgpu::Texture, f64, f64, f64)>,
    /// The frame being composed (compose.rs): its region of the kept frame, its base colour,
    /// how many Vello passes it has had.
    quads: Option<compose::Quads>,
    region: (u32, u32, u32, u32),
    base: Color,
    passes_done: u32,
    /// Scrollers' tiles, by id: plain textures, outside Vello's image atlas.
    tiles: HashMap<u32, wgpu::Texture>,
    /// What lies under and over a scrolling layer, kept for the frames that only scroll it.
    caches: HashMap<u32, wgpu::Texture>,
    /// The next pass is also kept as cache `keep_next`.
    keep_next: Option<u32>,

    kept: HashMap<u32, (wgpu::Texture, vello::peniko::ImageData)>,
    /// Images copied on the GPU from their bitmaps (decoded images, videos' frames), by handle.
    bitmaps: HashMap<u32, (wgpu::Texture, vello::peniko::ImageData)>,
    /// The quads (paint.rs), made on first use.
    painter: Option<paint::Painter>,
    /// Large drawings' rasters, each a texture of its own, by drawing (paint.rs Sprites::big).
    big: HashMap<u32, wgpu::Texture>,
    /// Opacity groups' textures kept, by view (paint.rs KeptGroup).
    groups: HashMap<u32, wgpu::Texture>,
    /// Each frame's GPU time (timing.rs), when the adapter has timestamp queries.
    timer: Option<timing::Timer>,
    /// The frame's encoder (take_enc, flush).
    enc: Option<wgpu::CommandEncoder>,
    /// The quads draw (Engine::quads): passes are theirs, and tiles are premultiplied.
    quads_on: bool,
}

fn target(device: &wgpu::Device, w: u32, h: u32) -> (wgpu::Texture, wgpu::TextureView) {
    let t = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("declare target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let v = t.create_view(&wgpu::TextureViewDescriptor::default());
    (t, v)
}

impl Gpu {
    /// The frame's commands are recorded into one encoder, submitted when the frame is
    /// presented, or before Vello renders (which submits its own work), so they run in order.
    fn take_enc(&mut self) -> wgpu::CommandEncoder {
        if let Some(e) = self.enc.take() { return e; }
        let mut e = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        if let Some(s) = self.stages() { s.write(&mut e, "gap"); }
        e
    }
    /// The stage stamps (timing.rs), when stages are timed.
    pub(crate) fn stages(&self) -> Option<std::rc::Rc<timing::Stamps>> {
        self.timer.as_ref().filter(|t| t.stamps.detail.get()).map(|t| t.stamps.clone())
    }
    /// Stamp the end of the work `label` recorded since the last stamp.
    pub(crate) fn mark(&mut self, label: &'static str) {
        let Some(s) = self.stages() else { return };
        let mut enc = self.take_enc();
        s.write(&mut enc, label);
        self.enc = Some(enc);
    }
    /// The name the next Vello render's span is stamped with.
    pub(crate) fn vello_as(&self, label: &'static str) {
        if let Some(t) = self.timer.as_ref() { t.stamps.vello.set(label); }
    }
    pub(crate) fn flush(&mut self) {
        // what was bound so far is submitted with it: the slots can be written again (an
        // encoder held elsewhere meanwhile — the painter's, mid-plan — is not, nor are its slots)
        if let Some(e) = self.enc.take() {
            self.queue.submit([e.finish()]);
            if let Some(p) = self.painter.as_ref() { p.submitted(); }
        }
    }

    fn resize(&mut self, w: u32, h: u32) {
        if self.config.width == w && self.config.height == h {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
        let (t, v) = target(&self.device, w, h);
        self.target = t;
        self.view = v;
        let (t, v) = target(&self.device, w, h);
        self.scratch = t;
        self.scratch_view = v;
    }

    /// Render the scene into the region (x, y, w, h) of the kept frame — the scene encoded
    /// with that region's corner at the origin — and present the frame.
    #[allow(clippy::too_many_arguments)]
    fn render_region(&mut self, scene: &Scene, base: Color, x: u32, y: u32, w: u32, h: u32) -> Result<(), JsValue> {
        self.flush();
        self.vello_as("vello frame");
        self.renderer
            .render_to_texture(&self.device, &self.queue, scene, &self.scratch_view,
                &RenderParams { base_color: base, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("render: {e}")))?;
        let mut enc = self.take_enc();
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.scratch, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &self.target, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        self.enc = Some(enc);
        self.mark("pass copy");
        self.present()
    }

    fn layer(&mut self, id: u32, scene: &Scene, w: u32, h: u32, passes: &[f64]) -> Result<(), JsValue> {
        if self.passes.is_none() { self.passes = Some(layers::Passes::new(&self.device)); }
        let tex = self.pool.take(&self.device, w, h);
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        self.flush();
        self.vello_as("vello layer");
        self.renderer
            .render_to_texture(&self.device, &self.queue, scene, &view,
                &RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("layer: {e}")))?;
        self.keep(id, tex, passes);
        Ok(())
    }

    /// Run `passes` over `tex` and keep the result as layer `id`'s image.
    /// Layer `id`'s kept texture, w×h, registered for Vello: the one it has while its size
    /// holds (policy: a new size is a new texture, rendered exactly).
    fn ensure_kept(&mut self, id: u32, w: u32, h: u32) {
        if self.kept.get(&id).is_some_and(|(t, _)| t.width() == w && t.height() == h) { return; }
        if let Some((t, img)) = self.kept.remove(&id) { self.renderer.unregister_texture(img); self.pool.retire(t); }
        let t = layers::layer_texture(&self.device, w, h);
        let img = self.renderer.register_texture(t.clone());
        self.kept.insert(id, (t, img));
    }

    fn keep(&mut self, id: u32, tex: wgpu::Texture, passes: &[f64]) {
        if self.passes.is_none() { self.passes = Some(layers::Passes::new(&self.device)); }
        let mut enc = self.take_enc();
        let out = layers::run_passes(&self.device, &mut enc, self.passes.as_ref().unwrap(), &mut self.pool, tex, passes);
        self.ensure_kept(id, out.width(), out.height());
        let (t, img) = self.kept.get(&id).unwrap();
        enc.copy_texture_to_texture(out.as_image_copy(), t.as_image_copy(), out.size());
        self.enc = Some(enc);
        self.renderer.mark_override_image_dirty(img);
        self.pool.give(out);
        self.mark("layer filters");
    }

    /// Render `scene` as the frame's shared backdrop: (w, h) texels standing for the device
    /// rect from (ox, oy) at `scale` texels a pixel.
    fn snapshot(&mut self, scene: &Scene, w: u32, h: u32, ox: f64, oy: f64, scale: f64) -> Result<(), JsValue> {
        let tex = self.pool.take(&self.device, w, h);
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        self.flush();
        self.vello_as("vello snapshot");
        self.renderer
            .render_to_texture(&self.device, &self.queue, scene, &view,
                &RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("snapshot: {e}")))?;
        if let Some((old, ..)) = self.snap.replace((tex, ox, oy, scale)) { self.pool.give(old); }
        Ok(())
    }

    /// Layer `id` from the device rect (x, y, w, h) of the snapshot, through `passes`.
    fn layer_from_snapshot(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64, passes: &[f64]) -> bool {
        let Some((snap, ox, oy, k)) = self.snap.clone() else { return false };
        let snap = &snap;
        let (sw, sh) = (snap.width() as i64, snap.height() as i64);
        let x0 = (((x - ox) * k).floor() as i64).clamp(0, sw - 1);
        let y0 = (((y - oy) * k).floor() as i64).clamp(0, sh - 1);
        let x1 = (((x + w - ox) * k).ceil() as i64).clamp(x0 + 1, sw);
        let y1 = (((y + h - oy) * k).ceil() as i64).clamp(y0 + 1, sh);
        let (tw, th) = ((x1 - x0) as u32, (y1 - y0) as u32);
        let tex = self.pool.take(&self.device, tw, th);
        let mut enc = self.take_enc();
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: snap, mip_level: 0, origin: wgpu::Origin3d { x: x0 as u32, y: y0 as u32, z: 0 }, aspect: wgpu::TextureAspect::All },
            tex.as_image_copy(), wgpu::Extent3d { width: tw, height: th, depth_or_array_layers: 1 });
        self.enc = Some(enc);
        self.keep(id, tex, passes);
        true
    }

    // ── the frame, composed (compose.rs) ───────────────────────────────────────────

    fn frame_start(&mut self, x: u32, y: u32, w: u32, h: u32, base: Color) {
        let (tw, th) = (self.config.width, self.config.height);
        let x = x.min(tw.saturating_sub(1)); let y = y.min(th.saturating_sub(1));
        self.region = (x, y, w.max(1).min(tw - x), h.max(1).min(th - y));
        self.base = base;
        self.passes_done = 0;
        if self.quads.is_none() { self.quads = Some(compose::Quads::new(&self.device)); }
    }

    /// A Vello pass of the frame: the scene (encoded with the region's corner at the origin)
    /// over the region — the first over the base colour, replacing what was there; the rest
    /// laid over it.
    fn frame_pass(&mut self, scene: &Scene) -> Result<(), JsValue> {
        let (x, y, w, h) = self.region;
        let first = self.passes_done == 0;
        self.passes_done += 1;
        let whole = x == 0 && y == 0 && w == self.config.width && h == self.config.height;
        if first && whole {
            self.flush();
            self.vello_as("vello frame");
            return self.renderer.render_to_texture(&self.device, &self.queue, scene, &self.view,
                &RenderParams { base_color: self.base, width: w, height: h, antialiasing_method: AaConfig::Area })
                .map_err(|e| JsValue::from_str(&format!("render: {e}")));
        }
        self.flush();
        self.vello_as("vello frame");
        self.renderer
            .render_to_texture(&self.device, &self.queue, scene, &self.scratch_view,
                &RenderParams { base_color: if first { self.base } else { Color::TRANSPARENT }, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("render: {e}")))?;
        let mut enc = self.take_enc();
        if first {
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.scratch, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &self.target, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        } else {
            if let Some(id) = self.keep_next.take() {
                let fresh = self.caches.get(&id).is_none_or(|t| t.width() != w || t.height() != h);
                if fresh { if let Some(old) = self.caches.insert(id, layers::layer_texture(&self.device, w, h)) { self.pool.retire(old); } }
                enc.copy_texture_to_texture(self.scratch.as_image_copy(), self.caches[&id].as_image_copy(),
                    wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
            }
            self.quads.as_ref().unwrap().draw(&self.device, &mut enc, &self.target, &self.scratch,
                [0.0, 0.0, w as f32, h as f32], [x as f32, y as f32, (x + w) as f32, (y + h) as f32], [x, y, x + w, y + h], true);
        }
        self.enc = Some(enc);
        self.mark("pass copy");
        Ok(())
    }

    /// Keep the frame's region as it stands as cache `id` (what lies under a layer).
    fn frame_keep(&mut self, id: u32) {
        let (x, y, w, h) = self.region;
        let fresh = self.caches.get(&id).is_none_or(|t| t.width() != w || t.height() != h);
        if fresh { if let Some(old) = self.caches.insert(id, layers::layer_texture(&self.device, w, h)) { self.pool.retire(old); } }
        let mut enc = self.take_enc();
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.target, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            self.caches[&id].as_image_copy(), wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        self.enc = Some(enc);
        self.mark("cache copy");
    }

    /// Lay cache `id` over the region (`over`), or put it there (the first thing in a frame).
    fn frame_blit(&mut self, id: u32, over: bool) -> bool {
        let Some(t) = self.caches.get(&id).cloned() else { return false };
        let t = &t;
        let (x, y, w, h) = self.region;
        if t.width() != w || t.height() != h { return false; }
        let mut enc = self.take_enc();
        if over {
            self.quads.as_ref().unwrap().draw(&self.device, &mut enc, &self.target, t,
                [0.0, 0.0, w as f32, h as f32], [x as f32, y as f32, (x + w) as f32, (y + h) as f32], [x, y, x + w, y + h], true);
        } else {
            enc.copy_texture_to_texture(t.as_image_copy(),
                wgpu::TexelCopyTextureInfo { texture: &self.target, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
            self.passes_done += 1;
        }
        self.enc = Some(enc);
        self.mark("cache copy");
        true
    }

    /// Tile `id` over the device rect, inside the clip (and the region).
    #[allow(clippy::too_many_arguments)]
    fn frame_tile(&mut self, id: u32, dx: f32, dy: f32, dw: f32, dh: f32, clip: [f32; 4]) {
        let Some(t) = self.tiles.get(&id).cloned() else { return };
        let t = &t;
        let (x, y, w, h) = self.region;
        let sc = [clip[0].max(x as f32).floor() as u32, clip[1].max(y as f32).floor() as u32,
                  clip[2].min((x + w) as f32).ceil() as u32, clip[3].min((y + h) as f32).ceil() as u32];
        let mut enc = self.take_enc();
        let q = self.quads.as_ref().unwrap();
        let (src, dst) = ([0.0, 0.0, t.width() as f32, t.height() as f32], [dx, dy, dx + dw, dy + dh]);
        if self.quads_on { q.draw_premul(&self.device, &mut enc, &self.target, t, src, dst, sc); } else { q.draw(&self.device, &mut enc, &self.target, t, src, dst, sc, true); }
        self.enc = Some(enc);
        self.mark("tiles");
    }

    /// The frame as it stands, over the device rect, read back at `scale` texels a pixel as
    /// the shared backdrop (layer_from_snapshot): halved 2×2 a step at a time, then to size.
    fn frame_snapshot(&mut self, x: u32, y: u32, w: u32, h: u32, scale: f64) {
        let k = scale.clamp(1.0 / 64.0, 1.0);
        let mut enc = self.take_enc();
        let quads = self.quads.as_ref().unwrap();
        let mut src: Option<wgpu::Texture> = None;
        let mut rect = [x as f32, y as f32, (x + w) as f32, (y + h) as f32];
        let (mut cw, mut ch) = (w as f64, h as f64);
        let mut spent: Vec<wgpu::Texture> = Vec::new();
        // halve while a half is still no smaller than the size wanted
        while cw / 2.0 >= (w as f64) * k && cw >= 2.0 && ch >= 2.0 {
            let (nw, nh) = ((cw / 2.0).ceil() as u32, (ch / 2.0).ceil() as u32);
            let t = self.pool.take(&self.device, nw, nh);
            quads.draw(&self.device, &mut enc, &t, src.as_ref().unwrap_or(&self.target), rect, [0.0, 0.0, nw as f32, nh as f32], [0, 0, nw, nh], false);
            if let Some(old) = src.replace(t) { spent.push(old); }
            rect = [0.0, 0.0, nw as f32, nh as f32];
            cw = nw as f64; ch = nh as f64;
        }
        let (fw, fh) = ((((w as f64) * k).ceil() as u32).max(1), (((h as f64) * k).ceil() as u32).max(1));
        let t = self.pool.take(&self.device, fw, fh);
        quads.draw(&self.device, &mut enc, &t, src.as_ref().unwrap_or(&self.target), rect, [0.0, 0.0, fw as f32, fh as f32], [0, 0, fw, fh], false);
        if let Some(old) = src { spent.push(old); }
        self.enc = Some(enc);
        for s in spent { self.pool.give(s); }
        if let Some((old, ..)) = self.snap.replace((t, x as f64, y as f64, k)) { self.pool.give(old); }
        self.mark("frame snapshot");
    }

    /// Render a scroller's tile into its own texture (transparent where nothing is drawn).
    /// Tile `id`'s texture, made anew when its size changes.
    fn tile_texture(&mut self, id: u32, w: u32, h: u32) -> wgpu::Texture {
        let fresh = self.tiles.get(&id).is_none_or(|t| t.width() != w || t.height() != h);
        if fresh { if let Some(old) = self.tiles.insert(id, layers::layer_texture(&self.device, w, h)) { self.pool.retire(old); } }
        self.tiles[&id].clone()
    }

    fn tile(&mut self, id: u32, scene: &Scene, w: u32, h: u32) -> Result<(), JsValue> {
        self.tile_texture(id, w, h);
        let view = self.tiles[&id].create_view(&Default::default());
        self.flush();
        self.vello_as("vello tile");
        self.renderer.render_to_texture(&self.device, &self.queue, scene, &view,
            &RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("tile: {e}")))
    }

    fn tile_patch(&mut self, id: u32, scene: &Scene, x: u32, y: u32, w: u32, h: u32) -> Result<bool, JsValue> {
        let Some(t) = self.tiles.get(&id) else { return Ok(false) };
        if w == 0 || h == 0 || w > self.scratch.width() || h > self.scratch.height() || x + w > t.width() || y + h > t.height() { return Ok(false); }
        self.flush();
        self.vello_as("vello tile");
        self.renderer.render_to_texture(&self.device, &self.queue, scene, &self.scratch_view,
            &RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("tile: {e}")))?;
        let mut enc = self.take_enc();
        enc.copy_texture_to_texture(self.scratch.as_image_copy(),
            wgpu::TexelCopyTextureInfo { texture: &self.tiles[&id], mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        self.enc = Some(enc);
        self.mark("pass copy");
        Ok(true)
    }

    fn present(&mut self) -> Result<(), JsValue> {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            other => return Err(JsValue::from_str(&format!("surface: {other:?}"))),
        };
        let fv = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = self.take_enc();
        self.blitter.copy(&self.device, &mut enc, &self.view, &fv);
        self.enc = Some(enc);
        self.mark("present copy");
        self.flush();
        self.queue.present(frame);
        self.pool.reap();
        Ok(())
    }

    fn render(&mut self, scene: &Scene, base: Color) -> Result<(), JsValue> {
        let (w, h) = (self.config.width, self.config.height);
        self.flush();
        self.vello_as("vello frame");
        self.renderer
            .render_to_texture(&self.device, &self.queue, scene, &self.view,
                &RenderParams { base_color: base, width: w, height: h, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("render: {e}")))?;
        self.present()
    }
}

/// Make the GPU for an OffscreenCanvas of `width` × `height` device pixels.
#[wasm_bindgen]
pub async fn create_gpu(canvas: web_sys::OffscreenCanvas, width: u32, height: u32) -> Result<Gpu, JsValue> {
    let err = |e: &dyn std::fmt::Display| JsValue::from_str(&e.to_string());
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let surface = instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas)).map_err(|e| err(&e))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { compatible_surface: Some(&surface), ..Default::default() })
        .await.map_err(|e| err(&e))?;
    let stamps = adapter.features().contains(wgpu::Features::TIMESTAMP_QUERY);
    let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
        required_features: if stamps { wgpu::Features::TIMESTAMP_QUERY } else { wgpu::Features::empty() },
        ..Default::default()
    }).await.map_err(|e| err(&e))?;
    let timer = stamps.then(|| timing::Timer::new(&device, &queue));
    let caps = surface.get_capabilities(&adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, width: width.max(1), height: height.max(1),
        present_mode: wgpu::PresentMode::Fifo, desired_maximum_frame_latency: 2,
        alpha_mode: wgpu::CompositeAlphaMode::Opaque, view_formats: vec![], color_space: Default::default(),
    };
    surface.configure(&device, &config);
    let renderer = Renderer::new(&device, RendererOptions {
        use_cpu: false, antialiasing_support: AaSupport::area_only(), num_init_threads: None, pipeline_cache: None,
    }).map_err(|e| err(&e))?;
    let (t, v) = target(&device, config.width, config.height);
    let (st, sv) = target(&device, config.width, config.height);
    let blitter = wgpu::util::TextureBlitter::new(&device, format);
    Ok(Gpu { device, queue, surface, config, renderer, target: t, view: v, scratch: st, scratch_view: sv, blitter,
             passes: None, pool: layers::Pool::default(), snap: None,
             quads: None, region: (0, 0, 1, 1), base: Color::WHITE, passes_done: 0, tiles: HashMap::new(), caches: HashMap::new(), keep_next: None, kept: HashMap::new(), bitmaps: HashMap::new(), painter: None, big: HashMap::new(), groups: HashMap::new(), timer, quads_on: false, enc: None })
}
