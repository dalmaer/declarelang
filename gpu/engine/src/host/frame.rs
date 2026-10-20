//! A frame: what it must redraw (the damage), the fast path for a frame that only scrolls a
//! kept layer, the walk, and presenting it.

use super::geom::*;
use super::ct;
use super::walk::Commands;
use super::{Host, Timing};
use crate::Engine;

impl Host {
    /// Paint now if anything changed (the platform's tick, after the runtime's flush, once it
    /// has answered `text_wanted` and `three`).
    pub(crate) fn paint_now(&mut self, e: &mut Engine) {
        if !self.dirty { return; }
        self.dirty = false;
        let t0 = crate::now();
        let rec = if self.flags.census { self.take_census() } else { 0 };
        let (v0, d0) = (self.counts[ct::VISITED], self.counts[ct::DRAWN]);
        let screen = Rect { x0: 0.0, y0: 0.0, x1: jround(self.width * self.dpr), y1: jround(self.height * self.dpr) };
        // a frame drawn whole (new fonts, a resize, a change of scaling) draws every tile again
        if self.full_next {
            for n in self.nodes.values_mut() { if let Some(l) = n.layer.as_mut() { for t in l.tiles.values_mut() { t.ok = false; } } }
        }
        self.only = if self.full_next { None } else { self.only_layer() };
        self.layer_changes();
        let region = self.damage(&screen);
        self.touched.clear();
        if let (Some(only), Some(r)) = (self.only, region) {
            if r.x1 > r.x0 && self.fast_frame(e, only, r, t0) {
                self.clear_changes();
                if rec > 0 { self.census[rec - 1].path = "fast"; }
                return;
            }
        }
        self.clear_changes();
        self.full_next = false;
        if let Some(r) = region {
            if r.x1 <= r.x0 {                                    // nothing visible changed
                self.damage_counts[2] += 1.0;
                if rec > 0 { self.census[rec - 1].path = "skip"; }
                self.place_edits();
        self.place_page();
                self.place_islands();
                return;
            }
        }
        let clip = region.unwrap_or(screen);
        e.begin();
        self.cmd = Commands::default();
        self.snap = None; self.since_snap.clear(); self.frame_clip = clip; self.in_frame_cmd = true; self.passes = 0;
        e.frame_start(clip.x0 as u32, clip.y0 as u32, (clip.x1 - clip.x0) as u32, (clip.y1 - clip.y0) as u32, self.page.unwrap_or(0xffff_ffff));
        // the finest any frost on screen needs: one snapshot taken at it serves them all
        self.snap_scale = 0.0;
        for i in 0..self.effects.len() {
            if let Some(b) = self.nd(self.effects[i]).backdrop.as_ref() { self.snap_scale = jmax(self.snap_scale, layer_scale_of(&filter_pass_list(b, self.dpr).0)); }
        }
        if let Some(root) = self.root { let d = self.dpr; self.paint(e, root, &[d, 0.0, 0.0, d, 0.0, 0.0], &clip, false, false); }
        if rec > 0 {
            let (v, d) = (self.counts[ct::VISITED] - v0, self.counts[ct::DRAWN] - d0);
            let r = &mut self.census[rec - 1];
            r.visited = v; r.drawn = d; r.path = if region.is_none() { "whole" } else { "region" };
        }
        self.frames += 1;
        let id = self.frames;
        // the region over a kept layer is kept with it, when nothing cut it after the tiles
        let keep_above = match self.above_for { Some(a) if self.cuts_after == 0 => self.nd(a).layer.as_ref().and_then(|l| l.cache.as_ref()).map(|c| c.above), _ => None };
        if let Some(above) = keep_above { e.frame_keep_next(above); }
        self.cut(e);
        if let (Some(a), None) = (self.above_for, keep_above) { if let Some(l) = self.nm(a).layer.as_mut() { l.cache = None; } }
        self.above_for = None;
        for (b, bm, bc) in std::mem::take(&mut self.bars) { if self.nodes.contains_key(&b) { self.composite_bar(e, b, &bm, &bc); } }
        if let Err(err) = e.frame_present(id) { crate::log(&format!("[gpu] render: {err:?}")); }
        self.sharpen(e);
        match region {
            None => self.damage_counts[0] += 1.0,
            Some(r) => {
                self.damage_counts[1] += 1.0;
                self.damage_counts[3] += ((r.x1 - r.x0) * (r.y1 - r.y0)) / ((screen.x1 - screen.x0) * (screen.y1 - screen.y0));
            }
        }
        self.finish(e, id, t0);
    }

