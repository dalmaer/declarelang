//! The paint walk: a node and its subtree into the frame's commands (the engine's `run`
//! format, lib.rs), with what one scene cannot do made in layers of their own — a filtered
//! subtree, frost, a view out of its plane, a text shadow.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use super::geom::*;
use super::ct;
use super::{Host, Mask};
use crate::Engine;
use crate::paint::whole_px;

/// Where an aspect-kept image sits in the leftover space, by alignX/alignY.
fn fit_frac(s: &str) -> f64 { match s { "start" => 0.0, "end" => 1.0, _ => 0.5 } }

/// A frame's drawing commands: numbers in a buffer that grows, so a frame crosses into the
/// engine once instead of once per box and line.
#[derive(Default)]
pub(crate) struct Commands {
    a: Vec<f64>,
    /// Groups opened and not yet closed (layer 4, shape clip 12, blend 13): what a frost's
    /// prefix must close before it can be rendered on its own.
    depth: usize,
    /// Where each open group's command starts, and how long it is.
    open: Vec<(usize, usize)>,
}
impl Commands {
    pub(crate) fn view(&self) -> &[f64] { &self.a }
    pub(crate) fn op(&mut self, code: u32, m: &M) {
        if code == 4 || code == 12 || code == 13 { self.depth += 1; self.open.push((self.a.len(), if code == 4 { 16 } else { 8 })); }
        self.a.push(code as f64);
        self.a.extend_from_slice(m);
    }
    pub(crate) fn pop(&mut self) { self.a.push(5.0); self.depth = self.depth.saturating_sub(1); self.open.pop(); }
    pub(crate) fn size(&self) -> usize { self.a.len() }
    /// A new buffer that opens the groups open here, as this one had them: the frame goes on
    /// in a new pass inside the same clips.
    pub(crate) fn reopened(&self) -> Commands {
        let mut c = Commands::default();
        for &(at, len) in &self.open { c.open.push((c.a.len(), len)); c.depth += 1; c.a.extend_from_slice(&self.a[at..at + len]); }
        c
    }
    /// The commands so far, with every open group closed.
    pub(crate) fn prefix(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.a.len() + self.depth);
        out.extend_from_slice(&self.a);
        out.resize(self.a.len() + self.depth, 5.0);
        out
    }
    pub(crate) fn num(&mut self, v: f64) { self.a.push(v); }
    pub(crate) fn n4(&mut self, a: f64, b: f64, c: f64, d: f64) { self.a.extend_from_slice(&[a, b, c, d]); }
    pub(crate) fn n5(&mut self, a: f64, b: f64, c: f64, d: f64, e: f64) { self.a.extend_from_slice(&[a, b, c, d, e]); }
    pub(crate) fn n7(&mut self, a: f64, b: f64, c: f64, d: f64, e: f64, f: f64, g: f64) { self.a.extend_from_slice(&[a, b, c, d, e, f, g]); }
    pub(crate) fn list(&mut self, v: &[f64]) { self.a.extend_from_slice(v); }
    pub(crate) fn set(&mut self, i: usize, v: f64) { self.a[i] = v; }
    pub(crate) fn slice(&self, from: usize) -> &[f64] { &self.a[from..] }
}

/// A subtree's walk kept between frames: what it wrote (commands, its marks for the painter's
/// kept plan included), the rects it drew (for the frame's shared backdrop) and what it counted,
/// and what it was written under — the subtree's generation, the node's transform, the clip,
/// whether pixelated, the engine's text generation. The same again, or under a clip inside the
/// one it was written under (what it holds past the clip, the frame's region cuts), it is
/// written as kept.
pub(crate) struct KeptWalk { stands: u64, m: M, clip: Rect, pixelated: bool, text_gen: u32, reach: Option<Rect>, cmds: Vec<f64>, drew: Vec<Rect>, counts: [f64; 4],
    /// The painter can keep what it draws (no layer, no video frame: paint.rs bakeable), so it
    /// can be a moving layer.
    bakeable: bool }

impl KeptWalk {
    /// Nothing was culled when it was written: it holds all its subtree draws, under any clip.
    fn whole(&self) -> bool { self.counts[2] == 0.0 && self.counts[3] == 0.0 }
    /// The same walk with its subtree moved by (dx, dy) device pixels: every command's
    /// transform, and the rects it drew.
    fn moved(&mut self, dx: f64, dy: f64) {
        let c = &mut self.cmds;
        let mut i = 0;
        while i < c.len() {
            let code = c[i] as u32;
            i += 1;
            if code == 5 { continue; }
            let n = crate::paint::arg_len(code, c, i + 6);
            if n == usize::MAX || i + 6 + n > c.len() { break; }
            c[i + 4] += dx; c[i + 5] += dy;
            i += 6 + n;
        }
        self.m[4] += dx; self.m[5] += dy;
        for r in self.drew.iter_mut() { *r = shifted(r, dx, dy); }
        self.reach = self.reach.map(|r| shifted(&r, dx, dy));
    }
}

fn shifted(r: &Rect, dx: f64, dy: f64) -> Rect { Rect { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy } }

/// A subtree's walk being recorded: the rects it drew, and whether it did something a kept
/// walk cannot repeat (a pass cut, a layer made, a scroller's bar, a frost, a mask).
pub(crate) struct WalkRec { drew: Vec<Rect>, impure: bool }

/// A subtree kept needs children enough to be worth it.
const KEEP_KIDS: usize = 2;
/// A moving subtree is laid as a layer when it holds this many views.
const LAYER_VIEWS: f64 = 8.0;
/// A moving layer's key among the painter's kept groups (a view's own opacity group is its id).
const MOTION_KEY: u32 = 0x8000_0000;

fn grown(r: &Rect, d: f64) -> Rect { Rect { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d } }
fn whole(r: &Rect) -> Rect { Rect { x0: r.x0.floor(), y0: r.y0.floor(), x1: r.x1.ceil(), y1: r.y1.ceil() } }

