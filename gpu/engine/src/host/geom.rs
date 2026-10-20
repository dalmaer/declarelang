//! The host's arithmetic: transforms, device rectangles, colours, gradients, filter passes,
//! paths and homographies. Every number is an f64 and every rule is JavaScript's (Math.max
//! passes NaN on, Math.round rounds halves up), so the commands are the TypeScript host's.

use std::cell::RefCell;
use std::collections::HashMap;

use serde_json::Value;

/// A 2D affine transform: a b c d e f (x' = a·x + c·y + e, y' = b·x + d·y + f).
pub(crate) type M = [f64; 6];
pub(crate) const I: M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

pub(crate) fn mul(a: &M, b: &M) -> M {
    [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}
pub(crate) fn translate(x: f64, y: f64) -> M { [1.0, 0.0, 0.0, 1.0, x, y] }
pub(crate) fn ap(m: &M, x: f64, y: f64) -> (f64, f64) { (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]) }
pub(crate) fn invert_affine(m: &M) -> M {
    let det = m[0] * m[3] - m[1] * m[2];
    if det == 0.0 { return I; }
    let d = 1.0 / det;
    [m[3] * d, -m[1] * d, -m[2] * d, m[0] * d, (m[2] * m[5] - m[3] * m[4]) * d, (m[1] * m[4] - m[0] * m[5]) * d]
}
/// A point through the inverse of `m`.
pub(crate) fn unmap(m: &M, x: f64, y: f64) -> (f64, f64) {
    let det = m[0] * m[3] - m[1] * m[2];
    if det == 0.0 { return (f64::NAN, f64::NAN); }
    let (px, py) = (x - m[4], y - m[5]);
    ((m[3] * px - m[2] * py) / det, (m[0] * py - m[1] * px) / det)
}

/// JavaScript's Math.max and Math.min: NaN wins.
pub(crate) fn jmax(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a > b { a } else { b } }
pub(crate) fn jmin(a: f64, b: f64) -> f64 { if a.is_nan() || b.is_nan() { f64::NAN } else if a < b { a } else { b } }
/// JavaScript's Math.round: halves go up.
pub(crate) fn jround(x: f64) -> f64 { if x.is_finite() && x.fract().abs() != 0.5 { x.round() } else { (x + 0.5).floor() } }

/// A device-space rectangle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Rect { pub x0: f64, pub y0: f64, pub x1: f64, pub y1: f64 }
pub(crate) const EMPTY: Rect = Rect { x0: 0.0, y0: 0.0, x1: 0.0, y1: 0.0 };
pub(crate) const EVERYWHERE: Rect = Rect { x0: f64::NEG_INFINITY, y0: f64::NEG_INFINITY, x1: f64::INFINITY, y1: f64::INFINITY };

/// The device box of (x, y, w, h) under `m`: its four corners' bounds.
pub(crate) fn aabb(m: &M, x: f64, y: f64, w: f64, h: f64) -> Rect {
    let xs = [x, x + w, x, x + w];
    let ys = [y, y, y + h, y + h];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for i in 0..4 {
        let px = m[0] * xs[i] + m[2] * ys[i] + m[4];
        let py = m[1] * xs[i] + m[3] * ys[i] + m[5];
        if px < x0 { x0 = px; }
        if px > x1 { x1 = px; }
        if py < y0 { y0 = py; }
        if py > y1 { y1 = py; }
    }
    Rect { x0, y0, x1, y1 }
}
pub(crate) fn meets(a: &Rect, b: &Rect) -> bool { a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0 }
/// Does `a` hold all of `b`?
pub(crate) fn covers(a: &Rect, b: &Rect) -> bool { a.x0 <= b.x0 && a.y0 <= b.y0 && a.x1 >= b.x1 && a.y1 >= b.y1 }
pub(crate) fn intersect(a: &Rect, b: &Rect) -> Rect {
    Rect { x0: jmax(a.x0, b.x0), y0: jmax(a.y0, b.y0), x1: jmin(a.x1, b.x1), y1: jmin(a.y1, b.y1) }
}
pub(crate) fn union(a: &Rect, b: &Rect) -> Rect {
    Rect { x0: jmin(a.x0, b.x0), y0: jmin(a.y0, b.y0), x1: jmax(a.x1, b.x1), y1: jmax(a.y1, b.y1) }
}

