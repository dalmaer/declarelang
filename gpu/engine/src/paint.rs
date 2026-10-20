// paint — the frame's ordinary content drawn as instanced quads.
//
// The command stream (Engine::run's codes) is planned before anything is drawn. Boxes,
// gradient boxes, borders, box shadows, text and images become instances: one quad each
// (a glyph each, for text), drawn by one shader that knows every kind, all of a plan in one
// render pass. A view's clip (code 4 at full opacity) becomes a clip record the instances
// inside it point to; the shader applies the chain. Glyphs come from an atlas that Vello
// rasterizes (only a glyph not yet in it), so their shapes are Vello's own.
//
// What the quads do not draw — paths, drawings, gradient and outlined text, opacity and
// blend groups, shape clips — is a Vello item: encoded into a Vello scene with the clips
// around it, as `run` encodes it. Items are batched: an item joins the latest batch of its
// kind that nothing it overlaps was drawn after, so a frame whose few paths sit apart from
// one another (icons on buttons) is one Vello render, not one per path. Each Vello batch is
// rendered into a texture of its own bounds before the pass and laid in its place in it.
//
// Colours are premultiplied throughout the pass. A plan drawn onto the frame (opaque) is
// laid straight over it; one drawn into a texture of its own (a tile, a layer, a snapshot)
// is drawn into a transparent working texture and written to its destination unpremultiplied,
// the form Vello writes and every reader of those textures expects.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use vello::kurbo::{Affine, Rect, RoundedRect};
use vello::peniko::{BlendMode, Color, Fill};
use vello::{AaConfig, Glyph, RenderParams, Scene};
use wasm_bindgen::JsValue;

use skrifa::MetadataProvider;

use crate::{rrect, Engine, Gpu, Run, Shaped};

const K_FILL: f32 = 0.0;
const K_GRADIENT: f32 = 1.0;
const K_BORDER: f32 = 2.0;
const K_SHADOW: f32 = 3.0;
const K_GLYPH: f32 = 4.0;
const K_IMAGE: f32 = 5.0;
const K_BLIT: f32 = 6.0;
const K_UNPREMUL: f32 = 7.0;
const K_SPRITE: f32 = 8.0;

/// Floats per instance (seven vec4s) and per clip record (six).
const INST: usize = 28;
const CLIP: usize = 24;

const ATLAS: u32 = 2048;
/// The sprite texture's side.
const SPRITE_SIDE: u32 = 4096;
/// Glyphs larger than this (device pixels) are drawn by Vello.
const GLYPH_MAX: f32 = 256.0;

const SHADER: &str = r#"
// size: the target's; origin: where its corner stands in the plan's coordinates (a group's
// texture stands for a rect of them)
struct U { size: vec4<f32> }
struct Inst { m: vec4<f32>, t: vec4<f32>, rect: vec4<f32>, radii: vec4<f32>, color: vec4<f32>, p0: vec4<f32>, p1: vec4<f32> }
struct Clip { inv: vec4<f32>, it: vec4<f32>, rect: vec4<f32>, radii: vec4<f32>, aabb: vec4<f32>, misc: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> insts: array<Inst>;
@group(0) @binding(2) var<storage, read> clips: array<Clip>;
@group(0) @binding(3) var<storage, read> stops: array<vec4<f32>>;
@group(0) @binding(4) var atlas: texture_2d<f32>;
@group(1) @binding(0) var img: texture_2d<f32>;

// what a fragment needs of its instance, read once per vertex (flat): the fragment touches
// storage only for gradient stops and a chain of shape clips
struct V {
  @builtin(position) pos: vec4<f32>,
  @location(0) p: vec2<f32>,
  @location(1) @interpolate(flat) rect: vec4<f32>,
  @location(2) @interpolate(flat) radii: vec4<f32>,
  @location(3) @interpolate(flat) color: vec4<f32>,
  @location(4) @interpolate(flat) p0: vec4<f32>,
  @location(5) @interpolate(flat) p1: vec4<f32>,
  @location(6) @interpolate(flat) aabb: vec4<f32>,
  // s (device pixels a unit), kind, first shape clip to walk
  @location(7) @interpolate(flat) misc: vec4<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> V {
  let I = insts[ii];
  let corner = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0))[vi];
  let kind = u32(I.t.z);
  let s = sqrt(abs(I.m.x * I.m.w - I.m.y * I.m.z));
  var pad = 1.0 / max(s, 1e-6);
  if (kind == 3u) { pad += 2.5 * I.p0.x; }
  if (kind == 4u || kind >= 6u) { pad = 0.0; }
  let p = mix(I.rect.xy - vec2(pad), I.rect.xy + I.rect.zw + vec2(pad), corner);
  var d = vec2(I.m.x * p.x + I.m.z * p.y + I.t.x, I.m.y * p.x + I.m.w * p.y + I.t.y);
  // a copy (kinds 6, 7) can name the texture it is drawn into, in that texture's own pixels
  let own = (kind == 6u || kind == 7u) && I.p1.z > 0.0;
  if (!own) { d -= u.size.zw; }
  let size = select(u.size.xy, I.p1.zw, own);
  var o: V;
  o.pos = vec4(d.x / size.x * 2.0 - 1.0, 1.0 - d.y / size.y * 2.0, 0.0, 1.0);
  o.p = p;
  o.rect = I.rect;
  o.radii = I.radii;
  o.color = I.color;
  o.p0 = I.p0;
  o.p1 = I.p1;
  let ci = u32(I.t.w);
  let C = clips[ci];
  o.aabb = C.aabb;
  o.misc = vec4(s, I.t.z, select(C.it.w, f32(ci), C.misc.x > 0.0), 0.0);
  return o;
}

// how much of the pixel (half-width h, in the same units) lies in [lo, hi]
fn cov1(p: f32, lo: f32, hi: f32, h: f32) -> f32 {
  return clamp((min(p + h, hi) - max(p - h, lo)) / (2.0 * h), 0.0, 1.0);
}

fn box_cov(p: vec2<f32>, r: vec4<f32>, s: f32) -> f32 {
  let h = 0.5 / max(s, 1e-6);
  return cov1(p.x, r.x, r.x + r.z, h) * cov1(p.y, r.y, r.y + r.w, h);
}

// signed distance to a rounded box; radii top-left, top-right, bottom-right, bottom-left
fn sd_rrect(p: vec2<f32>, r: vec4<f32>, radii: vec4<f32>) -> f32 {
  let half = r.zw * 0.5;
  let q0 = p - (r.xy + half);
  var rad = select(select(radii.y, radii.z, q0.y >= 0.0), select(radii.x, radii.w, q0.y >= 0.0), q0.x < 0.0);
  rad = min(rad, min(half.x, half.y));
  let q = abs(q0) - half + vec2(rad);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - rad;
}

fn rr_cov(p: vec2<f32>, r: vec4<f32>, radii: vec4<f32>, s: f32) -> f32 {
  let b = box_cov(p, r, s);
  if (max(max(radii.x, radii.y), max(radii.z, radii.w)) <= 0.0 || b <= 0.0) { return b; }
  return min(b, clamp(0.5 - sd_rrect(p, r, radii) * s, 0.0, 1.0));
}

// the clips' cover of pixel px: the plain rectangles' (aabb), then each shape up the chain from k
fn clip_cov(aabb: vec4<f32>, first: u32, px: vec2<f32>) -> f32 {
  var cov = cov1(px.x, aabb.x, aabb.z, 0.5) * cov1(px.y, aabb.y, aabb.w, 0.5);
  var k = first;
  for (var n = 0; n < 32; n++) {
    if (k == 0u || cov <= 0.0) { break; }
    let D = clips[k];
    let lp = vec2(D.inv.x * px.x + D.inv.z * px.y + D.it.x, D.inv.y * px.x + D.inv.w * px.y + D.it.y);
    cov *= rr_cov(lp, D.rect, D.radii, D.it.z);
    k = u32(D.it.w);
  }
  return cov;
}

fn premul(c: vec4<f32>) -> vec4<f32> { return vec4(c.rgb * c.a, c.a); }

fn gradient(I: Inst, p: vec2<f32>) -> vec4<f32> { return gradient_at(I.p0, I.p1, p); }

// a gradient's colour at p: geometry g (linear: two points; radial: centre, radius; conic:
// centre), stops sp (first, count, kind)
fn gradient_at(g: vec4<f32>, sp: vec4<f32>, p: vec2<f32>) -> vec4<f32> {
  let kind = u32(sp.z);
  let s0 = u32(sp.x);
  let n = u32(sp.y);
  if (n == 0u) { return vec4(0.0); }
  var t: f32;
  if (kind == 0u) {
    let d = g.zw - g.xy;
    t = dot(p - g.xy, d) / max(dot(d, d), 1e-12);
  } else if (kind == 1u) {
    t = length(p - g.xy) / max(g.z, 1e-6);
  } else {
    var a = atan2(p.y - g.y, p.x - g.x);
    if (a < 0.0) { a += 6.283185307; }
    t = a / 6.283185307;
  }
  t = clamp(t, 0.0, 1.0);
  if (t <= stops[s0].x) { return stops[s0 + 1u]; }
  for (var k = 1u; k < n; k++) {
    let o = stops[s0 + 2u * k].x;
    if (t <= o) {
      let po = stops[s0 + 2u * k - 2u].x;
      let f = select((t - po) / (o - po), 1.0, o - po < 1e-9);
      return mix(stops[s0 + 2u * k - 1u], stops[s0 + 2u * k + 1u], f);
    }
  }
  return stops[s0 + 2u * n - 1u];
}

fn erf7(x: f32) -> f32 {
  let y = clamp(x * 1.1283791671, -100.0, 100.0);
  let yy = y * y;
  let z = y + (0.24295 + (0.03395 + 0.0104 * yy) * yy) * (y * yy);
  return z / sqrt(1.0 + z * z);
}

// a blurred rounded box (Vello's approximation, raphlinus.github.io 2020-04-21)
fn shadow(I: Inst, p: vec2<f32>) -> f32 {
  let std_dev = max(I.p0.x, 1e-5);
  let inv = 1.0 / std_dev;
  let w = I.rect.z;
  let h = I.rect.w;
  let min_edge = min(w, h);
  let radius_max = 0.5 * min_edge;
  let r0 = min(sqrt(I.p0.y * I.p0.y + std_dev * std_dev * 1.3225), radius_max);
  let r1 = min(sqrt(I.p0.y * I.p0.y + std_dev * std_dev * 4.0), radius_max);
  let exponent = 2.0 * r1 / r0;
  let delta = 1.25 * std_dev * (exp(-pow(0.5 * inv * w, 2.0)) - exp(-pow(0.5 * inv * h, 2.0)));
  let ww = w + min(delta, 0.0);
  let hh = h - max(delta, 0.0);
  let scale = 0.5 * erf7(inv * 0.5 * (max(ww, hh) - 0.5 * I.p0.y));
  let c = p - (I.rect.xy + I.rect.zw * 0.5);
  let y0 = abs(c.y) - (hh * 0.5 - r1);
  let x0 = abs(c.x) - (ww * 0.5 - r1);
  let d_pos = pow(pow(max(x0, 0.0), exponent) + pow(max(y0, 0.0), exponent), 1.0 / exponent);
  let d = d_pos + min(max(x0, y0), 0.0) - r1;
  return scale * (erf7(inv * (min_edge + d)) - erf7(inv * d));
}

fn tap(q: vec2<f32>, hi: vec2<f32>) -> vec4<f32> {
  return premul(textureLoad(img, vec2<i32>(clamp(q, vec2(0.0), hi)), 0));
}

fn single_weight(t: f32, a: f32, b: f32, c: f32, d: f32) -> f32 { return t * (t * (t * d + c) + b) + a; }
fn cubic_weights(f: f32) -> vec4<f32> {
  let B = 1.0 / 3.0;
  return vec4(
    single_weight(f, (1.0 / 6.0) * B, -(3.0 / 6.0) * B - B, (3.0 / 6.0) * B + 2.0 * B, -(1.0 / 6.0) * B - B),
    single_weight(f, 1.0 - (2.0 / 6.0) * B, 0.0, -3.0 + (12.0 / 6.0) * B + B, 2.0 - (9.0 / 6.0) * B - B),
    single_weight(f, (1.0 / 6.0) * B, (3.0 / 6.0) * B + B, 3.0 - (15.0 / 6.0) * B - 2.0 * B, -2.0 + (9.0 / 6.0) * B + B),
    single_weight(f, 0.0, 0.0, -B, (1.0 / 6.0) * B + B));
}

// an image at texel-space point p, premultiplied, as Vello samples it: 0 nearest,
// 1 bilinear, 2 bicubic (Mitchell, B = C = 1/3)
fn sample(p: vec2<f32>, dims: vec2<f32>, q: u32) -> vec4<f32> {
  let hi = dims - vec2(1.0);
  if (q == 0u) { return tap(floor(p), hi); }
  if (q == 1u) {
    let uv = p - vec2(0.5);
    let c = clamp(uv, vec2(0.0), hi);
    let lo = floor(c);
    let up = ceil(c);
    let f = fract(uv);
    let a = tap(lo, hi);
    let b = tap(vec2(lo.x, up.y), hi);
    let cc = tap(vec2(up.x, lo.y), hi);
    let d = tap(up, hi);
    return mix(mix(a, b, f.y), mix(cc, d, f.y), f.x);
  }
  let fr = fract(p + vec2(0.5));
  let cx = cubic_weights(fr.x);
  let cy = cubic_weights(fr.y);
  var rows = array<vec4<f32>, 4>();
  for (var j = 0; j < 4; j++) {
    let dy = f32(j) - 1.5;
    rows[j] = cx.x * tap(p + vec2(-1.5, dy), hi) + cx.y * tap(p + vec2(-0.5, dy), hi)
            + cx.z * tap(p + vec2(0.5, dy), hi) + cx.w * tap(p + vec2(1.5, dy), hi);
  }
  let r = cy.x * rows[0] + cy.y * rows[1] + cy.z * rows[2] + cy.w * rows[3];
  let a = clamp(r.a, 0.0, 1.0);
  return vec4(clamp(r.rgb, vec3(0.0), vec3(a)), a);
}