impl Host {
    /// End the frame's current Vello pass here: what is written so far goes onto the frame,
    /// and what follows starts a new pass inside the same open clips.
    pub(crate) fn cut(&mut self, e: &mut Engine) {
        for r in self.walk_rec.iter_mut() { r.impure = true; }
        if self.above_for.is_some() { self.cuts_after += 1; }
        if self.cmd.size() > 0 || self.passes == 0 {
            if let Err(err) = e.frame_pass(&self.cmd.prefix()) { crate::log(&format!("[gpu] render: {err:?}")); }
        }
        self.passes += 1;
        self.cmd = self.cmd.reopened();
        self.in_frame_cmd = true;
    }
    /// What lands on the frame since its shared backdrop was taken.
    pub(crate) fn drew(&mut self, r: Rect) {
        for w in self.walk_rec.iter_mut() { w.drew.push(r); }
        if r.x1 <= r.x0 || r.y1 <= r.y0 || self.snap.is_none() || !self.in_frame_cmd { return; }
        let list = &mut self.since_snap;
        for q in list.iter() { if r.x0 >= q.x0 && r.y0 >= q.y0 && r.x1 <= q.x1 && r.y1 <= q.y1 { return; } }
        if list.len() < 256 { list.push(r); }
        else { let l = list.len() - 1; list[l] = union(&list[l], &r); }
    }
    /// Swap in a fresh command buffer (a layer's, a tile's), keeping the frame's.
    fn sub_begin(&mut self) -> (Commands, bool) {
        let main = std::mem::take(&mut self.cmd);
        let was = std::mem::replace(&mut self.in_frame_cmd, false);
        (main, was)
    }
    fn sub_end(&mut self, saved: (Commands, bool)) -> Commands {
        self.in_frame_cmd = saved.1;
        std::mem::replace(&mut self.cmd, saved.0)
    }
    pub(crate) fn sub_paint(&mut self, e: &mut Engine, kids: &[u32], m: &M, area: &Rect, pixelated: bool) -> Commands {
        let saved = self.sub_begin();
        self.in_layer_tile += 1;
        for &c in kids { self.paint(e, c, m, area, pixelated, false); }
        self.in_layer_tile -= 1;
        self.sub_end(saved)
    }

    /// Paint `id` and its subtree under `parent`, inside `clip` — the device rectangle that can
    /// still show (the window, narrowed by every clipping ancestor). CULLING: a view's own
    /// content is skipped when its bounds (its box, grown by its shadow, its drawing and any
    /// text that runs past it) miss the clip; its whole subtree only when it clips its children
    /// and its box misses — a view that does not clip can have children anywhere.
    pub(crate) fn paint(&mut self, e: &mut Engine, id: u32, parent: &M, clip: &Rect, pixelated: bool, stencil: bool) {
        // a subtree's walk is kept, in the frame's own commands, while nothing in it changes
        let n = self.nodes.get(&id).unwrap();
        let impure = n.scrolls || n.scrolls_x || n.backdrop.is_some() || n.filters.is_some() || n.three || n.mask.is_some();
        if impure { for r in self.walk_rec.iter_mut() { r.impure = true; } }
        let candidate = self.keep && !stencil && !impure && n.visible && n.opacity > 0.0 && n.children.len() >= KEEP_KIDS
            && self.in_frame_cmd && self.in_layer.is_none() && self.in_flat.is_none() && self.in_layer_tile == 0;
        if !candidate { self.paint_node(e, id, parent, clip, pixelated, stencil); return; }
        let m = mul(parent, &self.local(id));
        let text_gen = e.generation();
        let stands = n.sub_gen;
        let mut moved = false;
        // moved only (the same but for a translation, nothing culled when written): laid again
        // moved, and its subtree's painted rects with it
        if let Some(k) = n.kept.as_ref().filter(|k| k.stands == stands && k.m != m && k.m[..4] == m[..4] && k.whole() && k.pixelated == pixelated && k.text_gen == text_gen) {
            let (dx, dy) = (m[4] - k.m[4], m[5] - k.m[5]);
            let mut k = self.nm(id).kept.take().unwrap();
            k.moved(dx, dy);
            k.clip = *clip;
            self.shift_painted(id, dx, dy, true);
            self.nm(id).kept = Some(k);
            self.counts[ct::WALK_MOVED] += 1.0;
            moved = true;
        }
        let moving = if moved { self.nd(id).moving + 1 } else { 0 };
        self.nm(id).moving = moving;
        let n = self.nodes.get(&id).unwrap();
        if let Some(k) = n.kept.as_ref().filter(|k| k.stands == stands && k.m == m && covers(&k.clip, clip) && k.pixelated == pixelated && k.text_gen == text_gen) {
            // all it draws is outside the clip: nothing to write
            if k.reach.is_none_or(|r| !meets(&r, clip)) { self.count(ct::CULLED_SUBTREE); self.counts[ct::WALK_HITS] += 1.0; return; }
            let (drew, counts, bakeable, reach) = (k.drew.clone(), k.counts, k.bakeable, k.reach);
            // moving for a second frame and large enough: a layer, laid from the texture its
            // first frame made (paint.rs KeptGroup), drawn exactly again once it rests
            let layer = moving >= 2 && counts[0] >= LAYER_VIEWS && self.flags.layers && bakeable && reach.is_some();
            if layer {
                let r = reach.unwrap();
                self.cmd.op(19, &I); self.cmd.num((id | MOTION_KEY) as f64); self.cmd.num(stands as f64); self.cmd.n4(r.x0, r.y0, r.x1, r.y1);
                self.cmd.op(4, &m); self.cmd.n5(1.0, 0.0, 0.0, -1.0, 0.0); self.cmd.n4(0.0, 0.0, 0.0, 0.0);
                self.soft.push(id);
                // laid sampled this frame: no walk around it is kept, so the next draws it exactly
                for r in self.walk_rec.iter_mut() { r.impure = true; }
            }
            self.cmd.list(&self.nodes.get(&id).unwrap().kept.as_ref().unwrap().cmds);
            if layer { self.cmd.pop(); self.counts[ct::MOTION_LAYERS] += 1.0; }
            for r in drew { self.drew(r); }
            for (i, c) in [ct::VISITED, ct::DRAWN, ct::CULLED_OWN, ct::CULLED_SUBTREE].into_iter().zip(counts) { self.counts[i] += c; }
            self.counts[ct::WALK_HITS] += 1.0;
            self.counts[ct::WALK_HIT_VIEWS] += counts[0];
            return;
        }
        // recorded: between the painter's marks (17 key generation length … 18)
        let c0 = [ct::VISITED, ct::DRAWN, ct::CULLED_OWN, ct::CULLED_SUBTREE].map(|i| self.counts[i]);
        let start = self.cmd.size();
        let passes = self.passes;
        self.cmd.op(17, &m); self.cmd.num(id as f64); self.cmd.num(stands as f64); self.cmd.num(0.0);
        self.walk_rec.push(WalkRec { drew: Vec::new(), impure: false });
        self.paint_node(e, id, parent, clip, pixelated, stencil);
        self.cmd.op(18, &I);
        let r = self.walk_rec.pop().unwrap();
        if r.impure { for o in self.walk_rec.iter_mut() { o.impure = true; } }
        // the marks span the subtree's commands (the painter skips them when it replays), unless
        // a pass was cut inside, which leaves the mark in a pass already drawn
        if self.passes != passes { self.nm(id).kept = None; return; }
        let len = self.cmd.size() - (start + 10);
        self.cmd.set(start + 9, len as f64);
        if r.impure { self.nm(id).kept = None; return; }
        let counts = [ct::VISITED, ct::DRAWN, ct::CULLED_OWN, ct::CULLED_SUBTREE].map(|i| self.counts[i]);
        let k = KeptWalk { stands, m, clip: *clip, pixelated, text_gen, reach: self.nd(id).painted, cmds: self.cmd.slice(start).to_vec(), drew: r.drew,
            counts: [counts[0] - c0[0], counts[1] - c0[1], counts[2] - c0[2], counts[3] - c0[3]], bakeable: false };
        let mut k = k;
        k.bakeable = crate::paint::bakeable(&k.cmds);
        self.nm(id).kept = Some(Box::new(k));
        self.counts[ct::WALK_KEPT] += 1.0;
    }