/// A CSS cubic bezier (P0 = 0, P3 = 1) at time t, solved for x by Newton (as LayerTree.swift).
pub(crate) fn bezier_at(b: &[f64; 4], t: f64) -> f64 {
    if t <= 0.0 { return 0.0; }
    if t >= 1.0 { return 1.0; }
    let [x1, y1, x2, y2] = *b;
    let curve = |a: f64, c: f64, u: f64| ((1.0 - 3.0 * c + 3.0 * a) * u + (3.0 * c - 6.0 * a)) * u * u + 3.0 * a * u;
    let slope = |a: f64, c: f64, u: f64| 3.0 * (1.0 - 3.0 * c + 3.0 * a) * u * u + 2.0 * (3.0 * c - 6.0 * a) * u + 3.0 * a;
    let mut u = t;
    for _ in 0..8 {
        let x = curve(x1, x2, u) - t;
        if x.abs() < 1e-5 { break; }
        let d = slope(x1, x2, u);
        if d.abs() < 1e-6 { break; }
        u -= x / d;
    }
    curve(y1, y2, u)
}

// ── JSON values as JavaScript reads them ───────────────────────────────────────

/// `Number(v) || 0`.
pub(crate) fn jnum(v: Option<&Value>) -> f64 {
    let n = match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
        Some(Value::String(s)) => { let t = s.trim(); if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) } }
        Some(Value::Null) | None => 0.0,
        _ => f64::NAN,
    };
    if n.is_nan() { 0.0 } else { n }
}
/// `String(v)`.
pub(crate) fn jstr(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => { let f = n.as_f64().unwrap_or(0.0); if f.fract() == 0.0 && f.abs() < 1e21 { format!("{}", f as i64) } else { format!("{f}") } }
        other => other.to_string(),
    }
}
/// A number field of an object, when it is one (`spec.x ?? d`).
pub(crate) fn field(v: &Value, k: &str) -> Option<f64> { v.get(k).and_then(Value::as_f64) }

// ── an op's arguments as they came (raw JSON, read on demand) ───────────────────

pub(crate) type Raw<'a> = Option<&'a serde_json::value::RawValue>;
/// `Number(v) || 0` of a raw argument.
pub(crate) fn rnum(v: Raw) -> f64 {
    let Some(r) = v else { return 0.0 };
    let t = r.get();
    match t.as_bytes().first() {
        Some(b'-' | b'0'..=b'9') => t.parse::<f64>().ok().filter(|n| !n.is_nan()).unwrap_or(0.0),
        Some(b'n') => 0.0,
        Some(b't') => 1.0,
        Some(b'f') => 0.0,
        _ => jnum(serde_json::from_str::<Value>(t).ok().as_ref()),
    }
}
/// `v == null` of a raw argument.
pub(crate) fn rnull(v: Raw) -> bool { v.is_none_or(|r| r.get() == "null") }
/// The JSON value of a raw argument (an object: a style, a gradient, a field's spec).
pub(crate) fn rval(v: Raw) -> Value { v.and_then(|r| serde_json::from_str(r.get()).ok()).unwrap_or(Value::Null) }
/// `String(v ?? d)` of a raw argument.
pub(crate) fn rstr_or(v: Raw, d: &str) -> String {
    match v {
        None => d.to_string(),
        Some(r) => {
            let t = r.get();
            if t == "null" { return d.to_string(); }
            if t.starts_with('"') && !t.contains('\\') { return t[1..t.len() - 1].to_string(); }
            jstr(&rval(v))
        }
    }
}
/// A colour argument (`rgba(v)`: null for none).
pub(crate) fn rgba_raw(v: Raw) -> Option<u32> {
    let r = v?;
    let t = r.get();
    if t == "null" { return None; }
    if t.starts_with('"') && !t.contains('\\') { return Some(rgba(&t[1..t.len() - 1])); }
    rgba_of(Some(&rval(v)))
}

/// parseFloat: the longest leading number.
fn parse_float(s: &str) -> f64 {
    let s = s.trim_start();
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; }
    let ds = i;
    while i < b.len() && b[i].is_ascii_digit() { i += 1; }
    if i < b.len() && b[i] == b'.' { i += 1; while i < b.len() && b[i].is_ascii_digit() { i += 1; } }
    if i == ds || (i == ds + 1 && b[ds] == b'.') { return f64::NAN; }
    let mut end = i;
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') { j += 1; }
        let es = j;
        while j < b.len() && b[j].is_ascii_digit() { j += 1; }
        if j > es { end = j; }
    }
    s[..end].parse::<f64>().unwrap_or(f64::NAN)
}
/// parseInt(s, 16).
fn parse_hex(s: &str) -> f64 {
    let d: String = s.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if d.is_empty() { f64::NAN } else { u64::from_str_radix(&d, 16).map(|v| v as f64).unwrap_or(f64::NAN) }
}
/// One byte of an rgba number: Math.round(x) & 255.
fn byte(x: f64) -> u32 {
    let r = jround(x);
    if !r.is_finite() { return 0; }
    (((r as i64) as i32) & 255) as u32
}

