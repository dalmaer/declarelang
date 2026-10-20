// layers — a view's subtree rendered into a texture of its own, then post-processed.
//
// What Vello cannot do inside one scene — blur a subtree (filter, frost), recolor it (the
// colour-matrix filters), throw a drop shadow of its alpha, or project it through a 3D
// transform — is done here: the subtree is rendered by Vello into a texture, a chain of
// compute passes runs over it, and the result is registered with the renderer as an image
// (`Renderer::override_image`) that the frame then draws like any other.
//
// Textures hold STRAIGHT alpha, as Vello writes them and reads images; every pass
// premultiplies what it reads and writes straight alpha back.
//
// Passes, as numbers (the host writes them):
//   1 sigma edge                    Gaussian blur, σ in texels; past the edge 0 transparent,
//                                   1 the edge pixel, 2 mirrored (CSS backdrop-filter's)
//   2 m(16 row-major) o(4)          colour matrix on straight rgba, then the offset, clamped
//   3 dx dy sigma rgba              drop shadow: the alpha blurred, tinted, offset, under
//   4 rgba                          tint: the colour, at the source's alpha (source-in)
//   5 w h h(9 row-major)            projection: a w×h output, each pixel's centre through h
//                                   to source texel coordinates, sampled bilinearly

use std::collections::HashMap;

pub(crate) struct Passes {
    blur: wgpu::ComputePipeline,
    matrix: wgpu::ComputePipeline,
    shadow: wgpu::ComputePipeline,
    tint: wgpu::ComputePipeline,
    project: wgpu::ComputePipeline,
    one: wgpu::BindGroupLayout,
    two: wgpu::BindGroupLayout,
}

const COMMON: &str = r#"
fn pm(c: vec4<f32>) -> vec4<f32> { return vec4(c.rgb * c.a, c.a); }
fn st(c: vec4<f32>) -> vec4<f32> { if (c.a <= 0.0) { return vec4(0.0); } return vec4(clamp(c.rgb / c.a, vec3(0.0), vec3(1.0)), clamp(c.a, 0.0, 1.0)); }
"#;

const BLUR: &str = r#"
struct P { dir: vec2<i32>, radius: i32, edge: i32, sigma: f32, _a: f32, _b: f32, _c: f32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = vec2<i32>(textureDimensions(src));
  let at = vec2<i32>(id.xy);
  if (at.x >= size.x || at.y >= size.y) { return; }
  var acc = vec4(0.0);
  var wsum = 0.0;
  let k = -0.5 / (p.sigma * p.sigma);
  for (var i = -p.radius; i <= p.radius; i++) {
    let w = exp(f32(i * i) * k);
    wsum += w;
    var q = at + p.dir * i;
    if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) {
      if (p.edge == 0) { continue; }
      if (p.edge == 2) {
        // mirrored about the edge pixel, folded into range for a kernel wider than the image
        let period = max(2 * (size - vec2(1)), vec2(1));
        var r = abs(q) % period;
        r = select(r, period - r, r >= size);
        q = clamp(r, vec2(0), size - vec2(1));
      } else {
        q = clamp(q, vec2(0), size - vec2(1));
      }
    }
    acc += pm(textureLoad(src, q, 0)) * w;
  }
  textureStore(dst, at, st(acc / wsum));
}
"#;

const MATRIX: &str = r#"
struct P { m: mat4x4<f32>, o: vec4<f32> }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = vec2<i32>(textureDimensions(src));
  let at = vec2<i32>(id.xy);
  if (at.x >= size.x || at.y >= size.y) { return; }
  let c = textureLoad(src, at, 0);
  // the matrix's rows are its uniform's columns (written row-major from the host)
  let r = clamp(c * p.m + p.o, vec4(0.0), vec4(1.0));
  textureStore(dst, at, r);
}
"#;

const TINT: &str = r#"
struct P { c: vec4<f32> }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = vec2<i32>(textureDimensions(src));
  let at = vec2<i32>(id.xy);
  if (at.x >= size.x || at.y >= size.y) { return; }
  let a = textureLoad(src, at, 0).a;
  textureStore(dst, at, vec4(p.c.rgb, p.c.a * a));
}
"#;