@fragment
fn fs(v: V) -> @location(0) vec4<f32> {
  let I = Inst(vec4(0.0), vec4(0.0), v.rect, v.radii, v.color, v.p0, v.p1);
  let kind = u32(v.misc.y);
  let s = v.misc.x;
  var c: vec4<f32>;
  switch kind {
    case 0u: { c = premul(I.color) * rr_cov(v.p, I.rect, I.radii, s); }
    case 1u: { c = gradient(I, v.p) * rr_cov(v.p, I.rect, I.radii, s); }
    case 2u: {
      // widths top, right, bottom, left; the inner corners shrink by the wider side beside them
      let b = I.p0;
      let inner = vec4(I.rect.x + b.w, I.rect.y + b.x, max(I.rect.z - b.w - b.y, 0.0), max(I.rect.w - b.x - b.z, 0.0));
      let ir = max(I.radii - vec4(max(b.w, b.x), max(b.y, b.x), max(b.y, b.z), max(b.w, b.z)), vec4(0.0));
      var ic = 0.0;
      if (inner.z > 0.0 && inner.w > 0.0) { ic = rr_cov(v.p, inner, ir, s); }
      c = premul(I.color) * max(rr_cov(v.p, I.rect, I.radii, s) - ic, 0.0);
    }
    case 3u: {
      let reach = vec4(I.rect.xy - vec2(2.5 * I.p0.x), I.rect.zw + vec2(5.0 * I.p0.x));
      c = premul(I.color) * (shadow(I, v.p) * box_cov(v.p, reach, s));
    }
    case 4u: {
      let uv = I.p0.xy + (v.p - I.rect.xy) * I.p0.zw / I.rect.zw - vec2(0.5);
      var a: f32;
      if (I.p1.w > 0.0) {
        // on the pixel grid: the texel itself
        a = textureLoad(atlas, vec2<i32>(floor(uv + vec2(0.5))), 0).a;
      } else {
      let lo = clamp(floor(uv), I.p0.xy, I.p0.xy + I.p0.zw - vec2(1.0));
      let up = clamp(ceil(uv), I.p0.xy, I.p0.xy + I.p0.zw - vec2(1.0));
      let f = fract(uv);
      a = mix(mix(textureLoad(atlas, vec2<i32>(lo), 0).a, textureLoad(atlas, vec2<i32>(vec2(lo.x, up.y)), 0).a, f.y),
                  mix(textureLoad(atlas, vec2<i32>(vec2(up.x, lo.y)), 0).a, textureLoad(atlas, vec2<i32>(up), 0).a, f.y), f.x);
      }
      // filled with the colour, or a gradient (p1: its stops; radii: its geometry, device space)
      c = select(premul(I.color), gradient_at(I.radii, I.p1, v.p), I.p1.y > 0.0) * a;
    }
    case 5u: {
      var t = sample(v.p, I.p0.xy, u32(I.p0.z));
      if (I.p1.x > 0.0) { t = premul(I.color) * t.a; }
      c = t * (I.p0.w * box_cov(v.p, vec4(0.0, 0.0, I.p0.x, I.p0.y), s));
    }
    case 6u: {
      // a texture's pixels laid 1:1 (premultiplied already when p0.z > 0), faded by color.a
      let t = textureLoad(img, vec2<i32>(floor(v.p - I.rect.xy + I.p0.xy)), 0);
      c = select(premul(t), t, I.p0.z > 0.0) * I.color.a;
    }
    case 8u: {
      // a region of the sprite texture (Vello's output: straight alpha; p0: its corner and size)
      // over the rect, each texel premultiplied, then bilinear: a sprite laid at another place
      // or scale than it was rastered at
      let uv = I.p0.xy + (v.p - I.rect.xy) * I.p0.zw / I.rect.zw - vec2(0.5);
      let hi = I.p0.xy + I.p0.zw - vec2(1.0);
      let lo = clamp(floor(uv), I.p0.xy, hi);
      let up = clamp(ceil(uv), I.p0.xy, hi);
      let f = fract(uv);
      let t = mix(mix(premul(textureLoad(img, vec2<i32>(lo), 0)), premul(textureLoad(img, vec2<i32>(vec2(lo.x, up.y)), 0)), f.y),
                  mix(premul(textureLoad(img, vec2<i32>(vec2(up.x, lo.y)), 0)), premul(textureLoad(img, vec2<i32>(up), 0)), f.y), f.x);
      c = t * box_cov(v.p, I.rect, s);
    }
    default: {
      let t = textureLoad(img, vec2<i32>(floor(v.p - I.rect.xy + I.p0.xy)), 0);
      return select(vec4(0.0), vec4(t.rgb / t.a, t.a), t.a > 0.0);
    }
  }
  if (v.misc.z == 0.0 && v.aabb.x <= -1e6) { return c; }
  return c * clip_cov(v.aabb, u32(v.misc.z), v.pos.xy + u.size.zw);
}
"#;

/// The GPU side: pipelines, the glyph atlas's texture, images uploaded for the quads.
pub(crate) struct Painter {
    over: wgpu::RenderPipeline,
    replace: wgpu::RenderPipeline,
    layout0: wgpu::BindGroupLayout,
    layout1: wgpu::BindGroupLayout,
    atlas: wgpu::Texture,
    /// Drawings rastered once (Sprites), and their texture binding.
    sprites: wgpu::Texture,
    sprites_bind: wgpu::BindGroup,
    /// The texture binding for instances that sample none.
    none: wgpu::BindGroup,
    images: HashMap<u32, (wgpu::Texture, wgpu::BindGroup)>,
    /// The plans' buffers and bindings, kept between frames: the n-th plan bound since the
    /// last submission writes slot n in place (bind0), so nothing is made per frame once the
    /// slots are as large as the frames need. A slot is written once per submission, so what a
    /// pass recorded before reads what it was given.
    slots: RefCell<Vec<PlanSlot>>,
    pub(crate) slot_next: Cell<usize>,
    /// Each texture's binding (layer 1), kept while the texture is used: pooled textures, tiles
    /// and layers come back frame after frame. Entries unused for a while go (prune).
    binds1: RefCell<HashMap<wgpu::Texture, (wgpu::BindGroup, u32)>>,
    /// Submissions so far: what `binds1`'s entries were last used at.
    pub(crate) epoch: Cell<u32>,
}

impl Painter {
    /// The encoder was submitted: the slots are free to write, and bindings of textures not
    /// used for a while go (with the textures they hold).
    pub(crate) fn submitted(&self) {
        self.slot_next.set(0);
        let e = self.epoch.get().wrapping_add(1);
        self.epoch.set(e);
        if e % 64 == 0 { self.binds1.borrow_mut().retain(|_, (_, at)| e.wrapping_sub(*at) < 256); }
    }
}

/// A plan's buffers (uniform, instances, clips, stops) and the binding over them and the atlas.
struct PlanSlot { u: wgpu::Buffer, insts: wgpu::Buffer, clips: wgpu::Buffer, stops: wgpu::Buffer, bind: wgpu::BindGroup, atlas: wgpu::Texture }

impl Painter {
    pub(crate) fn new(device: &wgpu::Device) -> Painter {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("paint"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let vf = wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT;
        let storage = |binding| wgpu::BindGroupLayoutEntry { binding, visibility: vf, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None };
        let texture = |binding| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None };
        let layout0 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("paint"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: vf, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                storage(1), storage(2), storage(3), texture(4),
            ],
        });
        let layout1 = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("paint image"), entries: &[texture(0)] });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("paint"), bind_group_layouts: &[Some(&layout0), Some(&layout1)], immediate_size: 0 });
        let pipe = |blend: Option<wgpu::BlendState>| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("paint"), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend, write_mask: wgpu::ColorWrites::ALL })] }),
            primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(),
            multiview_mask: None, cache: None,
        });
        let over = pipe(Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING));
        let replace = pipe(None);
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glyph atlas"),
            size: wgpu::Extent3d { width: ATLAS, height: ATLAS, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let sprites = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("sprites"),
            size: wgpu::Extent3d { width: SPRITE_SIDE, height: SPRITE_SIDE, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let sprites_bind = bind1(device, &layout1, &sprites);
        let blank = crate::layers::layer_texture(device, 1, 1);
        let none = bind1(device, &layout1, &blank);
        Painter { over, replace, layout0, layout1, atlas, sprites, sprites_bind, none, images: HashMap::new(),
            slots: RefCell::new(Vec::new()), slot_next: Cell::new(0), binds1: RefCell::new(HashMap::new()), epoch: Cell::new(0) }
    }

    /// The atlas's, the sprites' and the images' textures, in MB.
    pub(crate) fn texture_mb(&self) -> f64 {
        let mb = |t: &wgpu::Texture| (t.width() as u64 * t.height() as u64 * 4) as f64 / 1048576.0;
        mb(&self.atlas) + mb(&self.sprites) + self.images.values().map(|(t, _)| mb(t)).sum::<f64>()
    }

    /// An image's texture for the quads, uploaded on first use (straight RGBA, as decoded).
    fn image(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, handle: u32, img: &vello::peniko::ImageData) -> bool {
        if self.images.contains_key(&handle) { return true; }
        let (w, h) = (img.width, img.height);
        let max = device.limits().max_texture_dimension_2d;
        if w == 0 || h == 0 || w > max || h > max || img.data.data().len() < (w * h * 4) as usize { return false; }
        let t = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("image"),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(t.as_image_copy(), img.data.data(),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4), rows_per_image: Some(h) },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 });
        let bg = bind1(device, &self.layout1, &t);
        self.images.insert(handle, (t, bg));
        true
    }

    pub(crate) fn drop_image(&mut self, handle: u32) { self.images.remove(&handle); }
}

fn bind1(device: &wgpu::Device, layout: &wgpu::BindGroupLayout, t: &wgpu::Texture) -> wgpu::BindGroup {
    let view = t.create_view(&Default::default());
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("paint image"), layout,
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }] })
}

// ── the glyph atlas's bookkeeping (the engine's side) ───────────────────────────────

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
struct GlyphKey { face: u64, glyph: u32, size: u32, fx: u8, fy: u8 }

/// A glyph's place in the atlas and where its box sits from the pen, in device pixels
/// (w = 0: a glyph with no ink).
#[derive(Clone, Copy)]
pub(crate) struct Slot { x: u32, y: u32, w: u32, h: u32, ix: i32, iy: i32 }

/// What the painter did since last asked (Engine::paint_counts): glyphs rastered, atlas
/// draws, atlas resets, Vello batches rendered, blend groups, instances, plans.
#[derive(Default)]
pub(crate) struct Counts { pub glyphs: u32, pub atlas_draws: u32, pub resets: u32, pub vello: u32, pub backdrops: u32, pub insts: u32, pub plans: u32,
    /// Drawings rastered into the sprite texture, the texture's resets, and drawings drawn by Vello.
    pub sprites: u32, pub sprite_resets: u32, pub pictures: u32,
    /// Why drawings were not sprites: reach unknown, recorded since the last plan, turned or
    /// stretched, too large, no room.
    pub sprite_miss: [u32; 5],
    /// Sprites laid from a raster made at another place or scale.
    pub sprite_laid: u32,
    /// Kept subtrees' plans replayed, and recorded.
    pub kept_plans: u32, pub kept_recorded: u32,
    /// Opacity groups laid from their kept texture, and groups drawn and kept.
    pub kept_groups: u32, pub groups_made: u32 }

/// Room in a square texture of side `side` (0 is ATLAS), shelf by shelf: top, height, how
/// far along filled.
#[derive(Default)]
struct Shelves { rows: Vec<(u32, u32, u32)>, next_y: u32, side: u32 }

impl Shelves {
    fn side(&self) -> u32 { if self.side == 0 { ATLAS } else { self.side } }
    fn alloc(&mut self, w: u32, h: u32) -> Option<(u32, u32)> {
        let (w, h) = (w + 1, h + 1);
        let side = self.side();
        for s in self.rows.iter_mut() {
            if s.1 >= h && s.1 - h <= (h / 4).max(4) && s.2 + w <= side {
                let x = s.2;
                s.2 += w;
                return Some((x, s.0));
            }
        }
        let sh = h.div_ceil(4) * 4;
        if self.next_y + sh > side || w > side { return None; }
        self.rows.push((self.next_y, sh, w));
        self.next_y += sh;
        Some((0, self.next_y - sh))
    }
    fn clear(&mut self) { self.rows.clear(); self.next_y = 0; }
    fn full(&self) -> bool { self.next_y > self.side() * 7 / 8 }
    /// No room was found: the texture counts as full, and is cleared at the next plan.
    fn fill_up(&mut self) { self.next_y = self.side() + 1; }
}

/// A drawing rastered at a transform (its scale and quarter-pixel phase), by its recording.
#[derive(Hash, PartialEq, Eq, Clone, Copy)]
pub(crate) struct SpriteKey { id: u32, version: u32, sx: u64, sy: u64, fx: u8, fy: u8 }

/// Drawings that hold still, rastered once by Vello into the sprite texture and laid 1:1.
pub(crate) struct Sprites {
    slots: HashMap<SpriteKey, Slot>,
    shelves: Shelves,
    pending: Scene,
    fresh: Vec<Slot>,
    /// Each drawing's recording (picture_begin counts them) and the plan it was made before.
    pub(crate) versions: HashMap<u32, (u32, u32)>,
    /// Each drawing's last raster and how it was laid last: its version, the raster's scale,
    /// phase and slot, and the transform it was laid under.
    last: HashMap<u32, Last>,
    /// The policy before moving sprites (`&oldsprites`, for an A/B): exact rasters only, at
    /// most 512 pixels.
    pub(crate) exact_only: bool,
    /// The drawings laid from another raster since the last take: they are rastered exactly
    /// once they hold still, which takes a frame after the last that moved them.
    pub(crate) sampled: Vec<u32>,
    /// The plan is the frame's own, drawn for this frame alone: only there may a drawing be
    /// laid from another raster (a tile, a kept pass or a layer is kept, and drawn exactly).
    on_frame: bool,
    /// Drawings too large for the sprite texture, each rastered once into a texture of its own
    /// (Gpu::big, by drawing): the raster's key and place, and the rasters still to make (the
    /// drawing, its size, its scene placed in the texture).
    pub(crate) big: HashMap<u32, (SpriteKey, Slot)>,
    big_fresh: Vec<(u32, u32, u32, Scene)>,
    /// The texture the last sprite laid samples: the sprite texture, or a large drawing's.
    laid_in: Tex,
}

#[derive(Clone, Copy)]
struct Last { version: u32, sx: f64, sy: f64, px: f64, py: f64, slot: Slot, m: [f64; 6] }

