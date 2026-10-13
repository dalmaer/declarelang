# User-definable shaders — a view seen through a program's own pixel shader

*2026-10-13. Designed, not built. A program supplies a fragment shader; a view names it as
its effect; the renderer runs the view's painted subtree through it. The first case is a CRT
(Stargate on a monitor's glass), prototyped as a one-off in the canvas renderer and taken
back out; it now lives outside the repository, and is to be rewritten as the first shader
in this form.*

---

## 1. What it is for

A view's look today is a fixed vocabulary: fill, border, shadow, `filter` (blur,
brightness and the rest, graphics-pass.md §1), `mask`, blend, `scaling`. That covers an
interface. It does not cover a picture that has to be made to look like something physical:
a cathode-ray tube, film grain, a lens, a halftone print, a heat shimmer, a page under
water. Each of those is a small per-pixel program over an image, and every graphics stack
that serves such work lets the author write that program.

The prototype showed what one costs: a pixelated view's layer handed to WebGL, a fragment
shader of about 150 lines (beam profile per colour channel, aperture mask in screen space,
glow, linear light, curved glass, bezel with its reflection, glare), 16.6 ms a frame at
full window on an M2 Max — the frame the game already had. What it lacked was a place in the
language: it was switched on by an address parameter, hard-wired to `pixelated`, and its
parameters were a panel the program could not see.

## 2. Precedents

- **SwiftUI `layerEffect` / `colorEffect` / `distortionEffect`** (iOS 17, macOS 14). A
  Metal function in the app's bundle, named through `ShaderLibrary`; arguments passed as
  typed values (`.float`, `.color`, `.image`); applied as a modifier to any view, with a
  declared `maxSampleOffset` so the system knows how far outside the view the shader reads.
  The closest model: a shader is a resource, its uniforms are ordinary values, any view can
  wear one.
- **Flutter `FragmentProgram`.** GLSL source in the app's assets, compiled at build time to
  each backend (SPIR-V → SkSL, MSL, GLSL ES). Uniforms are set by index from Dart. Shows
  that one authored language translated per backend is workable at product scale.
- **RetroArch shader presets** (`.slangp`). The CRT field's own format: a chain of passes,
  each a GLSL (Vulkan-flavoured) file, with parameters declared in the shader source
  (`#pragma parameter`) and exposed to the person as sliders. Shows that CRT shaders want
  several passes and named, ranged parameters — and that the parameters belong to the
  shader, not to the host.
- **Shadertoy.** A fixed input contract (`iResolution`, `iTime`, `iChannel0…`) is what makes
  a fragment shader portable between authors: the shader is written against names the host
  promises.
- **CSS custom filters** (the abandoned `filter: custom()` of 2012) are the warning: they
  were withdrawn over timing attacks — a shader reading cross-origin pixels can leak them
  through how long it takes. Section 6 says how that is answered here.

## 3. Options

1. **A filter function that takes source text** — `filter = shader("crt.glsl", { … })`.
   Least new vocabulary, but parameters become an untyped bag, the checker can see nothing,
   and a filter list is the wrong home for a program with its own state.
2. **A `Shader` member and an `effect` attribute** (recommended). A shader is a declared
   member with a source file; its uniforms are its typed attributes, so constraints,
   springs and data drive them like any other value; a view names it with `effect`.
3. **Shaders as a kind of `draw()`** — a drawing command that runs a shader over an image.
   Covers generated images (noise, gradients) but not the main case, which is a view's own
   painted subtree, including text and controls it does not draw itself.

Option 2 is the one specified below. Option 3's case (a shader that makes an image from
nothing) falls out of it: a `Shader` applied to an empty view with a fill.

## 4. The form

```declare
tube: Shader [ source = "crt.glsl",
    sharpness: number = 0.6,
    maskStrength: number = { app.settings.mask },   // a constraint, like any attribute
    curvature: number = 0.08,
    glare: number = 0.15
    ],

screen: View [ scale = { app.unit }, scaling = pixelated, effect = { app.tube } ]
```

- **`Shader`** is a Node-like member (no box, never drawn itself). `source` names a GLSL
  ES 3.00 fragment shader, resolved like any address in the program (a path relative to the
  program that names it). Its declared attributes are its uniforms, by name: a `number` is a
  `float`, a `Point`/`Size` a `vec2`, a `Color` a `vec4` (linear, premultiplied), a
  `boolean` a `bool`, an `Image` a `sampler2D`. A uniform the source declares that the
  member does not, or one whose type disagrees, is a compile error naming both places
  (section 7).
- **`effect`** on any view: `null` (the default) or a `Shader`. One shader may serve
  several views; each runs it over its own layer. A view with an effect is an isolating
  group, as a view with a `filter` is now: its subtree is painted to a layer, then the
  layer is drawn through the shader. `filter`, `mask` and `opacity` apply after the effect,
  in that order.
- **Changing a uniform** repaints only the effect pass, not the subtree, unless the
  subtree also changed. A shader that reads `time` asks for a frame every display frame
  while its view is showing; one that does not is idle like any other view (idle-zero).

### The input contract

Every shader is written against the same names, which the host supplies:

