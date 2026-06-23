# Architecture

A public condensation of the control-tower design. The GUI is a desktop view over
the `video-pipeline` CLI: it runs steps, streams their output, and previews the
layers each step produces. It is not an editor.

## Tenets

Five tenets constrain every decision; the rest is their consequences.

1. **The CLI is first-class.** The GUI is a view over it — a command/parameter
   library and a previewer. The CLI runs headless without the GUI.
2. **Simplify without obfuscating.** The resolved `argv` is always on screen and
   copyable. The form and the terminal are two views of one truth.
3. **Zero hardcoding.** No step, field, flag, layer, or export target is baked in;
   everything is discovered at runtime from a schema.
4. **Single source of truth.** Editing the pipeline's schema changes the GUI's
   forms, preview sources, and export targets on next launch — no recompile.
5. **Deny-by-default at the boundary.** A malformed schema fails loudly at load; a
   task whose declared inputs are missing is blocked before it runs.

## Three layers

- **Frontend (webview):** pure presentation — schema-driven forms, the previewer,
  the resolved-command preview, the log view. No pipeline knowledge beyond the
  schema.
- **Rust core (Tauri):** the engine — schema gateway, dependency scheduler, process
  supervisor, state store. The complexity lives here, where Rust is strongest.
- **Python CLI:** owns the steps, the schema, artifact production, and the
  exporters. The GUI invokes it; it never reimplements it.

## Three contracts

The stability comes from the contracts between the layers, not the layers.

- **Schema** (Python → Rust → Frontend): YAML authored by the pipeline, validated
  and normalized to JSON at the Rust boundary.
- **IPC** (Frontend ↔ Rust): Tauri `invoke` commands and `emit` events (log lines,
  task status, scheduler progress).
- **Process** (Rust ↔ Python): `argv` assembled from schema + form state; output
  captured line-by-line; exit code; a post-exit check that declared output
  artifacts appeared on disk.

## Schema as single source of truth

The schema carries the steps (UI groupings), tasks (schedulable graph nodes),
artifacts (the graph's edges), parameters, and export targets in one document. The
Rust gateway validates it against a versioned, GUI-owned meta-schema grammar
(deny-by-default) and normalizes it for the frontend. The pipeline owns *what* the
steps are; the meta-schema owns what *conformant* means. Adding a step on the
pipeline side surfaces in the GUI with no recompile.

## The scheduler: two failure modes

The scheduler builds the task DAG, levels it topologically (a level's tasks run in
parallel, levels run in series, under a configurable max-concurrency cap), and
distinguishes two ways a step can be absent from the output:

- **Skip** (not in the workflow): a **compile-time graph transform** — drop the
  node, rebind its consumers to the nearest enabled producer. The graph rewires
  cleanly; it is not a failure.
- **Fail** (in the workflow but errored): a **runtime cascade** — every task
  reverse-reachable from the break becomes `Blocked`; independent branches run to
  completion. A non-zero exit *or* an exit-zero run that didn't produce its
  declared artifacts both count as failure.

The computed plan is shown before it runs — what executes, what parallelizes, what
is skipped and why. The scheduler is a glass box, not a black box.

## Channel binding and descriptors

Artifacts are **channels**, not fixed files. A channel (e.g. `base`) may be written
by a chain of tasks, each transforming it; a consumer binds to the **latest enabled
writer** of that channel. Disable an intermediate writer and consumers rebind to
the nearest remaining producer automatically — this is what makes skipping clean.

Cross-branch edges stay thin via **descriptors**. A spatially-aware consumer reads a
light descriptor (bounding regions, coverage, flags), never another branch's
frames — so the dependency edge is metadata-weight and no branch ever decodes
another's media.

## Previewer

A **single `<video>` element**. The layer selector swaps its `src` between
previewable artifacts and the composite — no canvas, no multi-file sync. Available
sources are the schema's previewable artifacts intersected with the files present on
disk: the form shows capability, the previewer shows produced reality. Playhead and
play-state are preserved across swaps, so switching layers feels like flipping
channels on one timeline. The one webview-dependent case — previewing a transparent
layer in isolation — was designed around rather than bet on: the pipeline bakes each
transparent layer over a checkerboard into an opaque **h264 proxy** (`proxy` step →
`*.preview.mp4`), and the alpha `.mov` layers are marked non-previewable. The
previewer therefore only ever plays opaque h264 and never depends on webview alpha
decoding. (The original `alpha-spike.md` de-risk, now superseded, is kept for
history.)

## Shell decision

**Tauri, Mac-first.** The hard subsystem is the backend (scheduler + process
orchestration), which is Rust's strength; the frontend is trivial for any shell.
Tauri's main downside — cross-platform webview variance — evaporates on a single
target, which is also where the pipeline already runs. Footprint is single-digit MB.
Windows/Linux support, if ever required, would mean revisiting webview codec
coverage before assuming the previewer ports.

---

The full internal design record is maintained separately by the project maintainer.