impl Default for Sprites {
    fn default() -> Sprites {
        Sprites { slots: HashMap::new(), shelves: Shelves { side: SPRITE_SIDE, ..Default::default() }, pending: Scene::new(),
            fresh: Vec::new(), versions: HashMap::new(), last: HashMap::new(), exact_only: false, sampled: Vec::new(), on_frame: false,
            big: HashMap::new(), big_fresh: Vec::new(), laid_in: Tex::Sprites }
    }
}

/// A drawing larger than this (device pixels, either side) is not rastered into the sprite
/// texture, but into a texture of its own, up to BIG_MAX.
const SPRITE_MAX: f64 = 1100.0;
const BIG_MAX: f64 = 4096.0;

#[derive(Default)]
pub(crate) struct Atlas {
    slots: HashMap<GlyphKey, Slot>,
    shelves: Shelves,
    /// Glyphs placed since the atlas was last drawn: their scene (atlas coordinates) and slots.
    pending: Scene,
    fresh: Vec<Slot>,
    pub(crate) counts: Counts,
    /// Plans made (top level), and for each face at each exact device size the plan it was
    /// last asked for in and in how many plans running: a size that holds is a size text
    /// rests at, rastered exactly; one that does not is text scaling, drawn from a step of
    /// a ladder of sizes (BUCKETS a doubling) scaled by under 2%.
    plan_no: u32,
    sizes: HashMap<(u64, u32), (u32, u32)>,
    /// A line just laid was drawn from a step of the ladder, not exactly (not to be kept).
    inexact: bool,
}

const BUCKETS: f32 = 16.0;

impl Atlas {
    pub(crate) fn plan_no(&self) -> u32 { self.plan_no }
    fn reset(&mut self) {
        self.slots.clear();
        self.shelves.clear();
        self.pending.reset();
        self.fresh.clear();
    }
}

// ── the plan ───────────────────────────────────────────────────────────────────────

/// How a line's glyphs are filled: a colour, or a linear gradient (device-space end points,
/// first stop, stop count).
enum Fill7 { Solid([f32; 4]), Gradient([f32; 4], f32, f32) }

/// Which texture an instance samples.
#[derive(Clone, Copy, PartialEq)]
enum Tex { None, Image(u32), Kept(u32), Bitmap(u32), Work(usize), Target, Group(usize), Sprites, Big(u32), KeptGroup(u32) }

enum Seg {
    /// Instances (INST floats each), as runs that sample one texture.
    Quads { data: Vec<f32>, runs: Vec<(u32, u32, Tex)>, items: Vec<Item>, union: Rect },
    /// A Vello batch; `backdrop`: a blend group, which needs what lies beneath it, with the
    /// clips open around it (the copy of what lies beneath is drawn inside them).
    Vello { scene: Scene, items: Vec<Item>, union: Rect, backdrop: Option<Vec<(Affine, RoundedRect)>> },
}

/// Where an item draws: its bounds, less a hole it leaves untouched (a border's inside;
/// Rect::ZERO when none) — an icon inside a button's border does not overlap the border.
#[derive(Clone, Copy)]
struct Item { r: Rect, hole: Rect }

fn holds(h: Rect, r: Rect) -> bool { !h.is_zero_area() && h.x0 <= r.x0 && h.y0 <= r.y0 && h.x1 >= r.x1 && h.y1 >= r.y1 }

impl Seg {
    fn union(&self) -> Rect { match self { Seg::Quads { union, .. } | Seg::Vello { union, .. } => *union } }
    fn items(&self) -> &[Item] { match self { Seg::Quads { items, .. } | Seg::Vello { items, .. } => items } }
}

/// Does item `i` draw where `b` does?
fn clash(i: &Item, b: Item) -> bool { meets(i.r, b.r) && !holds(i.hole, b.r) && !holds(b.hole, i.r) }

/// A segment's items by the cells of a coarse device grid they touch, so an overlap test
/// looks only at the items near it; an item over many cells is in `wide`, tested always.
#[derive(Default)]
struct Grid { cells: HashMap<(i32, i32), Vec<u32>>, wide: Vec<u32> }

const CELL: f64 = 128.0;
const CELLS_MAX: i64 = 64;

impl Grid {
    /// The cells `r` touches (first and last column, first and last row), or None when many.
    fn span(r: Rect) -> Option<(i32, i32, i32, i32)> {
        let (x0, y0) = ((r.x0 / CELL).floor() as i64, (r.y0 / CELL).floor() as i64);
        let (x1, y1) = (((r.x1 / CELL).ceil() as i64 - 1).max(x0), ((r.y1 / CELL).ceil() as i64 - 1).max(y0));
        if (x1 - x0 + 1) * (y1 - y0 + 1) > CELLS_MAX { return None; }
        Some((x0 as i32, y0 as i32, x1 as i32, y1 as i32))
    }
    fn add(&mut self, k: u32, r: Rect) {
        match Self::span(r) {
            None => self.wide.push(k),
            Some((x0, y0, x1, y1)) => for y in y0..=y1 { for x in x0..=x1 { self.cells.entry((x, y)).or_default().push(k); } },
        }
    }
    /// Does any of `items` (this grid's) clash with `b`?
    fn clashes(&self, items: &[Item], b: Item) -> bool {
        if self.wide.iter().any(|&k| clash(&items[k as usize], b)) { return true; }
        match Self::span(b.r) {
            None => items.iter().any(|i| clash(i, b)),
            Some((x0, y0, x1, y1)) => (y0..=y1).any(|y| (x0..=x1).any(|x|
                self.cells.get(&(x, y)).is_some_and(|v| v.iter().any(|&k| clash(&items[k as usize], b))))),
        }
    }
}

impl Plan {
    /// A plan of nothing (a pass that only lays the base colour).
    fn empty() -> Plan {
        let mut clips = vec![0.0; CLIP];
        clips[16..20].copy_from_slice(&[-1e7, -1e7, 1e7, 1e7]);
        Plan { segs: Vec::new(), groups: Vec::new(), clips, stops: vec![0.0; 4] }
    }
}

pub(crate) struct Plan {
    segs: Vec<Seg>,
    /// Opacity groups: each planned on its own, drawn into a texture of its rect (integer
    /// device pixels) before the plan, and laid by a copy instance sampling Tex::Group.
    groups: Vec<(Plan, Rect, Option<u32>)>,
    clips: Vec<f32>,
    stops: Vec<f32>,
}

/// A clip the walk is inside: its record, the device rect it can still show (culling), the
/// rect of the plain-rectangle clips (the record's aabb), its nearest shape record, and
/// what it was made from (to open it again around a Vello item).
#[derive(Clone, Copy)]
struct Frame { rec: u32, cull: Rect, aa: Rect, head: u32, m: Affine, shape: RoundedRect }

/// A shift by whole device pixels: what is drawn moved by it is the same pixels.
pub(crate) fn whole_px(d: f64) -> bool { (d - d.round()).abs() < 1e-6 }
fn meets(a: Rect, b: Rect) -> bool { a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0 }
fn empty(r: Rect) -> bool { !(r.x1 > r.x0 && r.y1 > r.y0) }
const EVERYWHERE: Rect = Rect::new(-1e7, -1e7, 1e7, 1e7);
/// How many segments back an item looks for one to join.
const SCAN_MAX: usize = 64;

/// The numbers after a command's code and transform.
pub(crate) fn arg_len(code: u32, c: &[f64], i: usize) -> usize {
    let at = |k: usize| c.get(i + k).copied().unwrap_or(0.0) as usize;
    match code {
        0 => 9, 1 => 14 + 2 * at(13), 2 => 10, 3 => 7, 4 => 9, 6 => 1, 7 => 4, 8 => 9 + 2 * at(8),
        9 => { let pn = at(1); 3 + pn + c.get(i + 2 + pn).copied().unwrap_or(0.0) as usize }
        10 => 2 + at(1), 11 => 10, 12 => 1, 13 => 1, 14 => 5, 15 => 5, 16 => 13, 17 => 3, 18 => 0, 19 => 6,
        _ => usize::MAX,
    }
}

fn is_push(code: u32) -> bool { matches!(code, 4 | 10 | 12 | 13) }

/// Where the command at `i` (its code) ends, with what it opens up to its pop.
fn group_end(c: &[f64], mut i: usize) -> usize {
    let mut depth = 0i32;
    while i < c.len() {
        let code = c[i] as u32;
        i += 1;
        if code == 5 { depth -= 1; if depth <= 0 { return i; } continue; }
        let n = arg_len(code, c, i + 6);
        if n == usize::MAX { return c.len(); }
        i += 6 + n;
        if is_push(code) { depth += 1; }
        if depth == 0 { return i; }
    }
    c.len()
}

fn rgba_f(c: u32) -> [f32; 4] {
    [((c >> 24) & 255) as f32 / 255.0, ((c >> 16) & 255) as f32 / 255.0, ((c >> 8) & 255) as f32 / 255.0, (c & 255) as f32 / 255.0]
}

struct Builder {
    segs: Vec<Seg>,
    /// Each segment's items by place (beside `segs`).
    grids: Vec<Grid>,
    groups: Vec<(Plan, Rect, Option<u32>)>,
    clips: Vec<f32>,
    stops: Vec<f32>,
    stack: Vec<Option<Frame>>,
    area: Rect,
    /// The view, generation and (a moving layer's) reach command 19 gave the group that follows it.
    group_key: Option<(u32, f64, Rect)>,
    /// This plan keeps what kept subtrees plan to (the frame's own plan; not a group's, a
    /// tile's or a layer's), and the subtrees being recorded, innermost last.
    keeps: bool,
    rec: Vec<Recorder>,
}

/// A kept subtree's plan as it is made (between its marks, 17 and 18): its items, and where
/// its clip records begin. `ok` false: it holds what cannot be replayed (a Vello item, an
/// opacity group, a drawing, gradient stops), and is not kept.
struct Recorder { key: u32, entry: Entry, clip_base: u32, stops_base: usize, block: Block, ok: bool }

/// Instances as one block: their numbers, their runs (instance ranges and the texture each
/// samples), and the union of where they draw.
#[derive(Default)]
pub(crate) struct Block { insts: Vec<f32>, runs: Vec<(u32, u32, Tex)>, union: Rect }
impl Block {
    fn add(&mut self, b: Rect, insts: &[f32], runs: &[(u32, u32, Tex)]) {
        let base = (self.insts.len() / INST) as u32;
        self.insts.extend_from_slice(insts);
        for &(s, e, t) in runs {
            match self.runs.last_mut() {
                Some(r) if r.1 == s + base && (r.2 == t || t == Tex::None) => r.1 = e + base,
                _ => self.runs.push((s + base, e + base, t)),
            }
        }
        self.union = if self.union.is_zero_area() { b } else { self.union.union(b) };
    }
}

/// What a kept subtree's plan was made under: its generation (the host's: anything in it
/// changed), its transform, the clip around it (cull, plain-rectangle reach, record, nearest
/// shape record), and the atlases' and text's epoch. Its plan is replayed under the same again,
/// its clip records renumbered, inside a cull within the one it was made under (what it holds
/// past the cull, the frame's region cuts).
#[derive(Clone, Copy)]
pub(crate) struct Entry { stands: f64, m: [f64; 6], cull: [f64; 4], aa: [f64; 4], rec: u32, head: u32, epoch: (u32, u32) }

impl Entry {
    fn holds(&self, e: &Entry) -> bool {
        self.stands == e.stands && self.m == e.m && self.aa == e.aa && self.epoch == e.epoch
            && self.cull[0] <= e.cull[0] && self.cull[1] <= e.cull[1] && self.cull[2] >= e.cull[2] && self.cull[3] >= e.cull[3]
    }
}

/// What a view's opacity group was drawn under: its subtree's generation (the host's), the
/// group's transform, the cull around it, the engine's text generation. The same again, the
/// group is laid from its kept texture (the Gpu's `groups`), over its rect `r`.
#[derive(Clone, Copy, PartialEq)]
struct GroupEntry { stands: f64, m: [f64; 6], area: [f64; 4], generation: u32 }
/// `whole`: nothing of it was cut by the cull, so it can be laid moved (the same but for a
/// translation) wherever the group goes — a moving layer's frames.
pub(crate) struct KeptGroup { entry: GroupEntry, r: Rect, whole: bool, used: u32 }

/// A moving layer's key among the kept groups (host walk.rs): the view's id with this bit.
const MOTION_KEY: u32 = 0x8000_0000;

/// The largest group kept, in pixels (a texture's worth, 4096²).
const GROUP_KEPT_MAX: f64 = 4096.0 * 4096.0;

/// Can a group's contents be kept as drawn: nothing in them changes without its view's
/// generation changing — no layer (a frost reads what is beneath it) and no video frame.
pub(crate) fn bakeable(c: &[f64]) -> bool {
    let mut i = 0;
    while i < c.len() {
        let code = c[i] as u32;
        i += 1;
        if code == 5 { continue; }
        let n = arg_len(code, c, i + 6);
        if n == usize::MAX || code == 15 { return false; }
        if code == 11 && (crate::host::MEDIA_KEY..crate::host::MEDIA_KEY + 0x100_0000).contains(&(c[i + 6] as u32)) { return false; }
        i += 6 + n;
    }
    true
}

/// A kept subtree's plan: its clip records (from `clip_base`) and its instances as one block
/// (clip numbers as made), laid again as one item over their union — which keeps their order
/// with everything they could overlap. `block` None: under this entry it holds what cannot be
/// replayed, and is not recorded again until the entry changes.
pub(crate) struct Kept { entry: Entry, clip_base: u32, clips: Vec<f32>, block: Option<Block>, used: u32 }

impl Builder {
    /// A kept block laid as one item over its union.
    fn quads_block(&mut self, bk: &Block, insts: &[f32], cull: Rect) {
        if insts.is_empty() { return; }
        for r in self.rec.iter_mut() { if r.ok { r.block.add(bk.union, insts, &bk.runs); } }
        let item = Item { r: bk.union.intersect(cull), hole: Rect::ZERO };
        let k = self.quad_seg(item);
        let Seg::Quads { data, runs, items, union } = &mut self.segs[k] else { return };
        self.grids[k].add(items.len() as u32, bk.union);
        let start = (data.len() / INST) as u32;
        data.extend_from_slice(insts);
        for &(s, e, t) in &bk.runs {
            match runs.last_mut() {
                Some(r) if r.1 == s + start && (r.2 == t || t == Tex::None) => r.1 = e + start,
                Some(r) if r.2 == Tex::None && r.1 == s + start => { r.1 = e + start; r.2 = t; }
                _ => runs.push((s + start, e + start, t)),
            }
        }
        items.push(item);
        *union = if union.is_zero_area() { bk.union } else { union.union(bk.union) };
    }

