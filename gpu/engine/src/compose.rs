// compose — the frame as a sequence of steps onto the kept frame texture, in paint order.
//
// A frame is no longer one Vello scene. It is: Vello passes (the ordinary content between
// layers, each rendered at the frame's region and laid over what is there), tiles (a
// scroller's kept content, drawn as plain textured rectangles under the scroller's clip —
// never through Vello's image atlas, which images share and which a few full-width tiles
// would fill), and snapshots (the frame as it stands, read back at a reduced scale for frost
// behind a view). This module draws the rectangles: a textured quad, laid over (straight
// alpha, as Vello writes it) or copied, scissored to a clip.

pub(crate) struct Quads {
    blend: wgpu::RenderPipeline,
    /// Over, for a premultiplied texture (a tile the quads drew, paint.rs).
    blend_pm: wgpu::RenderPipeline,
    copy: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    /// A filled rounded rectangle (a scrollbar's thumb and track), antialiased by distance.
    rrect: wgpu::RenderPipeline,
    rlayout: wgpu::BindGroupLayout,
}

const RRECT: &str = r#"
struct R { rect: vec4<f32>, color: vec4<f32>, size: vec4<f32> }
@group(0) @binding(0) var<uniform> r: R;
struct V { @builtin(position) pos: vec4<f32>, @location(0) px: vec2<f32> }
@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
  let corner = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0))[i];
  let px = mix(r.rect.xy - vec2(1.0), r.rect.zw + vec2(1.0), corner);
  var o: V;
  o.pos = vec4(px.x / r.size.x * 2.0 - 1.0, 1.0 - px.y / r.size.y * 2.0, 0.0, 1.0);
  o.px = px;
  return o;
}
@fragment
fn fs(v: V) -> @location(0) vec4<f32> {
  let c = (r.rect.xy + r.rect.zw) * 0.5;
  let half = (r.rect.zw - r.rect.xy) * 0.5;
  let rad = min(r.size.z, min(half.x, half.y));
  let q = abs(v.px - c) - half + vec2(rad);
  let d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - rad;
  let a = clamp(0.5 - d, 0.0, 1.0);
  return vec4(r.color.rgb, r.color.a * a);
}
"#;

const QUAD: &str = r#"
struct Q { dst: vec4<f32>, src: vec4<f32>, size: vec4<f32> }
@group(0) @binding(0) var<uniform> q: Q;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct V { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
  let corner = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0))[i];
  let px = mix(q.dst.xy, q.dst.zw, corner);
  var o: V;
  o.pos = vec4(px.x / q.size.x * 2.0 - 1.0, 1.0 - px.y / q.size.y * 2.0, 0.0, 1.0);
  o.uv = mix(q.src.xy, q.src.zw, corner);
  return o;
}
@fragment
fn fs(v: V) -> @location(0) vec4<f32> { return textureSample(tex, samp, v.uv); }
"#;