    fn clear_changes(&mut self) { self.changed.clear(); self.changed_set.clear(); self.lost.clear(); }

    /// The frame's record, and the page's fields and islands placed where it put them.
    fn finish(&mut self, e: &mut Engine, id: u32, t0: f64) {
        let t1 = crate::now();
        let ms = t1 - t0;
        if self.frame_log.len() < 5000 { self.frame_log.push(ms); }
        if self.timing.len() < 5000 {
            let input = match self.pending_input { None => -1.0, Some(p) => self.time_origin + t1 - p };
            self.by_id.insert(id, self.timing.len());
            self.timing.push(Timing { id, start: t0, encode: ms, done: 0.0, input_to_submit: input });
        }
        self.pending_input = None;
        self.collect_done(e);
        self.place_edits();
        self.place_page();
        self.place_islands();
    }

    /// A frame that only scrolls (or changes inside) a layer whose surroundings are kept: lay
    /// what is under it, its tiles, what is over it, its scrollbar. False to draw it as usual.
    fn fast_frame(&mut self, e: &mut Engine, l: u32, region: Rect, t0: f64) -> bool {
        let layers = self.flags.layers;
        let Some(ly) = self.nd(l).layer.as_ref() else { return false };
        let Some(c) = ly.cache.clone() else { return false };
        if !layers || !ly.eligible { return false; }
        if c.region != region { return false; }
        e.frame_start(region.x0 as u32, region.y0 as u32, (region.x1 - region.x0) as u32, (region.y1 - region.y0) as u32, self.page.unwrap_or(0xffff_ffff));
        if !e.frame_blit(c.below, false) { self.nm(l).layer.as_mut().unwrap().cache = None; return false; }
        e.begin();
        self.cmd = Commands::default(); self.in_frame_cmd = true; self.frame_clip = region; self.snap = None; self.since_snap.clear(); self.passes = 1;
        let n = self.nd(l);
        let (sx, sy) = (n.vis_x.unwrap_or(n.scroll_x), n.vis_y.unwrap_or(n.scroll_y));
        self.lay_tiles(e, l, &c.m, &c.within, c.pixelated, sx, sy);
        e.frame_blit(c.above, true);
        self.composite_bar(e, l, &c.m, &c.within);
        self.frames += 1;
        let id = self.frames;
        if let Err(err) = e.frame_present(id) { crate::log(&format!("[gpu] render: {err:?}")); }
        self.sharpen(e);
        self.count(ct::FAST);
        self.damage_counts[1] += 1.0;
        self.finish(e, id, t0);
        true
    }

    /// Drawings the engine laid from a raster made elsewhere (moving) are drawn again in the
    /// next frame, where, held still, they are rastered exactly.
    fn sharpen(&mut self, e: &mut Engine) {
        // moving layers are laid sampled: each is drawn again next frame (moved again, it is a
        // layer again; at rest, exactly), as a change of place, which keeps what is kept
        for id in std::mem::take(&mut self.soft) {
            if !self.nodes.contains_key(&id) || !self.showing(id) { continue; }
            if self.changed_set.insert(id) { self.changed.push(id); }
            self.dirty = true;
            self.wants.sharpen = true;
        }
        let ids = e.take_sampled();
        if self.flags.nosharpen { self.sampled_count += ids.len(); return; }
        let mut any = false;
        for id in ids {
            if !self.nodes.contains_key(&id) || !self.showing(id) { continue; }
            self.change(id); any = true;
        }
        if !any { return; }
        self.dirty = true;
        self.wants.sharpen = true;
    }