    /// What is being recorded holds something that cannot be replayed.
    fn unkeepable(&mut self) { for r in self.rec.iter_mut() { r.ok = false; } }

    fn top(&self) -> Option<Frame> { self.stack.iter().rev().find_map(|f| *f) }
    fn cull(&self) -> Rect { self.top().map_or(self.area, |f| f.cull) }
    fn clip_rec(&self) -> u32 { self.top().map_or(0, |f| f.rec) }

    /// Open a clip: the rounded box under `m`.
    fn push_clip(&mut self, m: Affine, shape: RoundedRect) -> Frame {
        let parent = self.top();
        let [a, b, c, d, _, _] = m.as_coeffs();
        let axis = b.abs() < 1e-9 && c.abs() < 1e-9;
        let r = shape.radii();
        let rounded = r.top_left > 0.0 || r.top_right > 0.0 || r.bottom_right > 0.0 || r.bottom_left > 0.0;
        let is_shape = !axis || rounded;
        let dev = m.transform_rect_bbox(shape.rect());
        let cull = parent.map_or(self.area, |p| p.cull).intersect(dev);
        let paa = parent.map_or(EVERYWHERE, |p| p.aa);
        let aa = if is_shape { paa } else { paa.intersect(dev) };
        let phead = parent.map_or(0, |p| p.head);
        let rec = (self.clips.len() / CLIP) as u32;
        let inv = m.inverse().as_coeffs();
        let s = (a * d - b * c).abs().sqrt();
        let rr = shape.rect();
        self.clips.extend_from_slice(&[
            inv[0] as f32, inv[1] as f32, inv[2] as f32, inv[3] as f32,
            inv[4] as f32, inv[5] as f32, s as f32, phead as f32,
            rr.x0 as f32, rr.y0 as f32, rr.width() as f32, rr.height() as f32,
            r.top_left as f32, r.top_right as f32, r.bottom_right as f32, r.bottom_left as f32,
            aa.x0 as f32, aa.y0 as f32, aa.x1 as f32, aa.y1 as f32,
            if is_shape { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0,
        ]);
        let f = Frame { rec, cull, aa, head: if is_shape { rec } else { phead }, m, shape };
        self.stack.push(Some(f));
        f
    }

    /// Does segment `k` draw anywhere item `b` does?
    fn overlaps(&self, k: usize, b: Item) -> bool {
        let s = &self.segs[k];
        meets(s.union(), b.r) && self.grids[k].clashes(s.items(), b)
    }

    /// The earliest segment item `b` can join: of its kind (`fits`), reached from the end
    /// without passing a segment that draws where `b` does (that one it may still join, at
    /// its end). Drawn there, `b` keeps its order with everything it overlaps, so the items
    /// of one kind gather into few segments: a map's tile fills in one, the charts over them
    /// in one Vello batch, their labels in one. None: a new segment.
    fn earliest(&self, b: Item, fits: impl Fn(&Seg) -> bool, barrier: impl Fn(&Seg) -> bool) -> Option<usize> {
        let mut found = None;
        let mut j = self.segs.len();
        let stop = j.saturating_sub(SCAN_MAX);
        while j > stop {
            let k = j - 1;
            let s = &self.segs[k];
            if barrier(s) { break; }
            if fits(s) { found = Some(k); }
            if self.overlaps(k, b) { break; }
            j -= 1;
        }
        found
    }

    fn quad_seg(&mut self, b: Item) -> usize {
        if let Some(k) = self.earliest(b, |s| matches!(s, Seg::Quads { .. }), |_| false) { return k; }
        self.segs.push(Seg::Quads { data: Vec::new(), runs: Vec::new(), items: Vec::new(), union: Rect::ZERO });
        self.grids.push(Grid::default());
        self.segs.len() - 1
    }

    fn vello_seg(&mut self, b: Item, backdrop: bool) -> usize {
        if !backdrop {
            let found = self.earliest(b, |s| matches!(s, Seg::Vello { backdrop: None, .. }),
                |s| matches!(s, Seg::Vello { backdrop: Some(_), .. }));
            if let Some(k) = found { return k; }
        }
        self.segs.push(Seg::Vello { scene: Scene::new(), items: Vec::new(), union: Rect::ZERO, backdrop: backdrop.then(Vec::new) });
        self.grids.push(Grid::default());
        self.segs.len() - 1
    }

    /// Add instances (whole INST floats) sampling `tex`, as one item over `b`.
    fn quads(&mut self, b: Rect, insts: &[f32], tex: Tex) {
        self.quads_holed(b, Rect::ZERO, insts, tex);
    }

    /// As `quads`, for an item that leaves `hole` untouched.
    fn quads_holed(&mut self, b: Rect, hole: Rect, insts: &[f32], tex: Tex) {
        if insts.is_empty() { return; }
        let n = (insts.len() / INST) as u32;
        for r in self.rec.iter_mut() { if r.ok { r.block.add(b, insts, &[(0, n, tex)]); } }
        let item = Item { r: b, hole };
        let k = self.quad_seg(item);
        let Seg::Quads { data, runs, items, union } = &mut self.segs[k] else { return };
        self.grids[k].add(items.len() as u32, b);
        let start = (data.len() / INST) as u32;
        data.extend_from_slice(insts);
        let end = (data.len() / INST) as u32;
        match runs.last_mut() {
            Some(r) if r.2 == tex || tex == Tex::None => r.1 = end,
            Some(r) if r.2 == Tex::None && r.1 == start => { r.1 = end; r.2 = tex; }
            _ => runs.push((start, end, tex)),
        }
        items.push(item);
        *union = if union.is_zero_area() { b } else { union.union(b) };
    }
}

/// Does clip `f` hold device rect `r` whole (a rect under a transform that keeps axes, its
/// corners' reach set aside)?
fn clip_holds(f: &Frame, r: Rect) -> bool {
    let [_, b, c, _, _, _] = f.m.as_coeffs();
    if b.abs() > 1e-9 || c.abs() > 1e-9 { return false; }
    let rd = f.shape.radii();
    let k = rd.top_left.max(rd.top_right).max(rd.bottom_right).max(rd.bottom_left);
    let inner = f.m.transform_rect_bbox(f.shape.rect().inflate(-k, -k));
    holds(inner, r)
}

/// A border's hole in device space: its inside (widths top, right, bottom, left) less its
/// corners, when `m` keeps axes; Rect::ZERO otherwise.
fn border_hole(m: Affine, x: f64, y: f64, w: f64, h: f64, widths: [f64; 4], radii: &[f64]) -> Rect {
    let [_, b, c, _, _, _] = m.as_coeffs();
    if b.abs() > 1e-9 || c.abs() > 1e-9 { return Rect::ZERO; }
    let r = radii.iter().fold(0.0f64, |a, v| a.max(*v));
    let inner = Rect::new(x + widths[3] + r, y + widths[0] + r, x + w - widths[1] - r, y + h - widths[2] - r);
    if inner.width() <= 2.0 || inner.height() <= 2.0 { return Rect::ZERO; }
    m.transform_rect_bbox(inner).inflate(-1.0, -1.0)
}

#[allow(clippy::too_many_arguments)]
fn inst(out: &mut Vec<f32>, kind: f32, m: Affine, clip: u32, rect: [f64; 4], radii: [f64; 4], col: [f32; 4], p0: [f32; 4], p1: [f32; 4]) {
    let k = m.as_coeffs();
    out.extend_from_slice(&[
        k[0] as f32, k[1] as f32, k[2] as f32, k[3] as f32,
        k[4] as f32, k[5] as f32, kind, clip as f32,
        rect[0] as f32, rect[1] as f32, rect[2].max(0.0) as f32, rect[3].max(0.0) as f32,
        radii[0] as f32, radii[1] as f32, radii[2] as f32, radii[3] as f32,
        col[0], col[1], col[2], col[3],
        p0[0], p0[1], p0[2], p0[3],
        p1[0], p1[1], p1[2], p1[3],
    ]);
}

impl Engine {
    /// Plan commands `c` (under `self.offset`) over `area`, in the destination's coordinates.
    pub(crate) fn plan(&mut self, c: &[f64], area: Rect) -> Plan {
        if self.atlas.slots.len() > 6000 || self.atlas.shelves.full() { self.atlas.reset(); self.atlas.counts.resets += 1; self.plan_epoch += 1; }
        if self.sprites.slots.len() > 2000 || self.sprites.shelves.full() {
            self.atlas.counts.sprite_resets += 1;
            self.plan_epoch += 1;
            self.sprites.slots.clear(); self.sprites.shelves.clear(); self.sprites.pending.reset(); self.sprites.fresh.clear();
            self.sprites.last.clear();
        }
        self.atlas.counts.plans += 1;
        self.atlas.plan_no += 1;
        if self.atlas.sizes.len() > 4096 { self.atlas.sizes.clear(); }
        // kept plans not replayed lately go
        let no = self.atlas.plan_no;
        if no % 256 == 0 { self.kept_plans.retain(|_, k| no.wrapping_sub(k.used) < 512); }
        // and kept groups, with their textures
        if no % 32 == 0 {
            self.kept_groups.retain(|_, k| no.wrapping_sub(k.used) < 128);
            if let Some(g) = self.gpu.as_mut() {
                let gone: Vec<u32> = g.groups.keys().filter(|v| !self.kept_groups.contains_key(v)).copied().collect();
                for v in gone { if let Some(t) = g.groups.remove(&v) { g.pool.give(t); } }
            }
        }
        let keeps = self.sprites.on_frame && self.keep_plans;
        self.plan_with(c, area, keeps)
    }

    fn plan_in(&mut self, c: &[f64], area: Rect) -> Plan { self.plan_with(c, area, false) }