thread_local! {
    static COLORS: RefCell<HashMap<String, u32>> = RefCell::new(HashMap::new());
}

/// CSS colour text → 0xRRGGBBAA.
pub(crate) fn rgba(css: &str) -> u32 {
    if let Some(v) = COLORS.with(|c| c.borrow().get(css).copied()) { return v; }
    let (mut r, mut g, mut b, mut a) = (0.0, 0.0, 0.0, 1.0);
    let s = css.trim();
    let lower = s.to_ascii_lowercase();
    if let Some(h) = s.strip_prefix('#') {
        let hc: Vec<char> = h.chars().collect();
        let x = |i: usize, n: usize| -> f64 {
            if n == 1 { hc.get(i).map(|c| parse_hex(&format!("{c}{c}"))).unwrap_or(f64::NAN) }
            else { parse_hex(&hc.iter().skip(i).take(2).collect::<String>()) }
        };
        if hc.len() == 3 || hc.len() == 4 { r = x(0, 1); g = x(1, 1); b = x(2, 1); if hc.len() == 4 { a = x(3, 1) / 255.0; } }
        else { r = x(0, 2); g = x(2, 2); b = x(4, 2); if hc.len() == 8 { a = x(6, 2) / 255.0; } }
    } else if (lower.starts_with("rgba(") || lower.starts_with("rgb(")) && s.ends_with(')') && !s[s.find('(').unwrap() + 1..s.len() - 1].contains(')') {
        let inner = &s[s.find('(').unwrap() + 1..s.len() - 1];
        let p: Vec<f64> = inner.split(|c: char| c.is_whitespace() || c == ',' || c == '/').filter(|v| !v.is_empty())
            .map(|v| if v.ends_with('%') { parse_float(v) * 2.55 } else { parse_float(v) }).collect();
        r = p.first().copied().unwrap_or(f64::NAN); g = p.get(1).copied().unwrap_or(f64::NAN); b = p.get(2).copied().unwrap_or(f64::NAN);
        if p.len() > 3 { a = if inner.contains('%') && p[3] > 1.0 { p[3] / 255.0 } else { p[3] }; }
    } else if s == "transparent" { a = 0.0; }
    else if s == "white" { r = 255.0; g = 255.0; b = 255.0; }
    let v = (byte(r) << 24) | (byte(g) << 16) | (byte(b) << 8) | byte(a * 255.0);
    COLORS.with(|c| c.borrow_mut().insert(css.to_string(), v));
    v
}
/// A colour value of the wire (`rgba(v)`: null for none).
pub(crate) fn rgba_of(v: Option<&Value>) -> Option<u32> {
    match v { None | Some(Value::Null) => None, Some(Value::String(s)) => Some(rgba(s)), Some(x) => Some(rgba(&jstr(x))) }
}

/// A gradient's stop offsets with the unset ones filled in, CSS's way (boxpaint.ts
/// resolveStopOffsets): the ends at 0 and 1, the rest spread between their neighbours,
/// and none before its predecessor.
fn stop_offsets(stops: &[(Option<f64>, String)]) -> Vec<f64> {
    let n = stops.len();
    if n == 0 { return Vec::new(); }
    let mut o: Vec<Option<f64>> = stops.iter().map(|s| s.0).collect();
    if o[0].is_none() { o[0] = Some(0.0); }
    if o[n - 1].is_none() { o[n - 1] = Some(1.0); }
    let mut i = 1;
    while i + 1 < n {
        if o[i].is_some() { i += 1; continue; }
        let mut j = i + 1;
        while o[j].is_none() { j += 1; }
        let (from, to) = (o[i - 1].unwrap(), o[j].unwrap());
        for k in i..j { o[k] = Some(from + ((to - from) * (k - i + 1) as f64) / (j - i + 1) as f64); }
        i = j + 1;
    }
    let mut prev = 0.0;
    o.into_iter().map(|v| { prev = jmin(1.0, jmax(prev, v.unwrap())); prev }).collect()
}
/// The wire's stops: [offset | null, colour] pairs.
pub(crate) fn wire_stops(v: Option<&Value>) -> Vec<(Option<f64>, String)> {
    v.and_then(Value::as_array).map(|a| a.iter().map(|s| (s.get(0).and_then(Value::as_f64), s.get(1).map(jstr).unwrap_or_default())).collect()).unwrap_or_default()
}
/// Stops as the engine takes them: offset, rgba pairs.
pub(crate) fn stop_list(stops: &[(Option<f64>, String)]) -> Vec<f64> {
    let offs = stop_offsets(stops);
    let mut out = Vec::with_capacity(stops.len() * 2);
    for (i, (_, c)) in stops.iter().enumerate() { out.push(offs[i]); out.push(rgba(c) as f64); }
    out
}