const SHADOW: &str = r#"
struct P { color: vec4<f32>, off: vec2<i32>, _a: i32, _b: i32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: P;
@group(0) @binding(3) var blurred: texture_2d<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = vec2<i32>(textureDimensions(src));
  let at = vec2<i32>(id.xy);
  if (at.x >= size.x || at.y >= size.y) { return; }
  let s = pm(textureLoad(src, at, 0));
  let q = at - p.off;
  var a = 0.0;
  if (q.x >= 0 && q.y >= 0 && q.x < size.x && q.y < size.y) { a = textureLoad(blurred, q, 0).a; }
  let sh = vec4(p.color.rgb, 1.0) * (p.color.a * a);
  textureStore(dst, at, st(s + sh * (1.0 - s.a)));
}
"#;

const PROJECT: &str = r#"
struct P { r0: vec4<f32>, r1: vec4<f32>, r2: vec4<f32> }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: P;
fn tap(q: vec2<i32>, size: vec2<i32>) -> vec4<f32> {
  if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) { return vec4(0.0); }
  return pm(textureLoad(src, q, 0));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let out = vec2<i32>(textureDimensions(dst));
  let at = vec2<i32>(id.xy);
  if (at.x >= out.x || at.y >= out.y) { return; }
  let c = vec3(f32(at.x) + 0.5, f32(at.y) + 0.5, 1.0);
  let w = dot(p.r2.xyz, c);
  if (w <= 1e-6) { textureStore(dst, at, vec4(0.0)); return; }
  let s = vec2(dot(p.r0.xyz, c), dot(p.r1.xyz, c)) / w - vec2(0.5);
  let size = vec2<i32>(textureDimensions(src));
  let b = vec2<i32>(floor(s));
  let f = s - floor(s);
  let v = mix(mix(tap(b, size), tap(b + vec2(1, 0), size), f.x),
              mix(tap(b + vec2(0, 1), size), tap(b + vec2(1, 1), size), f.x), f.y);
  textureStore(dst, at, st(v));
}
"#;

impl Passes {
    pub(crate) fn new(device: &wgpu::Device) -> Passes {
        let entry = |binding: u32, ty: wgpu::BindingType| wgpu::BindGroupLayoutEntry {
            binding, visibility: wgpu::ShaderStages::COMPUTE, ty, count: None,
        };
        let sampled = wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2, multisampled: false,
        };
        let storage = wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly, format: wgpu::TextureFormat::Rgba8Unorm,
            view_dimension: wgpu::TextureViewDimension::D2,
        };
        let uniform = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None };
        let one = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer pass"), entries: &[entry(0, sampled), entry(1, storage), entry(2, uniform)],
        });
        let two = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("layer pass, two sources"), entries: &[entry(0, sampled), entry(1, storage), entry(2, uniform), entry(3, sampled)],
        });
        let pipeline = |src: &str, layout: &wgpu::BindGroupLayout, label: &str| {
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label), source: wgpu::ShaderSource::Wgsl(format!("{COMMON}{src}").into()),
            });
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label), bind_group_layouts: &[Some(layout)], immediate_size: 0,
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label), layout: Some(&pl), module: &module, entry_point: Some("main"),
                compilation_options: Default::default(), cache: None,
            })
        };
        Passes {
            blur: pipeline(BLUR, &one, "blur"),
            matrix: pipeline(MATRIX, &one, "matrix"),
            shadow: pipeline(SHADOW, &two, "shadow"),
            tint: pipeline(TINT, &one, "tint"),
            project: pipeline(PROJECT, &one, "project"),
            one, two,
        }
    }
}

/// A texture a layer is rendered into or a pass writes.
pub(crate) fn layer_texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture { labeled_texture(device, w, h, "declare layer") }

fn labeled_texture(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    })
}

/// Textures by size, reused across frames: a layer redrawn every frame (frost under
/// scrolling content) allocates nothing once warm. What it keeps is held to POOL_BYTES: a
/// texture given back past it makes room by letting go of the one given back longest ago, or is
/// let go of itself — sizes vary without end (a batch is its own bounds), so kept textures must not.
/// A texture let go of is destroyed once the frame is submitted (`reap`): in the browser a
/// dropped texture is otherwise freed only when the collector takes its handle, and a frame
/// can let go of hundreds of megabytes.
#[derive(Default)]
pub(crate) struct Pool {
    /// By size, each with when it was given back (`clock`).
    free: HashMap<(u32, u32), Vec<(wgpu::Texture, u64)>>,
    bytes: u64,
    clock: u64,
    /// Let go of this frame, destroyed at `reap`.
    doomed: Vec<wgpu::Texture>,
    /// Takes met from the pool, takes made anew, gives let go of (four of the size kept
    /// already, or too large), kept textures let go of to make room.
    pub(crate) counts: [u32; 4],
}