    /// `plan`'s walk (a group's contents are planned by it too).
    fn plan_with(&mut self, c: &[f64], area: Rect, keeps: bool) -> Plan {
        let mut b = Builder { segs: Vec::new(), grids: Vec::new(), groups: Vec::new(), clips: vec![0.0; CLIP], stops: vec![0.0; 4], stack: Vec::new(), area,
            group_key: None, keeps, rec: Vec::new() };
        // record 0: no clip (its aabb everywhere)
        b.clips[16..20].copy_from_slice(&[-1e7, -1e7, 1e7, 1e7]);
        let mut scratch: Vec<f32> = Vec::with_capacity(INST * 64);
        let n = c.len();
        let mut i = 0;
        while i < n {
            let start = i;
            let code = c[i] as u32;
            i += 1;
            if code == 5 { b.stack.pop(); continue; }
            if i + 6 > n { break; }
            let m = self.offset * crate::affine(&c[i..i + 6]);
            i += 6;
            let len = arg_len(code, c, i);
            if len == usize::MAX || i + len > n { break; }
            let a = &c[i..i + len];
            i += len;
            let cull = b.cull();
            let clip = b.clip_rec();
            scratch.clear();
            match code {
                // a kept subtree: replayed when made under the same entry, else recorded
                17 if b.keeps => {
                    let (key, len) = (a[0] as u32, a[2] as usize);
                    let top = b.top();
                    let entry = Entry { stands: a[1], m: m.as_coeffs(), cull: [cull.x0, cull.y0, cull.x1, cull.y1],
                        aa: top.map_or([-1e7, -1e7, 1e7, 1e7], |f| [f.aa.x0, f.aa.y0, f.aa.x1, f.aa.y1]), rec: clip,
                        head: top.map_or(0, |f| f.head), epoch: (self.plan_epoch, self.generation) };
                    let no = self.atlas.plan_no;
                    // a mark without its span (its subtree cut across passes) is not replayed
                    match self.kept_plans.get_mut(&key).filter(|k| k.entry.holds(&entry) && len > 0) {
                        Some(k) if k.block.is_some() => {
                            k.used = no;
                            let base = (b.clips.len() / CLIP) as u32;
                            for r in k.clips.chunks_exact(CLIP) {
                                let at = b.clips.len();
                                b.clips.extend_from_slice(r);
                                let ph = r[7] as u32;
                                if ph >= k.clip_base { b.clips[at + 7] = (ph - k.clip_base + base) as f32; } else if ph == k.entry.head { b.clips[at + 7] = entry.head as f32; }
                            }
                            let bk = k.block.as_ref().unwrap();
                            let mut v = bk.insts.clone();
                            let (cb, ext) = (k.clip_base, k.entry.rec);
                            for q in v.chunks_exact_mut(INST) {
                                let u = q[7] as u32;
                                if u >= cb { q[7] = (u - cb + base) as f32; } else if u == ext { q[7] = clip as f32; }
                            }
                            b.quads_block(bk, &v, cull);
                            self.atlas.counts.kept_plans += 1;
                            i += len;
                        }
                        // known not to keep under this entry: planned as it comes
                        Some(k) => {
                            k.used = no;
                            b.rec.push(Recorder { key, entry, clip_base: 0, stops_base: 0, block: Block::default(), ok: false });
                        }
                        None => b.rec.push(Recorder { key, entry, clip_base: (b.clips.len() / CLIP) as u32, stops_base: b.stops.len(), block: Block::default(), ok: true }),
                    }
                }
                18 if b.keeps => {
                    if let Some(r) = b.rec.pop() {
                        let keep = r.ok && b.stops.len() == r.stops_base;
                        let clips = if keep { b.clips[r.clip_base as usize * CLIP..].to_vec() } else { Vec::new() };
                        if keep { self.atlas.counts.kept_recorded += 1; }
                        self.kept_plans.insert(r.key, Kept { entry: r.entry, clip_base: r.clip_base, clips, block: keep.then_some(r.block), used: self.atlas.plan_no });
                    }
                }
                17 | 18 => {}
                19 => b.group_key = Some((a[0] as u32, a[1], Rect::new(a[2], a[3], a[4], a[5]))),
                4 if a[0] >= 1.0 && b.group_key.is_none() => {
                    if a[3] < 0.0 { b.stack.push(None); } else { b.push_clip(m, rrect(a[1], a[2], a[3], a[4], &a[5..9])); }
                }
                4 => {
                    // an opacity group: its contents planned on their own, drawn into a texture
                    // and laid with its alpha, under the clips around it and its own — a view's
                    // group laid from the texture kept while its subtree stands (KeptGroup)
                    b.unkeepable();
                    let key = b.group_key.take();
                    let end = group_end(c, start);
                    let own = a[3] >= 0.0;
                    if own { b.push_clip(m, rrect(a[1], a[2], a[3], a[4], &a[5..9])); }
                    let area = b.cull();
                    let rec = b.clip_rec();
                    if own { b.stack.pop(); }
                    i = end;
                    if empty(area) { continue; }
                    let entry = GroupEntry { stands: key.map_or(-1.0, |k| k.1), m: m.as_coeffs(), area: [area.x0, area.y0, area.x1, area.y1], generation: self.generation };
                    let blit = |s: &mut Vec<f32>, r: Rect| inst(s, K_BLIT, Affine::IDENTITY, rec, [r.x0, r.y0, r.width(), r.height()], [0.0; 4], [0.0, 0.0, 0.0, a[0] as f32], [0.0, 0.0, 1.0, 0.0], [0.0; 4]);
                    if let Some((view, ..)) = key {
                        let have = self.gpu.as_ref().is_some_and(|g| g.groups.contains_key(&view));
                        // laid moved: a moving layer (the host's, drawn exactly again once it rests)
                        // anywhere, any group by whole device pixels (a scroll), the same pixels
                        let moved = |k: &KeptGroup| k.whole && k.entry.stands == entry.stands && k.entry.generation == entry.generation && k.entry.m[..4] == entry.m[..4]
                            && (view & MOTION_KEY != 0 || (whole_px(entry.m[4] - k.entry.m[4]) && whole_px(entry.m[5] - k.entry.m[5])));
                        if let Some(k) = self.kept_groups.get_mut(&view).filter(|k| have && (k.entry == entry || moved(k))) {
                            k.used = self.atlas.plan_no;
                            let (dx, dy) = (entry.m[4] - k.entry.m[4], entry.m[5] - k.entry.m[5]);
                            let r = Rect::new(k.r.x0 + dx, k.r.y0 + dy, k.r.x1 + dx, k.r.y1 + dy);
                            blit(&mut scratch, r);
                            b.quads(r, &scratch, Tex::KeptGroup(view));
                            self.atlas.counts.kept_groups += 1;
                            continue;
                        }
                    }
                    let inner = &c[start + 16..end.saturating_sub(1).max(start + 16)];
                    // a moving layer is made over all it draws, wherever the frame's region is:
                    // the clips around it and the region cut it where it is laid
                    let motion = key.is_some_and(|k| k.0 & MOTION_KEY != 0);
                    let area = match key { Some((_, _, reach)) if motion => reach.inflate(2.0, 2.0), _ => area };
                    let sub = self.plan_in(inner, area);
                    let mut u = Rect::ZERO;
                    for sg in &sub.segs { if !sg.union().is_zero_area() { u = if u.is_zero_area() { sg.union() } else { u.union(sg.union()) }; } }
                    // (a moving layer's area is the reach of all it draws: nothing of it is cut)
                    let whole = motion || (u.x0 > area.x0 && u.y0 > area.y0 && u.x1 < area.x1 && u.y1 < area.y1);
                    let u = u.intersect(area);
                    if empty(u) { continue; }
                    let r = Rect::new(u.x0.floor(), u.y0.floor(), u.x1.ceil(), u.y1.ceil());
                    let keep = key.map(|k| k.0).filter(|_| self.keep_plans && r.width() * r.height() <= GROUP_KEPT_MAX && bakeable(inner));
                    match (keep, key) {
                        (Some(view), _) => {
                            self.kept_groups.insert(view, KeptGroup { entry, r, whole, used: self.atlas.plan_no });
                            self.atlas.counts.groups_made += 1;
                        }
                        (None, Some((view, ..))) => { self.kept_groups.remove(&view); }
                        _ => {}
                    }
                    blit(&mut scratch, r);
                    b.groups.push((sub, r, keep));
                    let k = b.groups.len() - 1;
                    b.quads(r, &scratch, Tex::Group(k));
                }
                10 | 12 | 13 => {
                    let end = group_end(c, start);
                    let bound = cull;
                    self.vello_item_as(&mut b, &c[start..end], bound.intersect(cull), code == 13 && a[0] != 0.0);
                    i = end;
                }
                0 | 2 => {
                    let r = Rect::new(a[0], a[1], a[0] + a[2], a[1] + a[3]);
                    let bb = m.transform_rect_bbox(r).inflate(1.0, 1.0).intersect(cull);
                    if empty(bb) { continue; }
                    let wd = a[8] as f32;
                    let (kind, col, p0) = if code == 0 { (K_FILL, a[8] as u32, [0.0; 4]) } else { (K_BORDER, a[9] as u32, [wd, wd, wd, wd]) };
                    inst(&mut scratch, kind, m, clip, [a[0], a[1], a[2], a[3]], [a[4], a[5], a[6], a[7]], rgba_f(col), p0, [0.0; 4]);
                    let hole = if code == 2 { border_hole(m, a[0], a[1], a[2], a[3], [a[8]; 4], &a[4..8]) } else { Rect::ZERO };
                    b.quads_holed(bb, hole, &scratch, Tex::None);
                }
                1 => {
                    let (x, y, w, h) = (a[0], a[1], a[2], a[3]);
                    let bb = m.transform_rect_bbox(Rect::new(x, y, x + w, y + h)).inflate(1.0, 1.0).intersect(cull);
                    if empty(bb) { continue; }
                    let kind = a[8] as u32;
                    let (angle, cx, cy, radius) = (a[9], a[10], a[11], a[12]);
                    let raw: Vec<(f32, u32)> = a[14..].chunks_exact(2).map(|p| (p[0] as f32, p[1] as u32)).collect();
                    let centre = (x + w * cx, y + h * cy);
                    let (geom, stops) = match kind {
                        1 => {
                            let far = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)].iter()
                                .map(|(px, py)| ((px - centre.0).powi(2) + (py - centre.1).powi(2)).sqrt()).fold(0.0, f64::max);
                            ([centre.0, centre.1, far * radius, 0.0], raw)
                        }
                        2 => ([centre.0, centre.1, 0.0, 0.0], crate::sweep_stops((angle - 90.0).to_radians(), &raw)),
                        _ => {
                            let t = angle.to_radians();
                            let (dx, dy) = (t.sin(), -t.cos());
                            let half = (w * dx.abs() + h * dy.abs()) / 2.0;
                            let mid = (x + w / 2.0, y + h / 2.0);
                            ([mid.0 - dx * half, mid.1 - dy * half, mid.0 + dx * half, mid.1 + dy * half], raw)
                        }
                    };
                    let s0 = (b.stops.len() / 4) as f32;
                    for (o, col) in &stops {
                        let f = rgba_f(*col);
                        b.stops.extend_from_slice(&[*o, 0.0, 0.0, 0.0, f[0] * f[3], f[1] * f[3], f[2] * f[3], f[3]]);
                    }
                    inst(&mut scratch, K_GRADIENT, m, clip, [x, y, w, h], [a[4], a[5], a[6], a[7]], [0.0; 4],
                        [geom[0] as f32, geom[1] as f32, geom[2] as f32, geom[3] as f32], [s0, stops.len() as f32, kind.min(2) as f32, 0.0]);
                    b.quads(bb, &scratch, Tex::None);
                }
                3 => {
                    let r = Rect::new(a[0], a[1], a[0] + a[2], a[1] + a[3]);
                    let std = (a[5] / 2.0).max(0.01);
                    let bb = m.transform_rect_bbox(r.inflate(std * 2.5 + 1.0, std * 2.5 + 1.0)).intersect(cull);
                    if empty(bb) { continue; }
                    inst(&mut scratch, K_SHADOW, m, clip, [a[0], a[1], a[2], a[3]], [0.0; 4], rgba_f(a[6] as u32), [std as f32, a[4] as f32, 0.0, 0.0], [0.0; 4]);
                    b.quads(bb, &scratch, Tex::None);
                }
                16 => {
                    // a border whose sides differ in width (one colour): widths top, right, bottom, left
                    let r = Rect::new(a[0], a[1], a[0] + a[2], a[1] + a[3]);
                    let bb = m.transform_rect_bbox(r).inflate(1.0, 1.0).intersect(cull);
                    if empty(bb) { continue; }
                    inst(&mut scratch, K_BORDER, m, clip, [a[0], a[1], a[2], a[3]], [a[4], a[5], a[6], a[7]], rgba_f(a[12] as u32),
                        [a[8] as f32, a[9] as f32, a[10] as f32, a[11] as f32], [0.0; 4]);
                    let hole = border_hole(m, a[0], a[1], a[2], a[3], [a[8], a[9], a[10], a[11]], &a[4..8]);
                    b.quads_holed(bb, hole, &scratch, Tex::None);
                }
                7 | 8 => {
                    let Some(s) = self.lines.get(a[0] as usize).cloned() else { continue };
                    let t = m * Affine::translate((a[1], a[2]));
                    let bb = t.transform_rect_bbox(Self::line_rect(&s)).intersect(cull);
                    if empty(bb) { continue; }
                    let fill = if code == 7 { Fill7::Solid(rgba_f(a[3] as u32)) } else {
                        // the ramp laid over the box (bx, by, bw, bh) at the CSS angle, in device space
                        let (x, y, w, h, angle) = (a[3], a[4], a[5], a[6], a[7]);
                        let tr = angle.to_radians();
                        let (dx, dy) = (tr.sin(), -tr.cos());
                        let half = (w * dx.abs() + h * dy.abs()) / 2.0;
                        let mid = (x + w / 2.0, y + h / 2.0);
                        let p0 = m * vello::kurbo::Point::new(mid.0 - dx * half, mid.1 - dy * half);
                        let p1 = m * vello::kurbo::Point::new(mid.0 + dx * half, mid.1 + dy * half);
                        let s0 = (b.stops.len() / 4) as f32;
                        let n = (a[8] as usize).min((a.len() - 9) / 2);
                        for k in 0..n {
                            let f = rgba_f(a[10 + 2 * k] as u32);
                            b.stops.extend_from_slice(&[a[9 + 2 * k] as f32, 0.0, 0.0, 0.0, f[0] * f[3], f[1] * f[3], f[2] * f[3], f[3]]);
                        }
                        Fill7::Gradient([p0.x as f32, p0.y as f32, p1.x as f32, p1.y as f32], s0, n as f32)
                    };
                    self.atlas.inexact = false;
                    let laid = self.glyphs(&s, t, fill, clip, &mut scratch);
                    // text drawn from the ladder is drawn exactly once it holds: not kept before
                    if self.atlas.inexact { b.unkeepable(); }
                    if laid {
                        b.quads(bb, &scratch, Tex::None);
                    } else {
                        self.vello_item(&mut b, &c[start..i], bb);
                    }
                }
                11 => {
                    let handle = a[0] as u32;
                    let (dx, dy, dw, dh) = (a[1], a[2], a[3], a[4]);
                    let crop = a[5] != 0.0;
                    let (bw, bh) = (a[6], a[7]);
                    let quality = (a[8] as u32).min(2);
                    let tint = a[9] as u32;
                    let (tex, nw, nh) = if let Some(img) = self.images.get(&handle).map(|b| b.image.clone()) {
                        let ok = self.gpu.as_mut().is_some_and(|g| g.upload_image(handle, &img));
                        if !ok { self.vello_item(&mut b, &c[start..i], cull); continue; }
                        (Tex::Image(handle), img.width as f64, img.height as f64)
                    } else if let Some((t, _)) = self.gpu.as_ref().and_then(|g| g.bitmaps.get(&handle)) {
                        (Tex::Bitmap(handle), t.width() as f64, t.height() as f64)
                    } else { continue };
                    if nw <= 0.0 || nh <= 0.0 || dw <= 0.0 || dh <= 0.0 { continue; }
                    let mut bb = m.transform_rect_bbox(Rect::new(dx, dy, dx + dw, dy + dh)).inflate(1.0, 1.0).intersect(cull);
                    let mut rec = clip;
                    if crop {
                        let f = b.push_clip(m, RoundedRect::from_rect(Rect::new(0.0, 0.0, bw, bh), 0.0));
                        rec = f.rec;
                        bb = bb.intersect(f.cull);
                    }
                    if !empty(bb) {
                        let t = m * Affine::translate((dx, dy)) * Affine::scale_non_uniform(dw / nw, dh / nh);
                        let col = if tint == 0 { [0.0; 4] } else { rgba_f(tint) };
                        inst(&mut scratch, K_IMAGE, t, rec, [0.0, 0.0, nw, nh], [0.0; 4], col,
                            [nw as f32, nh as f32, quality as f32, 1.0], [if tint == 0 { 0.0 } else { 1.0 }, 0.0, 0.0, 0.0]);
                        b.quads(bb, &scratch, tex);
                    }
                    if crop { b.stack.pop(); }
                }
                15 => {
                    // a layer is made again each frame it shows, at its size then: not kept
                    b.unkeepable();
                    let id = a[0] as u32;
                    let Some((tk, _)) = self.gpu.as_ref().and_then(|g| g.kept.get(&id)) else { continue };
                    let (iw, ih) = (tk.width() as f64, tk.height() as f64);
                    let (x, y, w, h) = (a[1], a[2], a[3], a[4]);
                    let bb = m.transform_rect_bbox(Rect::new(x, y, x + w, y + h)).inflate(1.0, 1.0).intersect(cull);
                    if empty(bb) { continue; }
                    let t = m * Affine::translate((x, y)) * Affine::scale_non_uniform(w / iw, h / ih);
                    inst(&mut scratch, K_IMAGE, t, clip, [0.0, 0.0, iw, ih], [0.0; 4], [0.0; 4], [iw as f32, ih as f32, 1.0, 1.0], [0.0; 4]);
                    b.quads(bb, &scratch, Tex::Kept(id));
                }
                6 if { b.unkeepable(); self.sprite(a[0] as u32, m, clip, &mut scratch) } => {
                    let k = scratch.len() - INST;
                    let r = Rect::new(scratch[k + 8] as f64, scratch[k + 9] as f64, (scratch[k + 8] + scratch[k + 10]) as f64, (scratch[k + 9] + scratch[k + 11]) as f64);
                    let bb = r.intersect(cull);
                    if !empty(bb) { b.quads(bb, &scratch, self.sprites.laid_in); }
                }
                _ => {
                    // a path, a drawing, gradient or outlined text: Vello's
                    let bound = match code {
                        9 => {
                            let pn = a[1] as usize;
                            m.transform_rect_bbox(vello::kurbo::Shape::bounding_box(&crate::path(&a[2..2 + pn]))).inflate(2.0, 2.0)
                        }
                        6 => match self.picture_reach.get(&(a[0] as u32)) {
                            Some(r) => { self.atlas.counts.pictures += 1; m.transform_rect_bbox(*r).inflate(1.0, 1.0) }
                            None => cull,
                        },
                        8 | 14 => match self.lines.get(a[0] as usize) {
                            Some(s) => (m * Affine::translate((a[1], a[2]))).transform_rect_bbox(Self::line_rect(s)).inflate(a.get(3).copied().unwrap_or(0.0).abs() + 2.0, 2.0),
                            None => continue,
                        },
                        _ => cull,
                    };
                    let bb = bound.intersect(cull);
                    if empty(bb) { continue; }
                    self.vello_item(&mut b, &c[start..i], bb);
                }
            }
        }
        for sg in &b.segs {
            match sg {
                Seg::Quads { data, .. } => self.atlas.counts.insts += (data.len() / INST) as u32,
                Seg::Vello { backdrop: Some(_), .. } => self.atlas.counts.backdrops += 1,
                Seg::Vello { .. } => self.atlas.counts.vello += 1,
            }
        }
        Plan { segs: b.segs, groups: b.groups, clips: b.clips, stops: b.stops }
    }

    /// Commands `c` (one, or a group to its pop) encoded by Vello inside the clips open
    /// around them, into the batch they go in.
    fn vello_item(&mut self, b: &mut Builder, c: &[f64], bound: Rect) {
        b.unkeepable();
        self.vello_item_as(b, c, bound, false);
    }

    /// As `vello_item`; `backdrop`: the item blends with what is beneath it, so it is drawn
    /// over a copy of that (a batch of its own).
    fn vello_item_as(&mut self, b: &mut Builder, c: &[f64], bound: Rect, backdrop: bool) {
        b.unkeepable();
        if empty(bound) { return; }
        let mut sc = Scene::new();
        // only the clips that cut into the item: one that holds it whole clips nothing, and a
        // clip layer costs Vello work over all of its shape
        let mut frames: Vec<Frame> = b.stack.iter().filter_map(|f| *f).filter(|f| !clip_holds(f, bound)).collect();
        let clips: Vec<(Affine, RoundedRect)> = frames.iter().map(|f| (f.m, f.shape)).collect();
        // a blend group's clips are opened at the draw, around the copy of what lies beneath
        if backdrop { frames.clear(); }
        for f in &frames { sc.push_layer(Fill::NonZero, BlendMode::default(), 1.0, f.m, &f.shape); }
        self.recording.push((u32::MAX, sc));
        let saved_cull = self.cull.take();
        self.run(c);
        self.cull = saved_cull;
        let mut sc = self.recording.pop().map(|(_, s)| s).unwrap_or_default();
        for _ in &frames { sc.pop_layer(); }
        let k = b.vello_seg(Item { r: bound, hole: Rect::ZERO }, backdrop);
        if let Seg::Vello { scene, items, union, backdrop: bd } = &mut b.segs[k] {
            b.grids[k].add(items.len() as u32, bound);
            if let Some(bd) = bd { *bd = clips; }
            scene.append(&sc, None);
            items.push(Item { r: bound, hole: Rect::ZERO });
            *union = if union.is_zero_area() { bound } else { union.union(bound) };
        }
    }

    /// Drawing `id` under `m` as a sprite instance (into `out`). Held still since it was last
    /// laid on the frame, or drawn into something kept (a tile, a kept pass, a layer), it is
    /// laid 1:1 from a raster at this scale and phase, made now if new; moving on the frame,
    /// its last raster is laid at the new place, sampled, while the scale stays within a
    /// quarter of it (else it is rastered anew at this one). False when it is Vello's: its reach
    /// unknown, recorded since the last plan (a drawing that changes every frame is not worth
    /// rastering), turned or stretched by `m`, or large.
    fn sprite(&mut self, id: u32, m: Affine, clip: u32, out: &mut Vec<f32>) -> bool {
        let miss = &mut self.atlas.counts.sprite_miss;
        let Some(reach) = self.picture_reach.get(&id).copied() else { miss[0] += 1; return false };
        let Some(&(version, made)) = self.sprites.versions.get(&id) else { miss[0] += 1; return false };
        if self.atlas.plan_no <= made + 1 { miss[1] += 1; return false; }
        let [a, b, c, d, e, f] = m.as_coeffs();
        if b.abs() > 1e-9 || c.abs() > 1e-9 || a <= 0.0 || d <= 0.0 { miss[2] += 1; return false; }
        let lin = Affine::new([a, 0.0, 0.0, d, 0.0, 0.0]).transform_rect_bbox(reach);
        let max = if self.sprites.exact_only { 512.0 } else { BIG_MAX };
        if lin.width() > max || lin.height() > max || lin.is_zero_area() { miss[3] += 1; return false; }
        let large = lin.width() > SPRITE_MAX || lin.height() > SPRITE_MAX;
        self.sprites.laid_in = if large { Tex::Big(id) } else { Tex::Sprites };
        let mc = [a, b, c, d, e, f];
        let prev = self.sprites.last.get(&id).copied().filter(|l| l.version == version && self.sprites.on_frame);
        let still = prev.is_some_and(|l| l.m == mc);
        let big_last = |l: &Last| self.sprites.big.get(&id).is_some_and(|(k, _)| k.version == l.version && k.sx == l.sx.to_bits() && k.sy == l.sy.to_bits());
        if let Some(l) = prev.filter(|l| !self.sprites.exact_only && !still && (a / l.sx).max(l.sx / a) <= 1.25 && (d / l.sy).max(l.sy / d) <= 1.25 && large == big_last(l)) {
            // moving: the last raster, where the drawing now lies; its slot covers picture
            // points (slot - ix - phase) / scale
            let (kx, ky) = (a / l.sx, d / l.sy);
            let x0 = e + kx * (l.slot.ix as f64 - l.px);
            let y0 = f + ky * (l.slot.iy as f64 - l.py);
            inst(out, K_SPRITE, Affine::IDENTITY, clip, [x0, y0, kx * l.slot.w as f64, ky * l.slot.h as f64], [0.0; 4],
                [0.0, 0.0, 0.0, 1.0], [l.slot.x as f32, l.slot.y as f32, l.slot.w as f32, l.slot.h as f32], [0.0; 4]);
            self.sprites.last.insert(id, Last { m: mc, ..l });
            self.sprites.sampled.push(id);
            self.atlas.counts.sprite_laid += 1;
            return true;
        }
        let (mut flx, mut fly) = (e.floor(), f.floor());
        let (mut fx, mut fy) = (((e - flx) * 4.0).round() as u8, ((f - fly) * 4.0).round() as u8);
        if fx == 4 { fx = 0; flx += 1.0; }
        if fy == 4 { fy = 0; fly += 1.0; }
        let (px, py) = (fx as f64 / 4.0, fy as f64 / 4.0);
        let ix0 = (lin.x0 + px).floor() as i32 - 2;
        let iy0 = (lin.y0 + py).floor() as i32 - 2;
        let (w, h) = (((lin.x1 + px).ceil() as i32 + 2 - ix0) as u32, ((lin.y1 + py).ceil() as i32 + 2 - iy0) as u32);
        let key = SpriteKey { id, version, sx: a.to_bits(), sy: d.to_bits(), fx, fy };
        let slot = if large {
            // its own texture: the raster kept while the key holds, made anew when it does not
            match self.sprites.big.get(&id) {
                Some((k, s)) if *k == key => *s,
                _ => {
                    let Some(pic) = self.pictures.get(&id) else { return false };
                    let mut sc = Scene::new();
                    sc.append(pic, Some(Affine::new([a, 0.0, 0.0, d, -(ix0 as f64) + px, -(iy0 as f64) + py])));
                    self.sprites.big_fresh.retain(|f| f.0 != id);
                    self.sprites.big_fresh.push((id, w, h, sc));
                    let s = Slot { x: 0, y: 0, w, h, ix: ix0, iy: iy0 };
                    self.sprites.big.insert(id, (key, s));
                    self.atlas.counts.sprites += 1;
                    s
                }
            }
        } else { match self.sprites.slots.get(&key) {
            Some(s) => *s,
            None => {
                let Some(pic) = self.pictures.get(&id) else { return false };
                let Some((x, y)) = self.sprites.shelves.alloc(w, h) else {
                    self.sprites.shelves.fill_up();
                    self.atlas.counts.sprite_miss[4] += 1;
                    return false
                };
                let at = Affine::new([a, 0.0, 0.0, d, x as f64 - ix0 as f64 + px, y as f64 - iy0 as f64 + py]);
                self.sprites.pending.append(pic, Some(at));
                let s = Slot { x, y, w, h, ix: ix0, iy: iy0 };
                self.sprites.fresh.push(s);
                self.sprites.slots.insert(key, s);
                self.atlas.counts.sprites += 1;
                s
            }
        } };
        inst(out, K_BLIT, Affine::IDENTITY, clip, [flx + slot.ix as f64, fly + slot.iy as f64, slot.w as f64, slot.h as f64], [0.0; 4],
            [0.0, 0.0, 0.0, 1.0], [slot.x as f32, slot.y as f32, 0.0, 0.0], [0.0; 4]);
        if self.sprites.on_frame { self.sprites.last.insert(id, Last { version, sx: a, sy: d, px, py, slot, m: mc }); }
        true
    }

    /// A line's glyphs as atlas instances, placed by `t` (which must only translate and
    /// scale evenly); false when the line is Vello's (a turned or stretched line, colour
    /// glyphs, a large size, a full atlas).
    fn glyphs(&mut self, s: &Shaped, t: Affine, fill: Fill7, clip: u32, out: &mut Vec<f32>) -> bool {
        let (col, geom, stops) = match fill {
            Fill7::Solid(c) => (c, [0.0; 4], [0.0; 4]),
            Fill7::Gradient(g, s0, n) => ([0.0; 4], [g[0] as f64, g[1] as f64, g[2] as f64, g[3] as f64], [s0, n, 0.0, 0.0]),
        };
        let [a, b, c, d, e, f] = t.as_coeffs();
        if b.abs() > 1e-9 || c.abs() > 1e-9 || a <= 0.0 || (a - d).abs() > 1e-6 * a { return false; }
        for run in &s.runs {
            if run.color { return false; }
            let size = run.size * a as f32;
            if size > GLYPH_MAX || size <= 0.0 { return false; }
            let mut size_q = (size * 4.0).round().max(1.0) / 4.0;
            // exact on the quarter-pixel grid, or held since the last plan: rastered at its size
            let on_grid = (size * 4.0 - (size * 4.0).round()).abs() < 1e-3;
            let no = self.atlas.plan_no;
            let held = {
                let e = self.atlas.sizes.entry((run.face, (size_q * 4.0) as u32)).or_insert((0, 0));
                if e.0 != no { e.1 = if e.0 + 1 == no { e.1 + 1 } else { 1 }; e.0 = no; }
                e.1 >= 2
            };
            let exact = on_grid || held;
            if !exact { self.atlas.inexact = true; }
            if !exact { size_q = ((size.log2() * BUCKETS).round() / BUCKETS).exp2(); }
            let r = (size / size_q) as f64;
            for g in &run.glyphs {
                let (ox, oy) = (e + a * g.x as f64, f + a * g.y as f64);
                let (mut flx, mut fly) = (ox.floor(), oy.floor());
                let (mut fx, mut fy) = (((ox - flx) * 4.0).round() as u8, ((oy - fly) * 4.0).round() as u8);
                if fx == 4 { fx = 0; flx += 1.0; }
                if fy == 4 { fy = 0; fly += 1.0; }
                // a scaling glyph is placed exactly by the quad: one raster serves every phase
                if !exact { fx = 0; fy = 0; }
                let key = GlyphKey { face: run.face, glyph: g.id, size: size_q.to_bits(), fx, fy };
                let slot = match self.atlas.slots.get(&key) {
                    Some(s) => *s,
                    None => match self.place_glyph(run, g.id, size_q, fx, fy) {
                        Some(s) => { self.atlas.slots.insert(key, s); s }
                        None => return false,
                    },
                };
                if slot.w == 0 { continue; }
                let rect = if r == 1.0 {
                    [flx + slot.ix as f64, fly + slot.iy as f64, slot.w as f64, slot.h as f64]
                } else {
                    [ox + r * (slot.ix as f64 - fx as f64 / 4.0), oy + r * (slot.iy as f64 - fy as f64 / 4.0), r * slot.w as f64, r * slot.h as f64]
                };
                let on_grid = if r == 1.0 { 1.0 } else { 0.0 };
                inst(out, K_GLYPH, Affine::IDENTITY, clip, rect, geom, col,
                    [slot.x as f32, slot.y as f32, slot.w as f32, slot.h as f32], [stops[0], stops[1], stops[2], on_grid]);
            }
        }
        true
    }

    /// Room in the atlas for a glyph at a device size and quarter-pixel phase, and the
    /// glyph encoded there for the next atlas draw.
    fn place_glyph(&mut self, run: &Run, id: u32, size: f32, fx: u8, fy: u8) -> Option<Slot> {
        let font = skrifa::FontRef::from_index(run.font.data.as_ref(), run.font.index).ok()?;
        let coords: Vec<skrifa::instance::NormalizedCoord> = run.vcoords.iter().map(|c| skrifa::instance::NormalizedCoord::from_bits(*c)).collect();
        let gm = font.glyph_metrics(skrifa::instance::Size::new(size), skrifa::instance::LocationRef::new(&coords));
        let Some(bb) = gm.bounds(skrifa::GlyphId::new(id)) else {
            return Some(Slot { x: 0, y: 0, w: 0, h: 0, ix: 0, iy: 0 });
        };
        if bb.x_max <= bb.x_min || bb.y_max <= bb.y_min { return Some(Slot { x: 0, y: 0, w: 0, h: 0, ix: 0, iy: 0 }); }
        let (px, py) = (fx as f32 / 4.0, fy as f32 / 4.0);
        let grow = 1.0 + if run.embolden { (size / 48.0).ceil() } else { 0.0 };
        let mut lean = 0.0;
        if let Some(deg) = run.skew { lean = (deg.to_radians().tan().abs()) * bb.y_max.abs().max(bb.y_min.abs()); }
        let ix0 = (bb.x_min + px - grow - lean).floor() as i32;
        let ix1 = (bb.x_max + px + grow + lean).ceil() as i32;
        let iy0 = (-bb.y_max + py - grow).floor() as i32;
        let iy1 = (-bb.y_min + py + grow).ceil() as i32;
        let (w, h) = ((ix1 - ix0) as u32, (iy1 - iy0) as u32);
        let (x, y) = self.atlas.shelves.alloc(w, h)?;
        let skew = run.skew.map(|deg| Affine::skew((deg as f64).to_radians().tan(), 0.0));
        let at = Affine::translate((x as f64 - ix0 as f64 + px as f64, y as f64 - iy0 as f64 + py as f64));
        let white = vello::peniko::Brush::Solid(Color::WHITE);
        let mut dg = self.atlas.pending.draw_glyphs(&run.font).font_size(size).transform(at).glyph_transform(skew)
            .normalized_coords(&run.vcoords).brush(&white).hint(false);
        if run.embolden {
            let k = size as f64 / 48.0;
            dg = dg.font_embolden(vello::FontEmbolden::new(vello::kurbo::Diagonal2 { xx: k, yy: k }));
        }
        dg.draw(Fill::NonZero, std::iter::once(Glyph { id, x: 0.0, y: 0.0 }));
        let slot = Slot { x, y, w, h, ix: ix0, iy: iy0 };
        self.atlas.fresh.push(slot);
        self.atlas.counts.glyphs += 1;
        Some(slot)
    }

    /// Plan and draw commands onto the frame's region (frame coordinates).
    pub(crate) fn paint_frame(&mut self, c: &[f64]) -> Result<(), JsValue> {
        let Some((x, y, w, h)) = self.gpu.as_ref().map(|g| g.region) else { return Err(JsValue::from_str("no gpu attached")) };
        let saved = self.offset;
        let keep = self.gpu.as_ref().and_then(|g| if g.passes_done > 0 { g.keep_next } else { None });
        // a pass kept on its own is drawn apart from the frame first (region coordinates)
        self.offset = if keep.is_some() { Affine::translate((-(x as f64), -(y as f64))) } else { Affine::IDENTITY };
        let area = if keep.is_some() { Rect::new(0.0, 0.0, w as f64, h as f64) } else { Rect::new(x as f64, y as f64, (x + w) as f64, (y + h) as f64) };
        self.sprites.on_frame = keep.is_none();
        let mut plan = self.plan(c, area);
        self.sprites.on_frame = false;
        self.offset = saved;
        let g = self.gpu.as_mut().unwrap();
        g.flush_atlas(&mut self.atlas)?;
        g.flush_sprites(&mut self.sprites)?;
        g.paint_frame(&mut plan)
    }

    /// Plan and draw commands into the w×h area of tile `dst` at (x, y) (moved by
    /// `self.offset` to its corner), premultiplied, as the frame's tiles are kept here.
    pub(crate) fn paint_tile(&mut self, c: &[f64], w: u32, h: u32, dst: &wgpu::Texture, x: u32, y: u32) -> Result<(), JsValue> {
        let mut plan = self.plan(c, Rect::new(0.0, 0.0, w as f64, h as f64));
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.flush_atlas(&mut self.atlas)?;
        g.flush_sprites(&mut self.sprites)?;
        g.paint_tile(&mut plan, w, h, dst, x, y)
    }

    /// Plan and draw commands into a w×h texture of their own (moved by `self.offset`),
    /// written unpremultiplied to `dst` at (x, y).
    pub(crate) fn paint_into(&mut self, c: &[f64], w: u32, h: u32, dst: &wgpu::Texture, x: u32, y: u32) -> Result<(), JsValue> {
        let mut plan = self.plan(c, Rect::new(0.0, 0.0, w as f64, h as f64));
        let g = self.gpu.as_mut().ok_or_else(|| JsValue::from_str("no gpu attached"))?;
        g.flush_atlas(&mut self.atlas)?;
        g.flush_sprites(&mut self.sprites)?;
        g.paint_into(&mut plan, w, h, dst, x, y)
    }
}