    /// A subtree laid again moved: its painted rects move with it, and the walks kept inside
    /// it (written where it was) go.
    fn shift_painted(&mut self, id: u32, dx: f64, dy: f64, top: bool) {
        let n = self.nm(id);
        n.painted = n.painted.map(|r| shifted(&r, dx, dy));
        if !top { n.kept = None; }
        let kids = std::mem::take(&mut self.nm(id).children);
        for &c in &kids { if self.nodes.contains_key(&c) { self.shift_painted(c, dx, dy, false); } }
        self.nm(id).children = kids;
    }

    fn paint_node(&mut self, e: &mut Engine, id: u32, parent: &M, clip: &Rect, pixelated: bool, stencil: bool) {
        let cull = self.flags.cull;
        {
            let n = self.nd(id);
            if (!n.visible && !stencil) || n.opacity <= 0.0 { self.nm(id).painted = None; return; }
        }
        self.count(ct::VISITED);
        let pixelated = pixelated || self.nd(id).pixelated;
        if self.nd(id).three && Some(id) != self.in_flat { self.paint_3d(e, id, parent, clip, pixelated); return; }
        if self.nd(id).filters.is_some() && Some(id) != self.in_layer && Some(id) != self.in_flat { self.paint_filtered(e, id, parent, clip, pixelated); return; }
        let m = mul(parent, &self.local(id));
        let (nw, nh) = (self.nd(id).w, self.nd(id).h);
        let bx = aabb(&m, 0.0, 0.0, nw, nh);
        let clips = self.clips_kids(id);
        if cull && clips && !meets(&bx, clip) { self.count(ct::CULLED_SUBTREE); self.nm(id).painted = Some(bx); return; }
        let [r0, r1, r2, r3] = self.nd(id).r4();
        let (opacity, blend, shaped) = (self.nd(id).opacity, self.nd(id).blend, self.nd(id).shaped);
        let layered = opacity < 1.0;
        let own_b = self.own_bounds(id, &m, &bx);
        let own = !cull || meets(&own_b, clip);
        if !own { self.count(ct::CULLED_OWN); }
        // the view as a group: blended onto what is beneath, masked, clipped to its shape
        let masked = self.nd(id).mask.is_some();
        if blend != 0.0 { self.cmd.op(13, &m); self.cmd.num(blend); }
        if masked { self.cmd.op(13, &m); self.cmd.num(0.0); }
        if shaped { self.cmd.op(12, &m); self.cmd.num(id as f64); }
        if own && self.nd(id).backdrop.is_some() && !self.flags.nofrost { self.paint_backdrop(e, id, &m, clip); }
        if own {
            let n = self.nd(id);
            if let (Some((dx, dy, blur, c)), true) = (n.shadow, n.fill.is_some() || n.gradient.is_some()) {
                self.cmd.op(3, &m); self.cmd.n7(dx, dy, nw, nh, jmax(jmax(r0, r1), jmax(r2, r3)), blur, c as f64);
            }
        }
        if layered {
            // the group's view and what it draws stands for (its own generation and its
            // children's), so the painter can keep what it drew
            let n = self.nd(id);
            let mut g = n.own_gen ^ (n.children.len() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
            for &k in &n.children { g = g.wrapping_mul(0x100_0000_01b3) ^ self.nd(k).sub_gen; }
            let g = (g & ((1 << 52) - 1)) as f64;
            self.cmd.op(19, &I); self.cmd.num(id as f64); self.cmd.num(g); self.cmd.n4(0.0, 0.0, 0.0, 0.0);
            self.cmd.op(4, &m); self.cmd.n5(opacity, 0.0, 0.0, -1.0, 0.0); self.cmd.n4(0.0, 0.0, 0.0, 0.0);
        }
        if own {
            self.count(ct::DRAWN);
            // what it paints itself, as far as it can show, lands over any shared backdrop
            let n = self.nd(id);
            let fill = n.fill.filter(|f| f & 255 != 0);
            let paints = n.gradient.is_some() || fill.is_some() || n.image.is_some() || n.picture || n.shows_text()
                || n.sides.is_some() || n.stroke.is_some_and(|(w, c)| w > 0.0 && c & 255 != 0);
            if paints { self.drew(intersect(&own_b, clip)); }
            if let Some(g) = self.nd(id).gradient.clone() {
                self.cmd.op(1, &m); self.cmd.n4(0.0, 0.0, nw, nh); self.cmd.n4(r0, r1, r2, r3); self.cmd.n5(g.kind, g.angle, g.cx, g.cy, g.r);
                self.cmd.num((g.stops.len() / 2) as f64); self.cmd.list(&g.stops);
            } else if let Some(f) = fill {
                self.cmd.op(0, &m); self.cmd.n4(0.0, 0.0, nw, nh); self.cmd.n4(r0, r1, r2, r3); self.cmd.num(f as f64);
            }
        }
        // a view that clips cuts its own image, drawing and text to its rounded box, as its children
        let noclip = self.flags.noclip;
        if clips && !noclip { self.cmd.op(4, &m); self.cmd.n5(1.0, 0.0, 0.0, nw, nh); self.cmd.n4(r0, r1, r2, r3); }
        if own {
            if self.nd(id).image.is_some() { self.paint_image(id, &m, pixelated); }
            if self.nd(id).picture { self.cmd.op(6, &m); self.cmd.num(id as f64); }
            if self.nd(id).shows_text() {
                // a field's text stays inside its box, as the DOM field's does
                let cut = self.nd(id).field != 0 && !(clips && !noclip);
                if cut { self.cmd.op(4, &m); self.cmd.n5(1.0, 0.0, 0.0, nw, nh); self.cmd.n4(0.0, 0.0, 0.0, 0.0); }
                self.paint_text(e, id, &m);
                if cut { self.cmd.pop(); }
            }
        }
        let n = self.nd(id);
        let (sx, sy) = (n.vis_x.unwrap_or(n.scroll_x), n.vis_y.unwrap_or(n.scroll_y));
        let inner = if sx != 0.0 || sy != 0.0 { mul(&m, &translate(-sx, -sy)) } else { m };
        let within = if clips { intersect(clip, &bx) } else { *clip };
        let mut painted = own_b;
        let layer = self.layer_for(e, id, &m);
        if layer {
            self.paint_layer(e, id, &m, &within, pixelated, sx, sy);
            painted = union(&painted, &intersect(&within, &self.view_box(id, &m)));
        }
        let kids = self.stacked(id);
        for &k in &kids {
            let (ks, kc) = (self.nd(k).ignore_scroll, self.nd(k).ignore_clip);
            if layer && !ks && !(kc && clips) { continue; }   // in the tiles
            if kc && clips { continue; }
            self.paint(e, k, if ks { &m } else { &inner }, &within, pixelated, false);
            if let Some(kp) = self.nd(k).painted { painted = union(&painted, &if clips { intersect(&kp, &bx) } else { kp }); }
        }
        if clips {
            if !noclip { self.cmd.pop(); }
            for &k in &kids {
                if !self.nd(k).ignore_clip { continue; }
                let ks = self.nd(k).ignore_scroll;
                self.paint(e, k, if ks { &m } else { &inner }, clip, pixelated, false);
                if let Some(kp) = self.nd(k).painted { painted = union(&painted, &kp); }
            }
        }
        self.nm(id).painted = Some(painted);
        if self.nd(id).scrolls || self.nd(id).scrolls_x { if layer { self.bars.push((id, m, within)); } else { self.paint_bar(id, &m); } }
        if own {
            let n = self.nd(id);
            if let Some((w, c)) = n.stroke.filter(|(w, c)| *w > 0.0 && c & 255 != 0) {
                self.cmd.op(2, &m); self.cmd.n4(0.0, 0.0, nw, nh); self.cmd.n4(r0, r1, r2, r3); self.cmd.num(w); self.cmd.num(c as f64);
            } else if n.sides.is_some() { self.paint_sides(id, &m); }
        }
        if layered { self.cmd.pop(); }
        if shaped { self.cmd.pop(); }
        if let Some(mask) = self.nd(id).mask.clone() {
            // what was painted keeps the mask's alpha: the mask drawn destination-in over it
            self.cmd.op(13, &m); self.cmd.num(25.0);
            match mask {
                Mask::Gradient(g) => {
                    self.cmd.op(1, &m); self.cmd.n4(0.0, 0.0, nw, nh); self.cmd.n4(0.0, 0.0, 0.0, 0.0); self.cmd.n5(g.kind, g.angle, g.cx, g.cy, g.r);
                    self.cmd.num((g.stops.len() / 2) as f64); self.cmd.list(&g.stops);
                }
                Mask::View { stencil, x, y } => {
                    if self.nodes.contains_key(&stencil) {
                        let (stx, sty) = (self.nd(stencil).x, self.nd(stencil).y);
                        self.paint(e, stencil, &mul(&m, &translate(x - stx, y - sty)), clip, pixelated, true);
                    }
                }
            }
            self.cmd.pop(); self.cmd.pop();
        }
        if blend != 0.0 { self.cmd.pop(); }
    }

    // ── layers: what one scene cannot do (layers.rs) ────────────────────────────

    /// The filter tier: the view's painted subtree into a layer of its own, through the
    /// filters, and the result drawn where it was.
    fn paint_filtered(&mut self, e: &mut Engine, id: u32, parent: &M, clip: &Rect, pixelated: bool) {
        let m = mul(parent, &self.local(id));
        let k = { let h = m[0].hypot(m[1]); if h == 0.0 || h.is_nan() { 1.0 } else { h } };
        let (passes, reach) = filter_pass_list(self.nd(id).filters.as_ref().unwrap(), k);
        let Some(b) = self.subtree_bounds(id, &m) else { self.nm(id).painted = None; return };
        let l = whole(&intersect(&grown(&b, reach), &grown(clip, reach)));
        let (w, h) = (l.x1 - l.x0, l.y1 - l.y0);
        if w <= 0.0 || h <= 0.0 || !(w + h).is_finite() { let fx = self.nd(id).fx_rect; self.nm(id).painted = fx; return; }   // off the region drawn: as it was
        // the layer made before, while its subtree stands and it holds the rect needed now
        let (stands, text_gen) = (self.nd(id).sub_gen, e.generation());
        // laid moved by whole device pixels (a scroll): the same pixels, where it is now
        let shift = |fm: &M| (m[4] - fm[4], m[5] - fm[5]);
        let at = |fm: &M, made: &Rect| { let (dx, dy) = shift(fm); shifted(made, dx, dy) };
        if let Some((_, fm, made, ..)) = self.nd(id).filter_made.filter(|&(g, fm, made, tg, px)| {
            let (dx, dy) = shift(&fm);
            self.keep && g == stands && fm[..4] == m[..4] && whole_px(dx) && whole_px(dy) && tg == text_gen && px == pixelated && covers(&shifted(&made, dx, dy), &l)
        }) {
            let made = at(&fm, &made);
            self.cmd.op(15, &I); self.cmd.num((id * 4) as f64); self.cmd.n4(made.x0, made.y0, made.x1 - made.x0, made.y1 - made.y0);
            let n = self.nm(id); n.painted = Some(made); n.fx_rect = Some(made);
            self.drew(made);
            self.counts[ct::FILTERS_KEPT] += 1.0;
            return;
        }
        let saved = self.sub_begin();
        let outer = self.in_layer.replace(id);
        self.paint(e, id, parent, &l, pixelated, false);
        self.in_layer = outer;
        let sub = self.sub_end(saved);
        let sc = layer_scale_of(&passes);
        if let Err(err) = e.layer(id * 4, sub.view(), l.x0, l.y0, w as u32, h as u32, &scale_pass_list(&passes, sc), sc) {
            crate::log(&format!("[gpu] layer: {err:?}")); return;
        }
        self.cmd.op(15, &I); self.cmd.num((id * 4) as f64); self.cmd.n4(l.x0, l.y0, w, h);
        let n = self.nm(id); n.painted = Some(l); n.fx_rect = Some(l); n.filter_made = Some((stands, m, l, text_gen, pixelated));
        self.drew(l);
    }

    /// Out of its plane: painted flat at the scale it is seen at, through its filters there,
    /// then projected by the runtime's homography onto the screen.
    fn paint_3d(&mut self, e: &mut Engine, id: u32, parent: &M, clip: &Rect, pixelated: bool) {
        let Some((hm, backface_hidden)) = self.nd(id).projection else {
            let saved = self.in_flat.replace(id);
            self.paint(e, id, parent, clip, pixelated, false);
            self.in_flat = saved;
            return;
        };
        let (nw, nh) = (self.nd(id).w, self.nd(id).h);
        if backface_hidden && !front_facing(&hm, nw, nh) { self.nm(id).painted = None; return; }
        // the device map: the parent's (affine) after the homography
        let p = parent;
        let hd: H = [
            p[0] * hm[0] + p[2] * hm[3] + p[4] * hm[6], p[0] * hm[1] + p[2] * hm[4] + p[4] * hm[7], p[0] * hm[2] + p[2] * hm[5] + p[4] * hm[8],
            p[1] * hm[0] + p[3] * hm[3] + p[5] * hm[6], p[1] * hm[1] + p[3] * hm[4] + p[5] * hm[7], p[1] * hm[2] + p[3] * hm[5] + p[5] * hm[8],
            hm[6], hm[7], hm[8]];
        // what it paints, in its own space (children past its box included)
        let loc = self.local(id);
        let Some(lb0) = self.subtree_bounds(id, &loc) else { self.nm(id).painted = None; return };
        let inv = invert_affine(&loc);
        let (mut lx0, mut ly0, mut lx1, mut ly1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (x, y) in [(lb0.x0, lb0.y0), (lb0.x1, lb0.y0), (lb0.x1, lb0.y1), (lb0.x0, lb0.y1)] {
            let (x, y) = ap(&inv, x, y);
            lx0 = jmin(lx0, x); ly0 = jmin(ly0, y); lx1 = jmax(lx1, x); ly1 = jmax(ly1, y);
        }
        // the scale it is seen at: the longest projected edge over its length
        let q = quad_through(&hd, lx0, ly0, lx1 - lx0, ly1 - ly0);
        if [lx0, ly0, lx1, ly1].iter().any(|v| !v.is_finite()) || lx1 <= lx0 || ly1 <= ly0 { self.nm(id).painted = None; return; }
        let front = [(lx0, ly0), (lx1, ly0), (lx1, ly1), (lx0, ly1)].iter().all(|&(x, y)| in_front(&hd, x, y));
        if !front { self.nm(id).painted = None; return; }
        let edge = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).hypot(a.1 - b.1);
        let mut k = [edge(q[0], q[1]) / (lx1 - lx0), edge(q[1], q[2]) / (ly1 - ly0), edge(q[2], q[3]) / (lx1 - lx0), edge(q[3], q[0]) / (ly1 - ly0)]
            .into_iter().fold(f64::NEG_INFINITY, jmax);
        k = jmin(jmax(k, 0.25), 4.0 * self.dpr);
        let (fpasses, freach) = match self.nd(id).filters.as_ref() { Some(f) => filter_pass_list(f, k), None => (Vec::new(), 0.0) };
        let r = freach / k;
        lx0 -= r; ly0 -= r; lx1 += r; ly1 += r;
        let (mut tw, mut th) = (((lx1 - lx0) * k).ceil(), ((ly1 - ly0) * k).ceil());
        let cap = 4096.0 / jmax(tw, th);
        if cap < 1.0 { k *= cap; tw = ((lx1 - lx0) * k).ceil(); th = ((ly1 - ly0) * k).ceil(); }
        // flat: local → texels; its parent matrix is that over the inverse of its own
        let flat: M = [k, 0.0, 0.0, k, -lx0 * k, -ly0 * k];
        let saved = self.sub_begin();
        let (outer_flat, outer_layer) = (self.in_flat.replace(id), self.in_layer.replace(id));
        self.paint(e, id, &mul(&flat, &inv), &Rect { x0: 0.0, y0: 0.0, x1: tw, y1: th }, pixelated, false);
        self.in_flat = outer_flat; self.in_layer = outer_layer;
        let sub = self.sub_end(saved);
        // the projection: output pixel → device (+ the output's corner) → local (Hd⁻¹) → texel
        let qq = quad_through(&hd, lx0, ly0, lx1 - lx0, ly1 - ly0);
        let (mut ox0, mut oy0, mut ox1, mut oy1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for (x, y) in qq { ox0 = jmin(ox0, x); oy0 = jmin(oy0, y); ox1 = jmax(ox1, x); oy1 = jmax(oy1, y); }
        let o = whole(&intersect(&Rect { x0: ox0, y0: oy0, x1: ox1, y1: oy1 }, clip));
        let (ow, oh) = (o.x1 - o.x0, o.y1 - o.y0);
        if ow <= 0.0 || oh <= 0.0 || ow > 16384.0 || oh > 16384.0 { self.nm(id).painted = None; return; }
        let hi = invert_h(&hd);
        // T_flat · Hi · T_out
        let a = [k, 0.0, -lx0 * k, 0.0, k, -ly0 * k, 0.0, 0.0, 1.0];
        let b = [1.0, 0.0, o.x0, 0.0, 1.0, o.y0, 0.0, 0.0, 1.0];
        let m3 = |a: &[f64; 9], b: &[f64; 9]| -> [f64; 9] {
            let mut r = [0.0; 9];
            for i in 0..3 { for j in 0..3 { r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]; } }
            r
        };
        let map = m3(&a, &m3(&hi, &b));
        let mut passes = fpasses;
        passes.extend_from_slice(&[5.0, ow, oh]);
        passes.extend_from_slice(&map);
        if let Err(err) = e.layer(id * 4 + 1, sub.view(), 0.0, 0.0, tw as u32, th as u32, &passes, 1.0) {
            crate::log(&format!("[gpu] layer: {err:?}")); return;
        }
        self.cmd.op(15, &I); self.cmd.num((id * 4 + 1) as f64); self.cmd.n4(o.x0, o.y0, ow, oh);
        self.nm(id).painted = Some(o);
        self.drew(o);
    }

    /// Frost: what was painted beneath the view so far, blurred and saturated, under its box.
    fn paint_backdrop(&mut self, e: &mut Engine, id: u32, m: &M, clip: &Rect) {
        let k = { let h = m[0].hypot(m[1]); if h == 0.0 || h.is_nan() { 1.0 } else { h } };
        let (mut passes, _) = filter_pass_list(self.nd(id).backdrop.as_ref().unwrap(), k);
        // what is beneath the box only, mirrored past its edges — CSS backdrop-filter's sample
        let mut i = 0;
        while i < passes.len() {
            let kind = passes[i];
            if kind == 1.0 { passes[i + 2] = 2.0; i += 3; } else if kind == 2.0 { i += 21; } else if kind == 3.0 { i += 5; } else if kind == 4.0 { i += 2; } else { break; }
        }
        let (nw, nh) = (self.nd(id).w, self.nd(id).h);
        let bx = aabb(m, 0.0, 0.0, nw, nh);
        self.nm(id).fx_rect = Some(bx);
        let s = whole(&intersect(&bx, clip));
        let (w, h) = (s.x1 - s.x0, s.y1 - s.y0);
        if w <= 0.0 || h <= 0.0 || !(w + h).is_finite() { return; }
        let sc = layer_scale_of(&passes);
        let lid = id * 4 + 2;
        if !self.in_frame_cmd {
            if let Err(err) = e.layer(lid, &self.cmd.prefix(), s.x0, s.y0, w as u32, h as u32, &scale_pass_list(&passes, sc), sc) {
                crate::log(&format!("[gpu] frost: {err:?}")); return;
            }
        } else {
            // the shared backdrop, when nothing since it was taken lands under this box and it is
            // fine enough for this blur; else a new one, from here
            if self.snap.is_none_or(|sn| sn < sc - 1e-6) || self.since_snap.iter().any(|q| meets(q, &s)) {
                let f = self.frame_clip;
                let at = jmax(sc, self.snap_scale);
                // the frame as it stands: what is written so far goes onto it, then it is read
                self.cut(e);
                e.frame_snapshot(f.x0 as u32, f.y0 as u32, (f.x1 - f.x0) as u32, (f.y1 - f.y0) as u32, at);
                self.count(ct::SNAPSHOTS);
                self.snap = Some(jmin(1.0, jmax(1.0 / 64.0, at)));
                self.since_snap.clear();
            }
            e.layer_from_snapshot(lid, s.x0, s.y0, w, h, &scale_pass_list(&passes, self.snap.unwrap()));
            self.count(ct::FROSTS);
        }
        let [r0, r1, r2, r3] = self.nd(id).r4();
        let d = &mut self.cmd;                      // the snapshot may have started a new one
        d.op(4, m); d.n5(1.0, 0.0, 0.0, nw, nh); d.n4(r0, r1, r2, r3);
        d.op(15, &I); d.num(lid as f64); d.n4(s.x0, s.y0, w, h);
        d.pop();
    }

    /// A view's image, placed as the canvas renderer places it: cover and contain keep its
    /// shape (cover crops to the box), aligned by alignX/alignY; width, height and both stretch
    /// those axes; none shows it at its natural size.
    fn paint_image(&mut self, id: u32, m: &M, pixelated: bool) {
        let n = self.nd(id);
        let handle = n.image.unwrap();
        let Some(&(zw, zh)) = self.image_sizes.get(&handle) else { return };
        if zw <= 0.0 || zh <= 0.0 { return; }
        let st = n.stretch.as_str();
        let (mut dx, mut dy) = (0.0, 0.0);
        let (dw, dh);
        if st == "cover" || st == "contain" {
            let (a, b) = (n.w / zw, n.h / zh);
            let sc = if st == "cover" { jmax(a, b) } else { jmin(a, b) };
            dw = zw * sc; dh = zh * sc;
            dx = (n.w - dw) * fit_frac(&n.align_x); dy = (n.h - dh) * fit_frac(&n.align_y);
        } else {
            dw = if st == "width" || st == "both" { n.w } else { zw };
            dh = if st == "height" || st == "both" { n.h } else { zh };
        }
        let (cover, w, h, tint) = (if st == "cover" { 1.0 } else { 0.0 }, n.w, n.h, n.tint);
        let q = if self.flags.imgq >= 0.0 { self.flags.imgq } else if pixelated { 0.0 } else { 2.0 };
        let c = &mut self.cmd;
        c.op(11, m); c.num(handle as f64); c.n4(dx, dy, dw, dh);
        c.num(cover); c.num(w); c.num(h); c.num(q); c.num(tint as f64);
    }

    /// Where a view's own content can reach, in device pixels: its box, its shadow, its
    /// drawing's recorded bounds, and text running past the box.
    pub(crate) fn own_bounds(&self, id: u32, m: &M, bx: &Rect) -> Rect {
        let n = self.nd(id);
        let mut b = *bx;
        if let Some((dx, dy, blur, _)) = n.shadow {
            let reach = blur * 1.5;
            b = union(&b, &aabb(m, dx - reach, dy - reach, n.w + 2.0 * reach, n.h + 2.0 * reach));
        }
        if n.picture {
            match n.pic_bounds {
                None => return EVERYWHERE,       // reach unknown: never culled
                Some([x, y, w, h, pad]) => b = union(&b, &aabb(m, x - pad, y - pad, w + 2.0 * pad, h + 2.0 * pad)),
            }
        }
        if let Some(img) = n.image {
            if n.stretch != "cover" && n.stretch != "contain" {   // an unstretched axis can run past the box
                if let Some(&(zw, zh)) = self.image_sizes.get(&img) { b = union(&b, &aabb(m, 0.0, 0.0, jmax(n.w, zw), jmax(n.h, zh))); }
            }
        }
        if !n.text.is_empty() {
            let Some((ew, eh)) = n.text_extent else { return EVERYWHERE };   // not laid out yet
            // a text shadow and an outline reach past the glyphs
            let st = n.style.as_ref();
            let sh = st.and_then(|s| s.shadow.as_ref()).map(|s| (s.2 * 2.0 + jmax(s.0.abs(), s.1.abs())).ceil() + 2.0).unwrap_or(0.0);
            let reach = jmax(sh, st.and_then(|s| s.outline.as_ref()).map(|o| o.0).unwrap_or(0.0));
            b = union(&b, &aabb(m, -reach, -reach, jmax(n.w, ew) + 2.0 * reach, jmax(n.h, eh) + 2.0 * reach));
        }
        b
    }

    /// Where `id`'s subtree draws under `m`, in device pixels (None when it does not show).
    pub(crate) fn subtree_bounds(&self, id: u32, m: &M) -> Option<Rect> {
        let n = self.nd(id);
        if !n.visible || n.opacity <= 0.0 { return None; }
        let bx = aabb(m, 0.0, 0.0, n.w, n.h);
        let mut b = self.own_bounds(id, m, &bx);
        let (sx, sy) = (n.vis_x.unwrap_or(n.scroll_x), n.vis_y.unwrap_or(n.scroll_y));
        let inner = if sx != 0.0 || sy != 0.0 { mul(m, &translate(-sx, -sy)) } else { *m };
        let clips = self.clips_kids(id);
        for &c in &n.children {
            let cn = self.nd(c);
            if let Some(cb) = self.subtree_bounds(c, &mul(if cn.ignore_scroll { m } else { &inner }, &self.local(c))) {
                b = union(&b, &if clips && !cn.ignore_clip { intersect(&cb, &bx) } else { cb });
            }
        }
        Some(b)
    }

    /// Borders that differ by side, CSS's way: the ring between the box's rounded edge and
    /// an inner edge whose corners shrink by the borders beside them, each side's colour
    /// taking its share of the ring up to the corner diagonals.
    fn paint_sides(&mut self, id: u32, m: &M) {
        let n = self.nd(id);
        let [t, ri, b, l] = n.sides.unwrap();
        let wd = |s: Option<(f64, u32)>| s.map(|s| s.0).unwrap_or(0.0);
        let (tw, rw, bw, lw) = (wd(t), wd(ri), wd(b), wd(l));
        if tw + rw + bw + lw <= 0.0 { return; }
        let (w, h) = (n.w, n.h);
        let r = n.r4();
        let outer = rrect_path(0.0, 0.0, w, h, &[[r[0], r[0]], [r[1], r[1]], [r[2], r[2]], [r[3], r[3]]]);
        let inner = rrect_path(lw, tw, jmax(0.0, w - lw - rw), jmax(0.0, h - tw - bw), &[
            [jmax(0.0, r[0] - lw), jmax(0.0, r[0] - tw)], [jmax(0.0, r[1] - rw), jmax(0.0, r[1] - tw)],
            [jmax(0.0, r[2] - rw), jmax(0.0, r[2] - bw)], [jmax(0.0, r[3] - lw), jmax(0.0, r[3] - bw)],
        ]);
        let mut ring = outer; ring.extend_from_slice(&inner);
        let sides = [(t, [0.0, 0.0, w, 0.0, w - rw, tw, lw, tw]), (ri, [w, 0.0, w, h, w - rw, h - bw, w - rw, tw]),
            (b, [0.0, h, w, h, w - rw, h - bw, lw, h - bw]), (l, [0.0, 0.0, 0.0, h, lw, h - bw, lw, tw])];
        let live: Vec<((f64, u32), [f64; 8])> = sides.iter().filter_map(|(sd, q)| sd.filter(|s| s.0 > 0.0).map(|s| (s, *q))).collect();
        let same = live.iter().all(|(sd, _)| sd.1 == live[0].0.1);
        let c = &mut self.cmd;
        let fill_ring = |c: &mut Commands, col: u32| { c.op(9, m); c.num(1.0); c.num(ring.len() as f64); c.list(&ring); c.num(2.0); c.num(0.0); c.num(col as f64); };
        if same { c.op(16, m); c.n4(0.0, 0.0, w, h); c.n4(r[0], r[1], r[2], r[3]); c.n4(tw, rw, bw, lw); c.num(live[0].0.1 as f64); return; }
        for (sd, q) in &live {
            // the side's share: the quadrilateral from its two outer corners to its inner ones,
            // grown outward so antialiasing at the edge is not cut
            let (cx, cy) = (w / 2.0, h / 2.0);
            let sign = |v: f64| if v > 0.0 { 1.0 } else if v < 0.0 { -1.0 } else { v };
            let grow = |x: f64, y: f64| (x + sign(x - cx), y + sign(y - cy));
            let ((ax, ay), (bx, by)) = (grow(q[0], q[1]), grow(q[2], q[3]));
            let quad = [0.0, ax, ay, 1.0, bx, by, 1.0, q[4], q[5], 1.0, q[6], q[7], 4.0];
            c.op(10, m); c.num(0.0); c.num(quad.len() as f64); c.list(&quad);
            fill_ring(c, sd.1);
            c.pop();
        }
    }

    fn paint_text(&mut self, e: &mut Engine, id: u32, m: &M) {
        // what it draws from is lent out of the node while the commands are written
        let n = self.nm(id);
        if n.lines.is_none() || n.layout.is_none() || n.style.is_none() { return; }
        let (lines, l, st) = (n.lines.take().unwrap(), n.layout.take().unwrap(), n.style.take().unwrap());
        self.paint_lines(e, id, m, &lines, &l, &st);
        let n = self.nm(id);
        n.lines = Some(lines); n.layout = Some(l); n.style = Some(st);
    }

    fn paint_lines(&mut self, e: &mut Engine, id: u32, m: &M, lines: &[String], l: &super::TextLayout, st: &super::Style) {
        let n = self.nd(id);
        let [pt, pr, pb, pl] = st.pad;
        // a one-line field's text sits in the middle of its box, as an input's does
        let pt = if n.field == 1 { pt + (n.h - pt - pb - l.line_height) / 2.0 } else { pt };
        let tw = n.w - pl - pr;
        // each line shaped once, then drawn by its handle and its place
        let generation = e.generation() as i64;
        if n.handles.is_none() || n.handles_gen != generation {
            let handles: Vec<u32> = lines.iter().map(|line| e.line(&l.families, l.size as f32, l.weight as f32, l.italic, l.ls as f32, line)).collect();
            let line_x: Vec<f64> = handles.iter().map(|&h| if st.align == "left" || tw <= 0.0 { pl }
                else { let lw = e.line_width(h) as f64; pl + if st.align == "center" { (tw - lw) / 2.0 } else { tw - lw } }).collect();
            let nn = self.nm(id);
            nn.handles = Some(handles); nn.line_x = line_x; nn.handles_gen = generation;
            nn.text_color = st.color.as_deref().map(rgba).unwrap_or(0x0000_00ff);
            nn.text_stops = st.fill_gradient.as_ref().map(|g| stop_list(&g.1));
        }
        // the shadow beneath its own glyphs (a blurred layer), then per line the outline under
        // the fill (paint-order: stroke), the fill, and the rules in the text colour
        if let Some(sh) = &st.shadow { self.paint_text_shadow(e, id, m, lines, l, pt, sh); }
        let n = self.nodes.get(&id).unwrap();
        let (handles, line_x, color, stops, nh) = (n.handles.as_deref().unwrap_or(&[]), &n.line_x, n.text_color, &n.text_stops, n.h);
        let c = &mut self.cmd;
        for i in 0..lines.len() {
            let y = pt + l.half_lead + l.ascent + i as f64 * l.line_height;
            if let Some((ow, oc)) = st.outline.as_ref().filter(|o| o.0 > 0.0) {
                c.op(14, m); c.n5(handles[i] as f64, line_x[i], y, *ow, rgba(oc) as f64);
            }
            if let (Some(g), Some(s)) = (&st.fill_gradient, stops) {
                c.op(8, m); c.n5(handles[i] as f64, line_x[i], y, pl, pt); c.num(tw); c.num(nh - pt - pb); c.num(g.0);
                c.num((s.len() / 2) as f64); c.list(s);
            } else {
                c.op(7, m); c.n4(handles[i] as f64, line_x[i], y, color as f64);
            }
            if st.underline || st.strike {
                // canvas-backend's rules: centred 0.11·size below the baseline and 0.31·size above it
                let lw = e.line_width(handles[i]) as f64;
                let th = jmax(1.0, jround(l.size / 16.0));
                if st.underline { c.op(0, m); c.n4(line_x[i], jround(y + l.size * 0.11 - th / 2.0), lw, th); c.n4(0.0, 0.0, 0.0, 0.0); c.num(color as f64); }
                if st.strike { c.op(0, m); c.n4(line_x[i], jround(y - l.size * 0.31 - th / 2.0), lw, th); c.n4(0.0, 0.0, 0.0, 0.0); c.num(color as f64); }
            }
        }
    }

    /// A text shadow: the lines' glyphs in the shadow's colour, offset, drawn into a layer of
    /// their own at the scale the view is seen at and blurred there (layers.rs), kept until the
    /// text, style or scale changes, and drawn under the glyphs.
    #[allow(clippy::too_many_arguments)]
    fn paint_text_shadow(&mut self, e: &mut Engine, id: u32, m: &M, lines: &[String], l: &super::TextLayout, pt: f64, sh: &(f64, f64, f64, String)) {
        let (dx, dy, blur, color) = (sh.0, sh.1, sh.2, &sh.3);
        let k = jmax(0.25, jround(m[0].hypot(m[1]) * 4.0) / 4.0);
        let pad = (blur * 2.0 + jmax(dx.abs(), dy.abs())).ceil() + 2.0;
        let n = self.nd(id);
        let (ew, eh) = n.text_extent.unwrap_or((0.0, 0.0));
        let (w, h) = (jmax(n.w, ew) + 2.0 * pad, jmax(n.h, eh) + 2.0 * pad);
        let (tw, th) = ((w * k).ceil(), (h * k).ceil());
        if tw * th > 8192.0 * 8192.0 { return; }
        let lid = id * 4 + 3;
        let handles = n.handles.clone().unwrap_or_default();
        let line_x = n.line_x.clone();
        let mut hs = DefaultHasher::new();
        for v in [k, dx, dy, blur, l.size, l.weight, l.ls, w, h] { v.to_bits().hash(&mut hs); }
        (color, &l.families, l.italic, &handles, lines).hash(&mut hs);
        for v in &line_x { v.to_bits().hash(&mut hs); }
        let key = hs.finish();
        if n.shadow_key != Some(key) {
            // the layer's texels: the view's (-pad, -pad) at its corner, k texels a unit
            let sm: M = [k, 0.0, 0.0, k, (pad + dx) * k, (pad + dy) * k];
            let mut sub = Commands::default();
            let col = rgba(color) as f64;
            for i in 0..lines.len() { sub.op(7, &sm); sub.n4(handles[i] as f64, line_x[i], pt + l.half_lead + l.ascent + i as f64 * l.line_height, col); }
            // Canvas2D's and CSS's shadow blur is 2σ
            let (passes, _) = filter_pass_list(&[WireFilter { f: "blur".into(), v: Some(blur / 2.0), color: None, dx: None, dy: None, blur: None }], k);
            let sc = layer_scale_of(&passes);
            if let Err(err) = e.layer(lid, sub.view(), 0.0, 0.0, tw as u32, th as u32, &scale_pass_list(&passes, sc), sc) {
                crate::log(&format!("[gpu] text shadow: {err:?}")); return;
            }
            self.nm(id).shadow_key = Some(key);
        }
        let c = &mut self.cmd;
        c.op(15, m); c.num(lid as f64); c.n4(-pad, -pad, tw / k, th / k);
    }
}