impl Quads {
    pub(crate) fn new(device: &wgpu::Device) -> Quads {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("quad"), source: wgpu::ShaderSource::Wgsl(QUAD.into()) });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("quad"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("quad"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipe = |blend: Option<wgpu::BlendState>| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("quad"), layout: Some(&pl),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend, write_mask: wgpu::ColorWrites::ALL })] }),
            primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(),
            multiview_mask: None, cache: None,
        });
        // straight alpha over: colour by its alpha, alpha by the usual over
        let over = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("quad"), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge, address_mode_v: wgpu::AddressMode::ClampToEdge, ..Default::default()
        });
        let rmodule = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("rrect"), source: wgpu::ShaderSource::Wgsl(RRECT.into()) });
        let rlayout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rrect"),
            entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }],
        });
        let rpl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("rrect"), bind_group_layouts: &[Some(&rlayout)], immediate_size: 0 });
        let rrect = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rrect"), layout: Some(&rpl),
            vertex: wgpu::VertexState { module: &rmodule, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &rmodule, entry_point: Some("fs"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: Some(over), write_mask: wgpu::ColorWrites::ALL })] }),
            primitive: wgpu::PrimitiveState::default(), depth_stencil: None, multisample: wgpu::MultisampleState::default(),
            multiview_mask: None, cache: None,
        });
        Quads { blend: pipe(Some(over)), blend_pm: pipe(Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)), copy: pipe(None), layout, sampler, rrect, rlayout }
    }

    /// A filled rounded rectangle (device pixels; straight rgba 0..1) over `target`, inside the scissor.
    pub(crate) fn rrect(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, target: &wgpu::Texture,
                        rect: [f32; 4], radius: f32, rgba: [f32; 4], scissor: [u32; 4]) {
        use wgpu::util::DeviceExt;
        let (tw, th) = (target.width(), target.height());
        let [sx0, sy0, sx1, sy1] = [scissor[0].min(tw), scissor[1].min(th), scissor[2].min(tw), scissor[3].min(th)];
        if sx1 <= sx0 || sy1 <= sy0 { return; }
        let u: [f32; 12] = [rect[0], rect[1], rect[2], rect[3], rgba[0], rgba[1], rgba[2], rgba[3], tw as f32, th as f32, radius, 0.0];
        let bytes: Vec<u8> = u.iter().flat_map(|v| v.to_le_bytes()).collect();
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("rrect"), contents: &bytes, usage: wgpu::BufferUsages::UNIFORM });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("rrect"), layout: &self.rlayout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() }] });
        let tv = target.create_view(&Default::default());
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("rrect"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &tv, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        rp.set_pipeline(&self.rrect);
        rp.set_bind_group(0, &bg, &[]);
        rp.set_scissor_rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
        rp.draw(0..6, 0..1);
    }

    /// Draw the `src` rect (texels) of `tex` onto the `dst` rect (pixels) of `target`, laid
    /// over what is there (`over`) or replacing it, inside the scissor rect.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, target: &wgpu::Texture, tex: &wgpu::Texture,
                       src: [f32; 4], dst: [f32; 4], scissor: [u32; 4], over: bool) {
        self.draw_as(device, enc, target, tex, src, dst, scissor, if over { &self.blend } else { &self.copy });
    }

    /// As `draw` laid over, for a premultiplied texture.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw_premul(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, target: &wgpu::Texture, tex: &wgpu::Texture,
                              src: [f32; 4], dst: [f32; 4], scissor: [u32; 4]) {
        self.draw_as(device, enc, target, tex, src, dst, scissor, &self.blend_pm);
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_as(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, target: &wgpu::Texture, tex: &wgpu::Texture,
               src: [f32; 4], dst: [f32; 4], scissor: [u32; 4], pipe: &wgpu::RenderPipeline) {
        use wgpu::util::DeviceExt;
        let (tw, th) = (target.width(), target.height());
        let [sx0, sy0, sx1, sy1] = [scissor[0].min(tw), scissor[1].min(th), scissor[2].min(tw), scissor[3].min(th)];
        if sx1 <= sx0 || sy1 <= sy0 { return; }
        let (iw, ih) = (tex.width() as f32, tex.height() as f32);
        let u: [f32; 12] = [dst[0], dst[1], dst[2], dst[3], src[0] / iw, src[1] / ih, src[2] / iw, src[3] / ih, tw as f32, th as f32, 0.0, 0.0];
        let bytes: Vec<u8> = u.iter().flat_map(|v| v.to_le_bytes()).collect();
        let buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("quad"), contents: &bytes, usage: wgpu::BufferUsages::UNIFORM });
        let view = tex.create_view(&Default::default());
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("quad"), layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        let tv = target.create_view(&Default::default());
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("quad"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &tv, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None,
        });
        rp.set_pipeline(pipe);
        rp.set_bind_group(0, &bg, &[]);
        rp.set_scissor_rect(sx0, sy0, sx1 - sx0, sy1 - sy0);
        rp.draw(0..6, 0..1);
    }
}