#[derive(Clone, Debug)]
pub(crate) struct Gradient { pub kind: f64, pub angle: f64, pub cx: f64, pub cy: f64, pub r: f64, pub stops: Vec<f64> }
pub(crate) fn gradient_of(spec: &Value) -> Gradient {
    let stops = stop_list(&wire_stops(spec.get("stops")));
    let kind = match spec.get("kind").and_then(Value::as_str) { Some("radial") => 1.0, Some("conic") => 2.0, _ => 0.0 };
    Gradient { kind, angle: field(spec, "angle").unwrap_or(180.0), cx: field(spec, "cx").unwrap_or(0.5),
        cy: field(spec, "cy").unwrap_or(0.5), r: field(spec, "r").unwrap_or(1.0), stops }
}

/// One filter of the wire (FILTER, BACKDROP).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WireFilter { pub f: String, pub v: Option<f64>, pub color: Option<String>, pub dx: Option<f64>, pub dy: Option<f64>, pub blur: Option<f64> }
pub(crate) fn filters_of(v: Option<&Value>) -> Option<Vec<WireFilter>> {
    let a = v?.as_array()?;
    Some(a.iter().map(|f| WireFilter {
        f: f.get("fn").and_then(Value::as_str).unwrap_or("").to_string(), v: field(f, "v"),
        color: f.get("color").and_then(Value::as_str).map(str::to_string), dx: field(f, "dx"), dy: field(f, "dy"), blur: field(f, "blur"),
    }).collect())
}

/// How small a layer can be made: one whose first pass blurs it whole by σ texels is made at
/// a scale that leaves about 6 to blur (engine Layer); any other at full size.
pub(crate) fn layer_scale_of(passes: &[f64]) -> f64 {
    if passes.first() != Some(&1.0) || passes[1] <= 6.0 { return 1.0; }
    jmax(1.0 / 64.0, 6.0 / passes[1])
}
/// Lengths in the passes (blur σ, shadow offsets and σ) times `s`: into a smaller layer's texels.
pub(crate) fn scale_pass_list(passes: &[f64], s: f64) -> Vec<f64> {
    if s == 1.0 { return passes.to_vec(); }
    let mut out = passes.to_vec();
    let mut i = 0;
    while i < out.len() {
        let kind = out[i];
        if kind == 1.0 { out[i + 1] *= s; i += 3; }
        else if kind == 2.0 { i += 21; }
        else if kind == 3.0 { out[i + 1] *= s; out[i + 2] *= s; out[i + 3] *= s; i += 5; }
        else if kind == 4.0 { i += 2; }
        else if kind == 5.0 { i += 12; }
        else { break; }
    }
    out
}

/// The filter list as layer passes, lengths scaled to texels by `k`; and how far they reach.
pub(crate) fn filter_pass_list(list: &[WireFilter], k: f64) -> (Vec<f64>, f64) {
    let mut passes: Vec<f64> = Vec::new();
    let mut reach = 0.0;
    let color = |c: &Option<String>| rgba(c.as_deref().unwrap_or("#000")) as f64;
    // colorize first, as the canvas renderer does (it has no CSS function)
    for f in list { if f.f == "tint" { passes.push(4.0); passes.push(color(&f.color)); } }
    for f in list {
        let v = f.v.unwrap_or(0.0);
        let mut matrix = |r: [f64; 20]| { passes.push(2.0); passes.extend_from_slice(&r); };
        match f.f.as_str() {
            "blur" => { passes.extend_from_slice(&[1.0, v * k, 0.0]); reach += v * k * 3.0; }
            "shadow" => {
                let sg = (f.blur.unwrap_or(0.0) * k) / 2.0;
                let (dx, dy) = (f.dx.unwrap_or(0.0) * k, f.dy.unwrap_or(0.0) * k);
                passes.extend_from_slice(&[3.0, dx, dy, sg, color(&f.color)]);
                reach += sg * 3.0 + jmax(dx.abs(), dy.abs());
            }
            "brightness" => matrix([v, 0., 0., 0., 0., v, 0., 0., 0., 0., v, 0., 0., 0., 0., 1., 0., 0., 0., 0.]),
            "contrast" => { let o = 0.5 - 0.5 * v; matrix([v, 0., 0., 0., 0., v, 0., 0., 0., 0., v, 0., 0., 0., 0., 1., o, o, o, 0.]) }
            "invert" => { let s = 1.0 - 2.0 * v; matrix([s, 0., 0., 0., 0., s, 0., 0., 0., 0., s, 0., 0., 0., 0., 1., v, v, v, 0.]) }
            "opacity" => matrix([1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., v, 0., 0., 0., 0.]),
            "saturate" | "grayscale" => {
                let s = if f.f == "saturate" { v } else { 1.0 - jmin(1.0, v) };
                matrix([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.,
                        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.,
                        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0.,
                        0., 0., 0., 1., 0., 0., 0., 0.]);
            }
            "sepia" => {
                let a = 1.0 - jmin(1.0, v);
                matrix([0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a, 0.,
                        0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a, 0.,
                        0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a, 0.,
                        0., 0., 0., 1., 0., 0., 0., 0.]);
            }
            "hueRotate" => {
                let t = (f.v.unwrap_or(0.0) * std::f64::consts::PI) / 180.0;
                let (c, s) = (t.cos(), t.sin());
                matrix([0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.,
                        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0.,
                        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0.,
                        0., 0., 0., 1., 0., 0., 0., 0.]);
            }
            _ => {}
        }
    }
    (passes, reach.ceil())
}