const POOL_BYTES: u64 = 192 << 20;
const ROUND: u32 = 256;

fn bytes_of(w: u32, h: u32) -> u64 { w as u64 * h as u64 * 4 }

impl Pool {
    pub(crate) fn mb(&self) -> f64 { self.bytes as f64 / 1048576.0 }
    /// At least w×h: the size rounded up to a step of ROUND, so that sizes which vary frame to
    /// frame (a Vello batch's bounds) find one given back. For a texture only drawn into
    /// within w×h and read texel for texel.
    #[track_caller]
    pub(crate) fn take_rounded(&mut self, device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
        self.take(device, w.max(1).next_multiple_of(ROUND), h.max(1).next_multiple_of(ROUND))
    }
    /// A texture no one holds any more, not for reuse: destroyed at `reap`.
    pub(crate) fn retire(&mut self, t: wgpu::Texture) { self.doomed.push(t); }
    /// Destroy what was let go of: called once the frame's work is submitted.
    pub(crate) fn reap(&mut self) { for t in self.doomed.drain(..) { t.destroy(); } }
    /// A w×h texture: one given back at that size, or a new one labeled with the caller's place.
    #[track_caller]
    pub(crate) fn take(&mut self, device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
        match self.free.get_mut(&(w, h)).and_then(|v| v.pop()) {
            Some((t, _)) => { self.counts[0] += 1; self.bytes -= bytes_of(w, h); t }
            None => {
                self.counts[1] += 1;
                let at = std::panic::Location::caller();
                labeled_texture(device, w, h, &format!("declare layer {}:{}", at.file().rsplit('/').next().unwrap_or(""), at.line()))
            }
        }
    }
    pub(crate) fn give(&mut self, t: wgpu::Texture) {
        let k = (t.width(), t.height());
        let size = bytes_of(k.0, k.1);
        if self.free.get(&k).is_some_and(|v| v.len() >= 4) || size > POOL_BYTES { self.counts[2] += 1; self.doomed.push(t); return; }
        while self.bytes + size > POOL_BYTES {
            let Some(old) = self.free.iter().filter_map(|(k, v)| v.first().map(|e| (*k, e.1))).min_by_key(|e| e.1).map(|e| e.0) else { break };
            let (t, _) = self.free.get_mut(&old).unwrap().remove(0);
            self.counts[3] += 1; self.bytes -= bytes_of(old.0, old.1); self.doomed.push(t);
        }
        if self.bytes + size > POOL_BYTES { self.doomed.push(t); return; }
        self.free.retain(|_, v| !v.is_empty());
        self.clock += 1;
        self.free.entry(k).or_default().push((t, self.clock));
        self.bytes += size;
    }
}

fn uniform(device: &wgpu::Device, bytes: &[u8]) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("layer pass"), contents: bytes, usage: wgpu::BufferUsages::UNIFORM,
    })
}

fn f32s(v: &[f32]) -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() }

fn rgba_f(c: u32) -> [f32; 4] {
    [((c >> 24) & 255) as f32 / 255.0, ((c >> 16) & 255) as f32 / 255.0, ((c >> 8) & 255) as f32 / 255.0, (c & 255) as f32 / 255.0]
}

/// Run one compute pass from `src` into `dst` (and `extra` as the second source).
#[allow(clippy::too_many_arguments)]
fn dispatch(device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, p: &Passes, pipe: &wgpu::ComputePipeline,
            src: &wgpu::Texture, dst: &wgpu::Texture, params: &[u8], extra: Option<&wgpu::Texture>) {
    let buf = uniform(device, params);
    let sv = src.create_view(&Default::default());
    let dv = dst.create_view(&Default::default());
    let xv = extra.map(|t| t.create_view(&Default::default()));
    let mut entries = vec![
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&sv) },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&dv) },
        wgpu::BindGroupEntry { binding: 2, resource: buf.as_entire_binding() },
    ];
    if let Some(x) = xv.as_ref() { entries.push(wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(x) }); }
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("layer pass"), layout: if extra.is_some() { &p.two } else { &p.one }, entries: &entries,
    });
    let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("layer pass"), timestamp_writes: None });
    cp.set_pipeline(pipe);
    cp.set_bind_group(0, &bg, &[]);
    cp.dispatch_workgroups(dst.width().div_ceil(8), dst.height().div_ceil(8), 1);
}

