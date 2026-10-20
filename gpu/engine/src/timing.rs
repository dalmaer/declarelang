// timing — how long each frame takes on the GPU, from timestamp queries (when the adapter
// offers them). A frame's first step writes a timestamp as it begins, its last as it ends;
// the stamps are resolved and read back without waiting, and Engine::gpu_times hands out
// the frames finished since. This is the GPU's span for the frame, apart from the queueing
// that `gpu_done`'s times include.
//
// With detail on (`&gpustages`), each stage of the frame stamps its end too, named for the
// work it finished: a Vello render, a quads pass, a copy, the present. The span between two
// stamps goes to the later one's name. A stamp named `gap` begins each submission (Vello's
// through its encoder hook), so the span it closes is the GPU waiting for the next
// submission, not working; the first of them, `gap: first submit`, is the CPU encoding the
// frame's first submission after its start was stamped. Engine::gpu_stages hands out the sums.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

/// Stamps a frame can hold.
const MAX: u32 = 256;

/// The query set and what has been written into it this frame.
pub(crate) struct Stamps {
    set: wgpu::QuerySet,
    /// A 1×1 target for the empty passes that carry the timestamps.
    dummy: wgpu::TextureView,
    n: Cell<u32>,
    labels: RefCell<Vec<&'static str>>,
    /// Stages are stamped (not only the frame's start and end).
    pub(crate) detail: Cell<bool>,
    /// The name the next Vello render's end is stamped with.
    pub(crate) vello: Cell<&'static str>,
}

impl Stamps {
    /// A stamp at this point of `enc`, closing the span of work `label`.
    pub(crate) fn write(&self, enc: &mut wgpu::CommandEncoder, label: &'static str) {
        let i = self.n.get();
        if i >= MAX { return; }
        self.n.set(i + 1);
        self.labels.borrow_mut().push(label);
        let tw = wgpu::RenderPassTimestampWrites { query_set: &self.set, beginning_of_pass_write_index: Some(i), end_of_pass_write_index: None };
        drop(enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("frame time"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &self.dummy, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: None, timestamp_writes: Some(tw), occlusion_query_set: None, multiview_mask: None,
        }));
    }
}

pub(crate) struct Timer {
    pub(crate) stamps: Rc<Stamps>,
    resolve: wgpu::Buffer,
    /// Read-back buffers, and whether each is free.
    read: Vec<(wgpu::Buffer, Rc<RefCell<bool>>)>,
    /// Nanoseconds per tick.
    period: f32,
}

thread_local! {
    static TIMES: RefCell<Vec<(u32, f64)>> = const { RefCell::new(Vec::new()) };
    /// Per stage: GPU milliseconds and how many spans, since the last `take_stages`.
    static STAGES: RefCell<HashMap<&'static str, (f64, u32)>> = RefCell::new(HashMap::new());
}

impl Timer {
    pub(crate) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Timer {
        let set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("frame time"), ty: wgpu::QueryType::Timestamp, count: MAX });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: Some("frame time"), size: MAX as u64 * 8,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let read = (0..4).map(|_| (device.create_buffer(&wgpu::BufferDescriptor { label: Some("frame time read"), size: MAX as u64 * 8,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false }), Rc::new(RefCell::new(true)))).collect();
        let dummy = crate::layers::layer_texture(device, 1, 1).create_view(&Default::default());
        let stamps = Rc::new(Stamps { set, dummy, n: Cell::new(0), labels: RefCell::new(Vec::new()), detail: Cell::new(false), vello: Cell::new("vello") });
        Timer { stamps, resolve, read, period: queue.get_timestamp_period() }
    }

    /// The frame begins (before anything of it is submitted).
    pub(crate) fn begin(&self, device: &wgpu::Device, queue: &wgpu::Queue) {
        self.stamps.n.set(0);
        self.stamps.labels.borrow_mut().clear();
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame time") });
        self.stamps.write(&mut enc, "start");
        queue.submit([enc.finish()]);
    }

    /// The frame ends (after its last submission): its time is read back as `frame`'s.
    pub(crate) fn end(&self, device: &wgpu::Device, queue: &wgpu::Queue, frame: u32) {
        let s = &self.stamps;
        if s.n.get() == 0 { return; }
        let Some((buf, free)) = self.read.iter().find(|(_, f)| *f.borrow()) else { return };
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame time") });
        s.write(&mut enc, "gap");
        let n = s.n.get();
        let labels = std::mem::take(&mut *s.labels.borrow_mut());
        s.n.set(0);
        enc.resolve_query_set(&s.set, 0..n, &self.resolve, 0);
        enc.copy_buffer_to_buffer(&self.resolve, 0, buf, 0, n as u64 * 8);
        queue.submit([enc.finish()]);
        *free.borrow_mut() = false;
        let (b, f, period, detail) = (buf.clone(), free.clone(), self.period as f64, s.detail.get());
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            if let (true, Ok(d)) = (r.is_ok(), b.slice(..).get_mapped_range()) {
                let t: Vec<u64> = (0..n as usize).map(|i| u64::from_le_bytes(d[i * 8..i * 8 + 8].try_into().unwrap())).collect();
                drop(d);
                let (t0, t1) = (t[0], t[t.len() - 1]);
                if t1 > t0 {
                    TIMES.with(|x| x.borrow_mut().push((frame, (t1 - t0) as f64 * period / 1e6)));
                    if detail {
                        STAGES.with(|st| {
                            let mut st = st.borrow_mut();
                            for i in 1..t.len() {
                                let ms = t[i].saturating_sub(t[i - 1]) as f64 * period / 1e6;
                                // the wait after the frame's start is the CPU encoding its first submission
                                let k = if labels[i] == "gap" && labels[i - 1] == "start" { "gap: first submit" } else { labels[i] };
                                let e = st.entry(k).or_insert((0.0, 0));
                                e.0 += ms; e.1 += 1;
                            }
                            let e = st.entry("frames").or_insert((0.0, 0));
                            e.0 += (t1 - t0) as f64 * period / 1e6; e.1 += 1;
                        });
                    }
                }
            }
            b.unmap();
            *f.borrow_mut() = true;
        });
    }
}

/// The frames timed since the last call: frame, GPU milliseconds, in pairs.
pub(crate) fn take() -> Vec<f64> {
    TIMES.with(|t| t.borrow_mut().drain(..).flat_map(|(f, ms)| [f as f64, ms]).collect())
}

/// The stages timed since the last call, a line each: name, GPU milliseconds, spans
/// (`frames` is the frames' whole spans).
pub(crate) fn take_stages() -> String {
    STAGES.with(|st| {
        let mut v: Vec<_> = st.borrow_mut().drain().collect();
        v.sort_by(|a, b| b.1.0.total_cmp(&a.1.0));
        v.iter().map(|(k, (ms, n))| format!("{k}\t{ms:.3}\t{n}\n")).collect()
    })
}
