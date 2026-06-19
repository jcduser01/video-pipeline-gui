# Alpha-in-`<video>` de-risk spike

**Question:** can the OS webview (WKWebView on macOS) play a **transparent
HEVC-with-alpha** layer, alone, in a plain `<video>` element — against a
checkerboard backdrop — clearly enough that a caption overlay reads
unambiguously and playback is smooth?

This is the one engine-dependent behavior in the whole design. It must pass before
the isolated-transparent-layer previewer is committed.

## Why it matters

The previewer is deliberately a **single-`<video>` source-switcher**: the layer
selector swaps the element's `src` between previewable artifacts and the composite.
No canvas, no WebCodecs, no multi-file sync. That simplicity buys reliability for
every opaque source automatically.

Exactly **one** case depends on webview codec behavior: previewing an *isolated
transparent layer*. The pipeline's caption overlay (artifact id `caption`,
`layers/captions.mov`, `codec_hint: hevc-alpha`) is a transparent HEVC-alpha
`.mov`. When you select just that layer, its alpha must composite correctly over
whatever sits behind the `<video>` element — otherwise an isolated caption preview
is meaningless (text floats on an undefined or black-filled background and you
cannot tell transparent from opaque-black).

If the webview honors the alpha channel, the entire previewer stays as designed. If
it does not, only this one case is affected and there is a documented fallback
(below) — but it changes what "preview a single layer" can mean, so it is settled
first.

## Test procedure (~30 minutes)

1. **Get a transparent layer file.** Use the pipeline's caption overlay — the
   `caption` artifact, an HEVC-alpha `.mov` (`layers/captions.mov`). Either render
   one via `video-pipeline captions-render …` on a real project, or reuse an
   existing project's `layers/captions.mov`. Confirm it actually carries alpha
   (e.g. `ffprobe` should report an `hevc` stream with an alpha-bearing pixel
   format such as a `…a` / 4-channel format), so the test isn't a false negative on
   an opaque file.

2. **Build a minimal Tauri window.** A bare Tauri shell is enough — no scheduler,
   no schema, no app chrome. One HTML page containing:
   - a full-bleed **checkerboard CSS backdrop** behind the video (a repeating
     conic/linear-gradient or a tiled SVG — the classic transparency-grid look), so
     transparent pixels reveal the checkers and opaque pixels cover them;
   - a single `<video>` element layered over it, `src` set to the alpha `.mov`,
     `autoplay`/`loop`/`muted` so it plays on load;
   - nothing else.

3. **Load it and watch.** Open the window and observe the playing video over the
   checkerboard.

## Pass criteria

All of the following must hold:

- **Transparency renders.** Where the layer is transparent, the checkerboard shows
  through. Where it is opaque (the caption glyphs/strokes), the checkers are
  covered. There is no black (or white) fill replacing the transparent regions.
- **The overlay reads unambiguously.** A viewer can tell, at a glance, which pixels
  are caption and which are background — i.e. the alpha edge is clean, not muddied
  by a matte fringe.
- **Playback is smooth.** The clip plays at rate with no stutter, dropped frames,
  or decode stalls on the target machine.

If all three hold, the single-`<video>` previewer is confirmed as designed and the
Previewer phase proceeds with isolated transparent-layer preview included.

## Fallback if it fails

If WKWebView will not honor alpha in a plain `<video>`, the previewer keeps its
single-`<video>` simplicity for every opaque source and degrades **only** the
isolated-transparent case, via one of:

- **Composite-only preview for transparent layers.** Don't offer an isolated
  transparent layer as a preview source at all; preview transparent layers only as
  part of the composite (where they sit over real frames and alpha is irrelevant to
  the webview, because the compositing already happened upstream).
- **Checkerboard-composited proxy.** Have the pipeline (or a thin preview step)
  emit an opaque proxy of the transparent layer pre-composited over a checkerboard,
  and preview *that* as a normal opaque `<video>` source. The isolated layer is
  still viewable; it is just served as a flattened opaque file rather than relying
  on live webview alpha.

A failure here does **not** reopen the broader shell decision on its own — only if
isolated transparent preview turns out to be a hard requirement would it prompt
re-evaluating a Chromium-based webview.

## Gate

This spike **gates Previewer Phase 4.** The previewer's transparent-layer behavior
is not committed until this test passes, or until the fallback above is adopted in
its place.