/// A separable Gaussian blur of `src` (both directions); the result in a pool texture.
fn blur(device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, p: &Passes, pool: &mut Pool, used: &mut Vec<wgpu::Texture>,
        src: &wgpu::Texture, sigma: f32, edge: i32) -> wgpu::Texture {
    let (w, h) = (src.width(), src.height());
    let radius = (sigma * 3.0).ceil().clamp(0.0, 250.0) as i32;
    let params = |dx: i32, dy: i32| {
        let mut b = Vec::new();
        for v in [dx, dy, radius, edge] { b.extend_from_slice(&v.to_le_bytes()); }
        b.extend(f32s(&[sigma.max(1e-3), 0.0, 0.0, 0.0]));
        b
    };
    let mid = pool.take(device, w, h);
    let out = pool.take(device, w, h);
    dispatch(device, enc, p, &p.blur, src, &mid, &params(1, 0), None);
    dispatch(device, enc, p, &p.blur, &mid, &out, &params(0, 1), None);
    used.push(mid);
    out
}

/// Record the chain over `src` into `enc`; the final texture (which may be `src` itself).
/// Textures it used go back to the pool at once: what is recorded later in the same encoder
/// runs after, so reusing them there is safe.
pub(crate) fn run_passes(device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, p: &Passes, pool: &mut Pool,
                         src: wgpu::Texture, passes: &[f64]) -> wgpu::Texture {
    let enc = &mut *enc;
    let mut cur = src;
    let mut used: Vec<wgpu::Texture> = Vec::new();
    let mut i = 0;
    while i < passes.len() {
        let kind = passes[i] as u32;
        let (w, h) = (cur.width(), cur.height());
        let next = match kind {
            1 if i + 2 < passes.len() => {
                let (sigma, edge) = (passes[i + 1] as f32, passes[i + 2] as i32);
                i += 3;
                if sigma <= 0.0 { continue; }
                blur(device, enc, p, pool, &mut used, &cur, sigma, edge)
            }
            2 if i + 20 < passes.len() => {
                // the host writes the rows; WGSL's mat4x4 is column-major, and `c * m` takes
                // m's columns as the rows of the product, so the rows go in as they are
                let v: Vec<f32> = passes[i + 1..i + 21].iter().map(|x| *x as f32).collect();
                i += 21;
                let out = pool.take(device, w, h);
                let mut bytes = Vec::new();
                for r in 0..4 { bytes.extend(f32s(&v[r * 4..r * 4 + 4])); }
                bytes.extend(f32s(&v[16..20]));
                dispatch(device, enc, p, &p.matrix, &cur, &out, &bytes, None);
                out
            }
            3 if i + 4 < passes.len() => {
                let (dx, dy, sigma, c) = (passes[i + 1].round() as i32, passes[i + 2].round() as i32, passes[i + 3] as f32, passes[i + 4] as u32);
                i += 5;
                let blurred = if sigma > 0.0 { blur(device, enc, p, pool, &mut used, &cur, sigma, 0) } else {
                    let t = pool.take(device, w, h);
                    enc.copy_texture_to_texture(cur.as_image_copy(), t.as_image_copy(), cur.size());
                    t
                };
                let out = pool.take(device, w, h);
                let mut bytes = f32s(&rgba_f(c));
                for v in [dx, dy, 0, 0] { bytes.extend_from_slice(&v.to_le_bytes()); }
                dispatch(device, enc, p, &p.shadow, &cur, &out, &bytes, Some(&blurred));
                used.push(blurred);
                out
            }
            4 if i + 1 < passes.len() => {
                let c = passes[i + 1] as u32;
                i += 2;
                let out = pool.take(device, w, h);
                dispatch(device, enc, p, &p.tint, &cur, &out, &f32s(&rgba_f(c)), None);
                out
            }
            5 if i + 11 < passes.len() => {
                let (ow, oh) = (passes[i + 1].max(1.0) as u32, passes[i + 2].max(1.0) as u32);
                let m: Vec<f32> = passes[i + 3..i + 12].iter().map(|x| *x as f32).collect();
                i += 12;
                let out = pool.take(device, ow, oh);
                let bytes = f32s(&[m[0], m[1], m[2], 0.0, m[3], m[4], m[5], 0.0, m[6], m[7], m[8], 0.0]);
                dispatch(device, enc, p, &p.project, &cur, &out, &bytes, None);
                out
            }
            _ => break,
        };
        used.push(std::mem::replace(&mut cur, next));
    }
    for t in used { pool.give(t); }
    cur
}