/// A rounded rectangle as path numbers (the engine's `path`), each corner an ellipse
/// [rx, ry], top-left clockwise.
pub(crate) fn rrect_path(x: f64, y: f64, w: f64, h: f64, c: &[[f64; 2]; 4]) -> Vec<f64> {
    let k = 0.5522847498;
    let f = [1.0, w / jmax(1e-9, c[0][0] + c[1][0]), w / jmax(1e-9, c[3][0] + c[2][0]),
        h / jmax(1e-9, c[0][1] + c[3][1]), h / jmax(1e-9, c[1][1] + c[2][1])].into_iter().fold(f64::INFINITY, jmin);
    let s = |i: usize| (c[i][0] * f, c[i][1] * f);
    let ((a, aa), (b, bb), (d, dd), (e, ee)) = (s(0), s(1), s(2), s(3));
    vec![
        0.0, x + a, y,
        1.0, x + w - b, y, 3.0, x + w - b + b * k, y, x + w, y + bb - bb * k, x + w, y + bb,
        1.0, x + w, y + h - dd, 3.0, x + w, y + h - dd + dd * k, x + w - d + d * k, y + h, x + w - d, y + h,
        1.0, x + e, y + h, 3.0, x + e - e * k, y + h, x, y + h - ee + ee * k, x, y + h - ee,
        1.0, x, y + aa, 3.0, x, y + aa - aa * k, x + a - a * k, y, x + a, y,
        4.0,
    ]
}

// ── homographies (runtime projective.ts) ────────────────────────────────────────

pub(crate) type H = [f64; 9];
pub(crate) fn apply_h(h: &H, x: f64, y: f64) -> (f64, f64) {
    let w = h[6] * x + h[7] * y + h[8];
    let iw = if w.abs() < 1e-9 { 0.0 } else { 1.0 / w };
    ((h[0] * x + h[1] * y + h[2]) * iw, (h[3] * x + h[4] * y + h[5]) * iw)
}
pub(crate) fn invert_h(h: &H) -> H {
    let [a, b, c, d, e, f, g, hh, i] = *h;
    let aa = e * i - f * hh;
    let bb = -(d * i - f * g);
    let cc = d * hh - e * g;
    let det = a * aa + b * bb + c * cc;
    if det.abs() < 1e-12 { return [0.0; 9]; }
    let s = 1.0 / det;
    [aa * s, -(b * i - c * hh) * s, (b * f - c * e) * s,
     bb * s, (a * i - c * g) * s, -(a * f - c * d) * s,
     cc * s, -(a * hh - b * g) * s, (a * e - b * d) * s]
}
pub(crate) fn in_front(h: &H, x: f64, y: f64) -> bool { h[6] * x + h[7] * y + h[8] > 1e-6 }
pub(crate) fn quad_through(h: &H, x: f64, y: f64, w: f64, hg: f64) -> [(f64, f64); 4] {
    [apply_h(h, x, y), apply_h(h, x + w, y), apply_h(h, x + w, y + hg), apply_h(h, x, y + hg)]
}
pub(crate) fn front_facing(h: &H, w: f64, hg: f64) -> bool {
    let q = quad_through(h, 0.0, 0.0, w, hg);
    let cross = (q[1].0 - q[0].0) * (q[2].1 - q[0].1) - (q[1].1 - q[0].1) * (q[2].0 - q[0].0);
    cross >= 0.0
}