    /// THE DAMAGE: the device rectangle this frame must redraw — every changed view's area
    /// before (as last painted) and after (its subtree, where it now is), and every area a
    /// removed view leaves — or None for the whole frame (a first frame, a resize, a change
    /// of root or page colour, too many changes, or more than half the screen). An empty
    /// rectangle means nothing visible changed. A change under a 3D view makes the frame whole
    /// (its rects are in the view's plane); one in a mask's stencil damages the views masked.
    fn damage(&self, screen: &Rect) -> Option<Rect> {
        if !self.flags.damage || self.full_next || self.root.is_none() || self.changed.len() > 300 { return None; }
        // a frame about one layer is its box: the layer clips, so nothing of it reaches past
        if let Some(only) = self.only {
            if let Some(v) = self.layer_box(only) {
                let r = intersect(&v, screen);
                return Some(if r.x1 <= r.x0 || r.y1 <= r.y0 { EMPTY } else { Rect { x0: r.x0.floor(), y0: r.y0.floor(), x1: r.x1.ceil(), y1: r.y1.ceil() } });
            }
        }
        let mut d: Option<Rect> = None;
        let mut add = |r: Option<Rect>| if let Some(r) = r { d = Some(match d { None => r, Some(x) => union(&x, &r) }); };
        for r in &self.lost { add(Some(*r)); }
        for &n in &self.changed {
            if !self.nodes.contains_key(&n) { continue; }
            let (three, masks) = self.drawn_through(n);
            if three.is_some() { return None; }
            add(self.nd(n).painted);
            add(self.bounds_now(n));
            for v in masks { add(self.nd(v).painted); add(self.bounds_now(v)); }
        }
        let Some(mut d) = d else { return Some(EMPTY) };
        // A filter or frost the damage touches is made again whole: its layer reads everything
        // in its rect, so the region takes in each such rect, until no more are touched.
        let mut grew = true;
        let mut k = 0;
        while grew && k < 8 {
            grew = false;
            for &e in &self.effects {
                let Some(fx) = self.nd(e).fx_rect else { continue };
                if !meets(&d, &fx) { continue; }
                let u = union(&d, &fx);
                if u.x0 < d.x0 || u.y0 < d.y0 || u.x1 > d.x1 || u.y1 > d.y1 { d = u; grew = true; }
            }
            k += 1;
        }
        let r = intersect(&d, screen);
        if r.x1 <= r.x0 || r.y1 <= r.y0 { return Some(EMPTY); }
        if !(r.x0 + r.x1 + r.y0 + r.y1).is_finite() { return None; }
        // a little margin for antialiased edges, on whole pixels — none for a frame about one layer
        let mg = if self.only.is_some() { 0.0 } else { 2.0 };
        let out = Rect { x0: jmax(0.0, r.x0.floor() - mg), y0: jmax(0.0, r.y0.floor() - mg), x1: jmin(screen.x1, r.x1.ceil() + mg), y1: jmin(screen.y1, r.y1.ceil() + mg) };
        let area = (out.x1 - out.x0) * (out.y1 - out.y0);
        let whole = (screen.x1 - screen.x0) * (screen.y1 - screen.y0);
        // past half the screen a whole frame costs about the same — except a frame about one layer
        if area > whole / 2.0 && self.only.is_none() { None } else { Some(out) }
    }

    /// A layer's viewport box on the screen now, through its ancestors (None when it does not show).
    fn layer_box(&self, l: u32) -> Option<Rect> {
        let chain = self.chain(l);
        if chain.first().copied() != self.root { return None; }
        let mut m: M = [self.dpr, 0.0, 0.0, self.dpr, 0.0, 0.0];
        for &k in &chain {
            let kn = self.nd(k);
            if !kn.visible || kn.opacity <= 0.0 { return None; }
            m = mul(&m, &self.local(k));
            if k != l && (kn.scroll_x != 0.0 || kn.scroll_y != 0.0) { m = mul(&m, &translate(-kn.scroll_x, -kn.scroll_y)); }
        }
        Some(self.view_box(l, &m))
    }

    /// Where node `id`'s subtree now draws, in device pixels (None when it does not show).
    fn bounds_now(&self, id: u32) -> Option<Rect> {
        let chain = self.chain(id);
        if chain.first().copied() != self.root { return None; }                      // not attached
        let mut m: M = [self.dpr, 0.0, 0.0, self.dpr, 0.0, 0.0];
        for (i, &k) in chain.iter().enumerate() {
            let kn = self.nd(k);
            if !kn.visible || kn.opacity <= 0.0 { return None; }
            m = mul(&m, &self.local(k));
            if k != id && (kn.scroll_x != 0.0 || kn.scroll_y != 0.0) && !self.nd(chain[i + 1]).ignore_scroll { m = mul(&m, &translate(-kn.scroll_x, -kn.scroll_y)); }
        }
        self.subtree_bounds(id, &m)
    }

    /// Match the GPU's finished frames to their records.
    pub(crate) fn collect_done(&mut self, e: &mut Engine) {
        let d = e.gpu_done();
        for p in d.chunks(2) {
            if let Some(i) = self.by_id.remove(&(p[0] as u32)) { if let Some(t) = self.timing.get_mut(i) { t.done = p[1]; } }
        }
    }
}