impl Gpu {
    pub(crate) fn painter_mut(&mut self) -> &mut Painter {
        if self.painter.is_none() { self.painter = Some(Painter::new(&self.device)); }
        self.painter.as_mut().unwrap()
    }

    /// Image `handle`'s texture for the quads; false when it cannot be one (too large).
    fn upload_image(&mut self, handle: u32, img: &vello::peniko::ImageData) -> bool {
        self.painter_mut();
        let Gpu { painter, device, queue, .. } = self;
        painter.as_mut().unwrap().image(device, queue, handle, img)
    }

    /// Draw the glyphs placed since the last draw into the atlas.
    fn flush_atlas(&mut self, atlas: &mut Atlas) -> Result<(), JsValue> {
        if atlas.fresh.is_empty() { return Ok(()); }
        atlas.counts.atlas_draws += 1;
        self.painter_mut();
        let t = self.painter.as_ref().unwrap().atlas.clone();
        self.raster_slots(&atlas.pending, &atlas.fresh, &t, ATLAS)?;
        atlas.pending.reset();
        atlas.fresh.clear();
        Ok(())
    }

    /// Draw the drawings placed since the last draw into the sprite texture.
    fn flush_sprites(&mut self, sp: &mut Sprites) -> Result<(), JsValue> {
        // the large drawings' rasters, each into its own texture
        for (id, w, h, sc) in std::mem::take(&mut sp.big_fresh) {
            let tex = self.pool.take(&self.device, w, h);
            let view = tex.create_view(&Default::default());
            self.flush();
            self.vello_as("sprite raster");
            self.renderer.render_to_texture(&self.device, &self.queue, &sc, &view,
                &RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area })
                .map_err(|e| JsValue::from_str(&format!("sprite: {e}")))?;
            if let Some(old) = self.big.insert(id, tex) { self.pool.give(old); }
        }
        if sp.fresh.is_empty() { return Ok(()); }
        self.painter_mut();
        let t = self.painter.as_ref().unwrap().sprites.clone();
        self.raster_slots(&sp.pending, &sp.fresh, &t, SPRITE_SIDE)?;
        sp.pending.reset();
        sp.fresh.clear();
        Ok(())
    }

    /// Rasterize `pending` (encoded at its slots' places in `dst`) with Vello and copy just
    /// those slots into `dst`.
    fn raster_slots(&mut self, pending: &Scene, fresh: &[Slot], dst: &wgpu::Texture, side: u32) -> Result<(), JsValue> {
        let y0 = fresh.iter().map(|s| s.y).min().unwrap_or(0);
        let y1 = fresh.iter().map(|s| s.y + s.h).max().unwrap_or(0).min(side);
        let span = (y1 - y0).max(1);
        let mut sc = Scene::new();
        sc.append(pending, Some(Affine::translate((0.0, -(y0 as f64)))));
        let tex = self.pool.take_rounded(&self.device, side, span);
        let view = tex.create_view(&Default::default());
        self.flush();
        self.vello_as(if side == ATLAS { "glyph raster" } else { "sprite raster" });
        self.renderer.render_to_texture(&self.device, &self.queue, &sc, &view,
            &RenderParams { base_color: Color::TRANSPARENT, width: side, height: span, antialiasing_method: AaConfig::Area })
            .map_err(|e| JsValue::from_str(&format!("atlas: {e}")))?;
        let mut enc = self.take_enc();
        for s in fresh {
            enc.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d { x: s.x, y: s.y - y0, z: 0 }, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: dst, mip_level: 0, origin: wgpu::Origin3d { x: s.x, y: s.y, z: 0 }, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: s.w, height: s.h, depth_or_array_layers: 1 });
        }
        self.enc = Some(enc);
        self.pool.give(tex);
        self.mark("slot copies");
        Ok(())
    }

    /// Render each Vello batch into a texture of its bounds (inside `clip`, integer pixels),
    /// laid by a copy instance where it stands, and turn the plan into steps: runs of
    /// instances, and blend groups drawn over what lies beneath them. Returns the instances,
    /// the steps, and the textures the runs sample.
    fn prepare(&mut self, plan: &mut Plan, clip: Rect, origin: (f64, f64)) -> Result<(Vec<f32>, Vec<Step>, Vec<wgpu::Texture>), JsValue> {
        let mut data: Vec<f32> = Vec::new();
        let mut steps: Vec<Step> = Vec::new();
        let mut work: Vec<wgpu::Texture> = Vec::new();
        // the opacity groups first, each into a texture of its rect
        let mut group_at: Vec<Tex> = Vec::new();
        for (sub, r, keep) in plan.groups.iter_mut() {
            let (w, h) = (r.width() as u32, r.height() as u32);
            let tex = self.pool.take(&self.device, w.max(1), h.max(1));
            let (gd, gs, gw) = self.prepare(sub, *r, (r.x0, r.y0))?;
            let bg = self.bind0((w.max(1), h.max(1)), (r.x0, r.y0), &gd, sub);
            let res = self.execute(&tex, [0, 0, w.max(1), h.max(1)], true, None, &bg, gs, &gw);
            for t in gw { self.pool.give(t); }
            res?;
            match keep {
                Some(view) => {
                    if let Some(old) = self.groups.insert(*view, tex) { self.pool.give(old); }
                    group_at.push(Tex::KeptGroup(*view));
                }
                None => { group_at.push(Tex::Work(work.len())); work.push(tex); }
            }
        }
        let runs_of = |steps: &mut Vec<Step>| -> usize {
            if !matches!(steps.last(), Some(Step::Runs(_))) { steps.push(Step::Runs(Vec::new())); }
            steps.len() - 1
        };
        for seg in plan.segs.iter_mut() {
            match seg {
                Seg::Quads { data: d, runs: r, .. } => {
                    let base = (data.len() / INST) as u32;
                    data.extend_from_slice(d);
                    let k = runs_of(&mut steps);
                    let tex = |t: Tex| match t { Tex::Group(g) => group_at[g], t => t };
                    if let Step::Runs(rs) = &mut steps[k] { rs.extend(r.iter().map(|(s, e, t)| (s + base, e + base, tex(*t)))); }
                }
                Seg::Vello { scene, union, backdrop, .. } => {
                    let u = union.intersect(clip);
                    let (x0, y0) = (u.x0.floor().max(clip.x0.floor()), u.y0.floor().max(clip.y0.floor()));
                    let (x1, y1) = (u.x1.ceil().min(clip.x1.ceil()), u.y1.ceil().min(clip.y1.ceil()));
                    if x1 <= x0 || y1 <= y0 { continue; }
                    let (w, h) = ((x1 - x0) as u32, (y1 - y0) as u32);
                    let out = if backdrop.is_some() { self.pool.take(&self.device, w, h) } else { self.pool.take_rounded(&self.device, w, h) };
                    let at = (data.len() / INST) as u32;
                    inst(&mut data, K_BLIT, Affine::IDENTITY, 0, [x0, y0, w as f64, h as f64], [0.0; 4], [0.0, 0.0, 0.0, 1.0], [0.0; 4], [0.0; 4]);
                    if let Some(clips) = backdrop {
                        // the frame beneath, unpremultiplied into a texture of the group's size
                        let under = self.pool.take(&self.device, w, h);
                        let copy = (data.len() / INST) as u32;
                        inst(&mut data, K_UNPREMUL, Affine::IDENTITY, 0, [0.0, 0.0, w as f64, h as f64], [0.0; 4], [0.0; 4],
                            [(x0 - origin.0) as f32, (y0 - origin.1) as f32, 0.0, 0.0], [0.0, 0.0, w as f32, h as f32]);
                        steps.push(Step::Backdrop { scene: std::mem::take(scene), clips: std::mem::take(clips), at: (x0, y0), copy, under: work.len(), out: work.len() + 1, blit: at });
                        work.push(under);
                        work.push(out);
                        continue;
                    }
                    let mut sc = Scene::new();
                    sc.append(scene, Some(Affine::translate((-x0, -y0))));
                    let view = out.create_view(&Default::default());
                    self.flush();
                    self.vello_as("vello batch");
                    self.renderer.render_to_texture(&self.device, &self.queue, &sc, &view,
                        &RenderParams { base_color: Color::TRANSPARENT, width: w, height: h, antialiasing_method: AaConfig::Area })
                        .map_err(|e| JsValue::from_str(&format!("render: {e}")))?;
                    let k = runs_of(&mut steps);
                    if let Step::Runs(rs) = &mut steps[k] { rs.push((at, at + 1, Tex::Work(work.len()))); }
                    work.push(out);
                }
            }
        }
        Ok((data, steps, work))
    }

    /// A plan's binding: its numbers written into the next slot's buffers (made, or made
    /// larger, only when they do not fit), and the slot's binding over them.
    fn bind0(&self, size: (u32, u32), origin: (f64, f64), data: &[f32], plan: &Plan) -> wgpu::BindGroup {
        let p = self.painter.as_ref().unwrap();
        let n = p.slot_next.get();
        p.slot_next.set(n + 1);
        let insts: &[f32] = if data.is_empty() { &[0.0; INST] } else { data };
        // storage bindings may not be empty
        let clips: &[f32] = if plan.clips.is_empty() { &[0.0; 4] } else { &plan.clips };
        let stops: &[f32] = if plan.stops.is_empty() { &[0.0; 4] } else { &plan.stops };
        let mut slots = p.slots.borrow_mut();
        let buf = |len: usize, usage: wgpu::BufferUsages| self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("paint"), size: ((len * 4) as u64).next_power_of_two().max(256), usage: usage | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let fits = |b: &wgpu::Buffer, len: usize| (len * 4) as u64 <= b.size();
        let stale = match slots.get(n) {
            None => true,
            Some(sl) => !fits(&sl.insts, insts.len()) || !fits(&sl.clips, clips.len()) || !fits(&sl.stops, stops.len()) || sl.atlas != p.atlas,
        };
        if stale {
            let grow = |old: Option<&wgpu::Buffer>, len: usize, usage| match old { Some(b) if fits(b, len) => b.clone(), _ => buf(len, usage) };
            let old = slots.get(n);
            let u = old.map(|s| s.u.clone()).unwrap_or_else(|| buf(4, wgpu::BufferUsages::UNIFORM));
            let (i, c, st) = (grow(old.map(|s| &s.insts), insts.len(), wgpu::BufferUsages::STORAGE),
                grow(old.map(|s| &s.clips), clips.len(), wgpu::BufferUsages::STORAGE), grow(old.map(|s| &s.stops), stops.len(), wgpu::BufferUsages::STORAGE));
            let av = p.atlas.create_view(&Default::default());
            let bind = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("paint"), layout: &p.layout0,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: u.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: i.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: c.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: st.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&av) },
                ],
            });
            let sl = PlanSlot { u, insts: i, clips: c, stops: st, bind, atlas: p.atlas.clone() };
            if n < slots.len() { slots[n] = sl; } else { slots.push(sl); }
        }
        let sl = &slots[n];
        let bytes = |v: &[f32]| -> &[u8] { unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4) } };
        self.queue.write_buffer(&sl.u, 0, bytes(&[size.0 as f32, size.1 as f32, origin.0 as f32, origin.1 as f32]));
        self.queue.write_buffer(&sl.insts, 0, bytes(insts));
        self.queue.write_buffer(&sl.clips, 0, bytes(clips));
        self.queue.write_buffer(&sl.stops, 0, bytes(stops));
        sl.bind.clone()
    }

    /// A texture's binding (layer 1), made once and kept while it is used.
    fn bind1_of(&self, t: &wgpu::Texture) -> wgpu::BindGroup {
        let p = self.painter.as_ref().unwrap();
        let now = p.epoch.get();
        let mut m = p.binds1.borrow_mut();
        if let Some((bg, at)) = m.get_mut(t) { *at = now; return bg.clone(); }
        let bg = bind1(&self.device, &p.layout1, t);
        m.insert(t.clone(), (bg.clone(), now));
        bg
    }

    /// The runs, drawn in a render pass already begun (`binds`: the texture bindings, see `binds`).
    fn draw_runs(&self, rp: &mut wgpu::RenderPass, runs: &[(u32, u32, Tex)], binds: &Binds) {
        let p = self.painter.as_ref().unwrap();
        for (s, e, t) in runs {
            let bg = match t {
                Tex::None => &p.none,
                Tex::Image(h) => match p.images.get(h) { Some((_, bg)) => bg, None => continue },
                Tex::Kept(id) => match binds.kept.get(id) { Some(bg) => bg, None => continue },
                Tex::Bitmap(h) => match binds.bitmaps.get(h) { Some(bg) => bg, None => continue },
                Tex::Work(k) => &binds.work[*k],
                Tex::Target => &binds.target,
                Tex::Group(_) => continue,   // prepare turns these into work textures
                Tex::Sprites => &p.sprites_bind,
                Tex::Big(id) => match binds.big.get(id) { Some(bg) => bg, None => continue },
                Tex::KeptGroup(v) => match binds.groups.get(v) { Some(bg) => bg, None => continue },
            };
            rp.set_bind_group(1, bg, &[]);
            rp.draw(0..6, *s..*e);
        }
    }

    /// The texture bindings a plan's runs use.
    fn binds(&self, steps: &[Step], work: &[wgpu::Texture], target: &wgpu::Texture) -> Binds {
        let (mut kept, mut bitmaps, mut big, mut groups) = (HashMap::new(), HashMap::new(), HashMap::new(), HashMap::new());
        for st in steps {
            if let Step::Runs(rs) = st {
                for (_, _, t) in rs {
                    if let Tex::Kept(id) = t {
                        if let (false, Some((tex, _))) = (kept.contains_key(id), self.kept.get(id)) { kept.insert(*id, self.bind1_of(tex)); }
                    }
                    if let Tex::Bitmap(h) = t {
                        if let (false, Some((tex, _))) = (bitmaps.contains_key(h), self.bitmaps.get(h)) { bitmaps.insert(*h, self.bind1_of(tex)); }
                    }
                    if let Tex::Big(id) = t {
                        if let (false, Some(tex)) = (big.contains_key(id), self.big.get(id)) { big.insert(*id, self.bind1_of(tex)); }
                    }
                    if let Tex::KeptGroup(v) = t {
                        if let (false, Some(tex)) = (groups.contains_key(v), self.groups.get(v)) { groups.insert(*v, self.bind1_of(tex)); }
                    }
                }
            }
        }
        Binds { kept, bitmaps, big, groups, work: work.iter().map(|t| self.bind1_of(t)).collect(), target: self.bind1_of(target) }
    }

    fn pass<'a>(enc: &'a mut wgpu::CommandEncoder, view: &'a wgpu::TextureView, clear: bool) -> wgpu::RenderPass<'a> {
        enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("paint"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: if clear { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) } else { wgpu::LoadOp::Load }, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        })
    }

    /// Draw a plan's steps onto `target` inside `scissor`: cleared first (`clear`), and over
    /// the base instance `base` when given (it replaces what is there).
    #[allow(clippy::too_many_arguments)]
    fn execute(&mut self, target: &wgpu::Texture, scissor: [u32; 4], clear: bool, base: Option<u32>,
               bg: &wgpu::BindGroup, steps: Vec<Step>, work: &[wgpu::Texture]) -> Result<(), JsValue> {
        let binds = self.binds(&steps, work, target);
        let view = target.create_view(&Default::default());
        let [sx, sy, sw, sh] = scissor;
        let mut enc = self.take_enc();
        let mut first = true;
        let base_run = base.map(|b| (b, b + 1, Tex::None));
        if steps.is_empty() && (clear || base.is_some()) {
            let mut rp = Self::pass(&mut enc, &view, clear);
            rp.set_scissor_rect(sx, sy, sw, sh);
            rp.set_bind_group(0, bg, &[]);
            if let Some(r) = base_run { rp.set_pipeline(&self.painter.as_ref().unwrap().replace); self.draw_runs(&mut rp, &[r], &binds); }
        }
        for st in steps {
            match st {
                Step::Runs(rs) => {
                    let mut rp = Self::pass(&mut enc, &view, clear && first);
                    rp.set_scissor_rect(sx, sy, sw, sh);
                    rp.set_bind_group(0, bg, &[]);
                    let p = self.painter.as_ref().unwrap();
                    if let (true, Some(r)) = (first, base_run) { rp.set_pipeline(&p.replace); self.draw_runs(&mut rp, &[r], &binds); }
                    rp.set_pipeline(&p.over);
                    self.draw_runs(&mut rp, &rs, &binds);
                    first = false;
                }
                Step::Backdrop { scene, clips, at, copy, under, out, blit } => {
                    let (uw, uh) = (work[under].width(), work[under].height());
                    {
                        if first && (clear || base_run.is_some()) {
                            let mut rp = Self::pass(&mut enc, &view, clear);
                            rp.set_scissor_rect(sx, sy, sw, sh);
                            rp.set_bind_group(0, bg, &[]);
                            if let Some(r) = base_run { rp.set_pipeline(&self.painter.as_ref().unwrap().replace); self.draw_runs(&mut rp, &[r], &binds); }
                        }
                        first = false;
                        let uv = work[under].create_view(&Default::default());
                        let mut rp = Self::pass(&mut enc, &uv, false);
                        rp.set_bind_group(0, bg, &[]);
                        rp.set_pipeline(&self.painter.as_ref().unwrap().replace);
                        self.draw_runs(&mut rp, &[(copy, copy + 1, Tex::Target)], &binds);
                    }
                    if let Some(s) = self.stages() { s.write(&mut enc, "quads"); }
                    self.queue.submit([std::mem::replace(&mut enc, self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("paint") })).finish()]);
                    if let Some(s) = self.stages() { s.write(&mut enc, "gap"); }
                    // Vello draws the group over the copy of what lies beneath it
                    let img = self.renderer.register_texture(work[under].clone());
                    let back = Affine::translate((-at.0, -at.1));
                    let mut sc = Scene::new();
                    for (m, shape) in &clips { sc.push_layer(Fill::NonZero, BlendMode::default(), 1.0, back * *m, shape); }
                    sc.draw_image(&vello::peniko::ImageBrush::new(img.clone()).with_quality(vello::peniko::ImageQuality::Low), Affine::IDENTITY);
                    sc.append(&scene, Some(back));
                    for _ in &clips { sc.pop_layer(); }
                    let ov = work[out].create_view(&Default::default());
                    self.flush();
                    self.vello_as("vello backdrop");
                    let r = self.renderer.render_to_texture(&self.device, &self.queue, &sc, &ov,
                        &RenderParams { base_color: Color::TRANSPARENT, width: uw, height: uh, antialiasing_method: AaConfig::Area })
                        .map_err(|e| JsValue::from_str(&format!("render: {e}")));
                    self.renderer.unregister_texture(img);
                    r?;
                    let mut rp = Self::pass(&mut enc, &view, false);
                    rp.set_scissor_rect(sx, sy, sw, sh);
                    rp.set_bind_group(0, bg, &[]);
                    rp.set_pipeline(&self.painter.as_ref().unwrap().over);
                    self.draw_runs(&mut rp, &[(blit, blit + 1, Tex::Work(out))], &binds);
                }
            }
        }
        self.enc = Some(enc);
        self.mark("quads");
        Ok(())
    }

    /// A pass of the frame drawn by the quads: the first over the base colour, the rest laid
    /// over what is there; a pass kept on its own (keep_next) drawn apart, kept, then laid.
    fn paint_frame(&mut self, plan: &mut Plan) -> Result<(), JsValue> {
        self.painter_mut();
        let (x, y, w, h) = self.region;
        let first = self.passes_done == 0;
        self.passes_done += 1;
        if let (false, Some(id)) = (first, self.keep_next.take()) {
            let fresh = self.caches.get(&id).is_none_or(|t| t.width() != w || t.height() != h);
            if fresh { if let Some(old) = self.caches.insert(id, crate::layers::layer_texture(&self.device, w, h)) { self.pool.retire(old); } }
            let cache = self.caches[&id].clone();
            self.paint_into(plan, w, h, &cache, 0, 0)?;
            let mut enc = self.take_enc();
            self.quads.as_ref().unwrap().draw(&self.device, &mut enc, &self.target, &cache,
                [0.0, 0.0, w as f32, h as f32], [x as f32, y as f32, (x + w) as f32, (y + h) as f32], [x, y, x + w, y + h], true);
            self.enc = Some(enc);
            return Ok(());
        }
        let clip = Rect::new(x as f64, y as f64, (x + w) as f64, (y + h) as f64);
        let (mut data, steps, work) = self.prepare(plan, clip, (0.0, 0.0))?;
        let base = if first {
            let at = (data.len() / INST) as u32;
            let c = self.base.to_rgba8();
            inst(&mut data, K_FILL, Affine::IDENTITY, 0, [x as f64, y as f64, w as f64, h as f64], [0.0; 4],
                [c.r as f32 / 255.0, c.g as f32 / 255.0, c.b as f32 / 255.0, c.a as f32 / 255.0], [0.0; 4], [0.0; 4]);
            Some(at)
        } else { None };
        let target = self.target.clone();
        let bg = self.bind0((target.width(), target.height()), (0.0, 0.0), &data, plan);
        let r = self.execute(&target, [x, y, w, h], false, base, &bg, steps, &work);
        for t in work { self.pool.give(t); }
        r
    }

    /// The frame's first pass when nothing else draws one: the base colour over the region.
    pub(crate) fn base_pass(&mut self) -> Result<(), JsValue> {
        if !self.quads_on { return self.frame_pass(&Scene::new()); }
        self.paint_frame(&mut Plan::empty())
    }

    /// A plan drawn into the w×h area of `dst` at (x, y), premultiplied: the area cleared,
    /// then the plan over it, its coordinates moved to the area's corner.
    fn paint_tile(&mut self, plan: &mut Plan, w: u32, h: u32, dst: &wgpu::Texture, x: u32, y: u32) -> Result<(), JsValue> {
        self.painter_mut();
        let clip = Rect::new(0.0, 0.0, w as f64, h as f64);
        let origin = (-(x as f64), -(y as f64));
        let (mut data, steps, work) = self.prepare(plan, clip, origin)?;
        let at = (data.len() / INST) as u32;
        inst(&mut data, K_FILL, Affine::IDENTITY, 0, [0.0, 0.0, w as f64, h as f64], [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4]);
        let bg = self.bind0((dst.width(), dst.height()), origin, &data, plan);
        let sc = [x, y, w.min(dst.width().saturating_sub(x)), h.min(dst.height().saturating_sub(y))];
        let r = self.execute(dst, sc, false, Some(at), &bg, steps, &work);
        for t in work { self.pool.give(t); }
        r
    }

    /// A plan drawn into a transparent w×h working texture, then written unpremultiplied to
    /// `dst` at (x, y).
    #[allow(clippy::too_many_arguments)]
    fn paint_into(&mut self, plan: &mut Plan, w: u32, h: u32, dst: &wgpu::Texture, x: u32, y: u32) -> Result<(), JsValue> {
        self.painter_mut();
        let clip = Rect::new(0.0, 0.0, w as f64, h as f64);
        let (mut data, steps, mut work) = self.prepare(plan, clip, (0.0, 0.0))?;
        let wt = self.pool.take(&self.device, w, h);
        let at = (data.len() / INST) as u32;
        inst(&mut data, K_UNPREMUL, Affine::IDENTITY, 0, [x as f64, y as f64, w as f64, h as f64], [0.0; 4], [0.0; 4],
            [0.0; 4], [0.0, 0.0, dst.width() as f32, dst.height() as f32]);
        let bg = self.bind0((w, h), (0.0, 0.0), &data, plan);
        let r = self.execute(&wt, [0, 0, w, h], true, None, &bg, steps, &work);
        if r.is_ok() {
            work.push(wt.clone());
            let binds = self.binds(&[], &work, dst);
            let mut enc = self.take_enc();
            {
                let dv = dst.create_view(&Default::default());
                let mut rp = Self::pass(&mut enc, &dv, false);
                rp.set_scissor_rect(x, y, w.min(dst.width().saturating_sub(x)), h.min(dst.height().saturating_sub(y)));
                rp.set_bind_group(0, &bg, &[]);
                rp.set_pipeline(&self.painter.as_ref().unwrap().replace);
                self.draw_runs(&mut rp, &[(at, at + 1, Tex::Work(work.len() - 1))], &binds);
            }
            self.enc = Some(enc);
            self.mark("unpremul copy");
        } else {
            work.push(wt);
        }
        for t in work { self.pool.give(t); }
        r
    }
}

/// A step of drawing a plan.
enum Step {
    /// Runs of instances, each sampling one texture.
    Runs(Vec<(u32, u32, Tex)>),
    /// A blend group: what lies beneath its bounds (from `at`) copied by instance `copy` into
    /// work texture `under`; Vello's drawing, inside the clips, of that copy and the group over
    /// it into `out`; and `out` laid in place by instance `blit` (transparent outside the clips).
    Backdrop { scene: Scene, clips: Vec<(Affine, RoundedRect)>, at: (f64, f64), copy: u32, under: usize, out: usize, blit: u32 },
}

struct Binds {
    kept: HashMap<u32, wgpu::BindGroup>,
    bitmaps: HashMap<u32, wgpu::BindGroup>,
    big: HashMap<u32, wgpu::BindGroup>,
    groups: HashMap<u32, wgpu::BindGroup>,
    work: Vec<wgpu::BindGroup>,
    target: wgpu::BindGroup,
}