| name | type | meaning |
|---|---|---|
| `layer` | `sampler2D` | the view's painted subtree, premultiplied, in device pixels |
| `layerSize` | `vec2` | the layer's size in device pixels |
| `viewSize` | `vec2` | the view's size in its own units |
| `unitScale` | `float` | device pixels to one of the view's units (the composed transform's magnitude × density) — so a pixelated source is sampled at its own pixels' centres, as the prototype does |
| `origin` | `vec2` | where the view's (0,0) falls in the layer, device pixels |
| `time` | `float` | seconds since the effect was first shown (reading it makes the effect animate) |
| `fragCoord` | `in vec2` | this fragment, layer device pixels |
| `fragColor` | `out vec4` | the result, premultiplied |

A view's units, not device pixels, are what a shader's parameters are written in (a mask
pitch of 0.33 of a source pixel, a bezel of 12 units), with `unitScale` converting — the
rule drawing lengths already follow (drawing units, graphics-pass.md).

**Bleed.** A shader may draw outside the view's box (a glow, a bezel). The member says how
far: `bleed: Inset = 24` (in the view's units). The layer is that much larger, and the dirty
region and the hit box account for it; the hit box does not grow — input stays where the
view is (section 9).

## 5. Source language and translation

**GLSL ES 3.00 is the authored language**, because it is what WebGL 2 runs as written, what
nearly every published shader (Shadertoy, RetroArch's GLSL) is already in, and what has the
best translators to the others.

- **Browser, canvas renderer.** The source is wrapped with the contract's declarations and
  compiled by WebGL 2 at first use. One WebGL context for the whole program, shared by every
  effect, its canvas never in the page; its result drawn into the 2D canvas
  (`drawImage` of the WebGL canvas), as the prototype did.
- **Mac.** The source is translated once, when the program is built for the Mac (or when it
  loads, in development): **glslang** compiles GLSL to SPIR-V, **SPIRV-Cross** turns SPIR-V
  into Metal Shading Language, and the result is compiled to a Metal library and cached by
  the source's hash. At paint, the view's layer subtree is rendered into a Metal texture
  (`CARenderer` over the sublayer tree) and the fragment function draws it into a
  `CAMetalLayer` that takes the view's place — Metal as the escape hatch native-host.md
  already allows for hot surfaces. Both translators are C++ libraries, linked into the host,
  not run as tools; the Mac app stays self-contained.
- **Per-host source.** A shader may give a hand-written source for one host
  (`source = "crt.glsl"`, `metal = "crt.metal"`) where translation falls short or a
  host-specific feature is wanted. The contract's names are the same.
- **DOM renderer: later.** CSS has no custom fragment shader. The route is to paint the
  view's subtree with the canvas renderer inside its DOM box (an island of canvas, as
  deferred work) or, where a browser offers it, to draw the element into a canvas
  (the HTML-in-canvas proposal). Until then a view with an effect on the DOM renderer is
  drawn without it, and the checker says so once, as for any capability a host lacks.

## 6. Safety

A shader sees only its own view's layer, which the program painted. A cross-origin image
painted into that layer without CORS taints it, exactly as it would taint a canvas; the
effect is then skipped for that frame and the console says why. That closes the timing
channel that sank CSS custom filters: a shader never reads pixels the program could not
read itself.

## 7. Checking and errors

- **Uniforms.** At compile, the source is scanned for `uniform` declarations (a small
  parser, not a GLSL compiler); each must match an attribute of the member in name and type,
  except the contract's names, which the member may not declare. Ranges come from the
  attribute's type as usual.
- **Shader compile errors.** WebGL and glslang report line numbers in the wrapped source;
  the host subtracts the wrapper and reports them as `crt.glsl:42: …` with the shader's own
  text, under one Declare error code, at the first frame the effect is shown (browser) or at
  build (Mac). A failed shader leaves its view drawn plainly.
- **declare-help / docs**: `Shader`, `View.effect` and the contract table are reference
  pages like any member's.

## 8. Cost and slimming

The module (the WebGL context, the wrapper, the pass) ships only in a program that declares
a `Shader` (a capability, `effects`, as `files` is); elsewhere a stand-in answers. The
compiled program is cached per source hash; layers are reused frame to frame at the same
size. The Mac translators are linked into the host once; the per-program cost is the cached
Metal library.

## 9. Later

- **Several passes.** A CRT is commonly done in passes (a horizontal beam pass, a vertical
  one, a glow at reduced size, a composite). The form: `effect = { [app.beam, app.glow,
  app.tube] }`, each pass's output the next one's `layer`, with an optional `scale` per pass
  and `previous` / named outputs as extra samplers (RetroArch's model). The single-pass form
  is the list of one.
- **Feedback.** A shader that reads its own last frame (phosphor persistence) — a
  `history` sampler, one frame back.
- **Input through a distortion.** A curved screen moves what is drawn away from where the
  view is; a press on the glass should find what it shows. A shader that distorts would
  supply the inverse mapping as a second, small function (`vec2 unmap(vec2)`) the hit walk
  calls. Not needed for the first case: Stargate takes no pointer input.
- **Images as uniforms beyond the layer** (a mask texture, a LUT), declared as `Image`
  attributes — in the type mapping above, but not needed for the CRT.

## 10. The first shader

The prototype (`crtPass`, its parameters `sharp`, `beamMin`, `beamMax`, `mask`,
`maskStrength`, `pitch`, `glow`, `gammaIn`, `gammaOut`, `boost`, `vignette`, `radius`,
`dist`, `fill`, `bezel`, `corner`, `reflect`, `glare`) becomes `crt.glsl` beside
Stargate, a `Shader` member whose attributes are those parameters, and
`effect = { app.tube }` on Stargate's `screen`. Building that is the test of this design:
the result must look and cost the same as the prototype on the canvas renderer, and the
same on the Mac.
