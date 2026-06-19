# video-pipeline-gui

A desktop **control tower** over the [`video-pipeline`](../video-pipeline) command-line
tool. It runs pipeline steps, streams their output live, and previews the layers
each step produces.

It is **not an editor**, and it never hides the CLI. Everything the GUI does, you
could do by hand in a terminal — and the GUI always shows you the exact command it
is about to run, before and during execution, copyable. The form and the terminal
are two views of the same truth. Real editing happens downstream in your NLE
(Premiere, Final Cut, Resolve); this app handles the mechanical pre-edit labor the
CLI already automates and gives it a glass-box front end.

> **Status:** early / experimental. Mac-first. `schema_version` 0.1.0. The schema
> grammar is still moving; see [the repo-topology note](#repository-topology) and
> [`docs/alpha-spike.md`](docs/alpha-spike.md) for the one residual engine risk.

## Design tenets

Five tenets constrain every decision in the architecture. They are the reason the
app is shaped the way it is.

1. **The CLI is first-class.** The GUI is a *view* over it — a library of commands
   and parameters and a previewer for results. The CLI runs headless without the
   GUI; the GUI never reimplements pipeline logic, it invokes it.
2. **Simplify without obfuscating.** The resolved command string is always on
   screen and copyable. You grow to understand the CLI by using the GUI, not
   despite it.
3. **Zero hardcoding.** No pipeline step, field, flag, layer, or export target is
   baked into the GUI. Everything is discovered at runtime from a schema.
4. **Single source of truth.** Editing the pipeline's schema changes the GUI's
   forms, preview sources, and export targets on next launch — no recompile.
5. **Deny-by-default at the boundary.** A malformed schema fails loudly at load. A
   task whose declared inputs don't exist is blocked before it runs, not
   mid-stream.

## Architecture overview

Three layers, each with one responsibility. The stability comes from the
**contracts between them**, not the layers themselves.

| Layer | Role |
|---|---|
| **Frontend** (webview) | Pure presentation: schema-driven forms, the single-`<video>` previewer, the resolved-command preview, the live log view. No pipeline knowledge beyond the schema it is handed. |
| **Rust core** (Tauri) | The engine. Schema gateway, dependency scheduler, process supervisor, state store. Where the real complexity lives, deliberately — it is what Rust is best at. |
| **Python CLI** (`video-pipeline`) | Owns everything substantive: the steps, the schema document, artifact production, the editor exporters. Fully runnable on its own. |

The three contracts:

| Contract | Between | Form |
|---|---|---|
| **Schema** | Python → Rust → Frontend | YAML authored by the pipeline; validated and normalized to JSON at the Rust boundary |
| **IPC** | Frontend ↔ Rust | Tauri `invoke` commands (run a plan, read state) + `emit` events (log lines, task status, scheduler progress) |
| **Process** | Rust ↔ Python | `argv` assembled from schema + form state; stdout/stderr captured line-by-line; exit code; a post-exit check that declared output artifacts actually appeared |

Two pieces carry most of the engineering weight:

- **The dependency scheduler.** It builds a task DAG from the schema, levels it
  topologically (tasks in a level have no inter-dependency and run in parallel,
  levels run in series), and distinguishes two failure modes. A step *not in the
  workflow* is a **skip** — a compile-time graph transform that drops the node and
  rebinds its consumers to the nearest enabled producer; the graph rewires cleanly.
  A step *in the workflow but failed* is a **fail-cascade** — every task
  reverse-reachable from the break becomes `Blocked`, while independent branches
  run to completion. The computed plan is shown before it runs: what executes, in
  what order, what runs in parallel, and what is skipped and why.
- **The previewer.** Deliberately the simplest thing that works: a **single
  `<video>` element** whose `src` the layer selector swaps between previewable
  artifacts and the composite. No canvas, no multi-file sync. Playhead and
  play-state are preserved across swaps, so switching layers feels like flipping
  channels on one timeline. Available sources are the schema's previewable
  artifacts intersected with the files actually present on disk.

## The schema contract

The schema is the load-bearing artifact and the mechanism behind tenets 3 and 4.

The pipeline emits it:

```bash
video-pipeline schema --format yaml
```

The Rust **schema gateway** is the only component that ever touches YAML. It reads
the authored document, validates it against
[`schema/meta-schema.json`](schema/meta-schema.json) — the versioned, GUI-owned
grammar — and normalizes it to JSON for the frontend. Validation is
deny-by-default: a malformed schema fails loudly at load rather than producing a
broken form.

Because the schema carries the steps, tasks, artifacts, parameters, and export
targets, **adding a pipeline step surfaces in the GUI with no recompile.** Define
the step on the pipeline side, re-emit, relaunch — the new form, preview source,
or export target appears. The pipeline owns *what* the steps are; the GUI's
meta-schema owns what *conformant* means. See
[`../video-pipeline/docs/gui-schema.md`](../video-pipeline/docs/gui-schema.md) for
the pipeline side of the contract.

## Repository layout

```
src-tauri/                 Rust core (Tauri)
  schema.rs                schema gateway — YAML in, validate, normalize to JSON
  scheduler.rs             dependency scheduler — the hard core (DAG, levels, cascade)
  supervisor.rs            process supervisor — spawn, stream, verify artifacts
  state.rs                 lightweight kv store (paths, projects, per-project session)
  command.rs               argv assembly from schema + form state
src/                       TypeScript frontend (presentation only)
schema/
  meta-schema.json         the versioned grammar (this is the contract)
tests/
  contract_test.py         loads a pipeline-emitted schema, asserts it parses + holds invariants
  fixtures/sample-schema.json   a real emitted schema instance
docs/
  architecture.md          public condensation of the design
  alpha-spike.md           the one residual engine-risk runbook
```

## Build & run

These steps require a local toolchain — there is no prebuilt binary yet.

**Prerequisites**

- A **Rust toolchain** + `cargo`
- **Node** (for the frontend build)
- The **Tauri CLI**
- A checkout of the [`video-pipeline`](../video-pipeline) repo (a sibling
  directory by default; the contract test reads it to diff-check live emits)

**Run the tests**

```bash
# Rust gateway + scheduler unit tests
cd src-tauri && cargo test

# Contract test: validates the committed fixture against the meta-schema,
# and (if the sibling video-pipeline repo is importable) diff-checks a live
# pipeline emit against the fixture to catch drift.
python3 tests/contract_test.py
```

Point the contract test at a non-default pipeline checkout with the
`VIDEO_PIPELINE_SRC` environment variable.

**Run the app**

```bash
npm install
npm run tauri dev
```

## Repository topology

The GUI and the pipeline currently live as **co-located but separate packages**
during the contract-bootstrap phase. They are decoupled at runtime by the schema
(a new pipeline step needs zero GUI code change), but one seam — the **meta-schema
grammar** — churns hard early, and grammar changes span all three layers at once
(Python emits, Rust validates, frontend renders). Atomic single-package changes
beat coordinating a split during that churn.

The split into a dedicated repo is triggered when **`schema_version` reaches a
stable 1.0** — once grammar changes go quiet, runtime decoupling means the two
almost never co-change, and lifting the GUI out becomes a move rather than a
refactor. Three invariants hold regardless of which side of the split you are on,
to keep that move cheap:

1. **One-way dependency: GUI → pipeline.** The pipeline imports nothing from the
   GUI. This is what makes the future split a move, not a rewrite.
2. **The meta-schema is an explicit, versioned artifact** owned by the GUI's Rust
   validator. The pipeline emits conformant YAML; the GUI defines conformant.
3. **A contract test** loads a pipeline-emitted schema and asserts the GUI parses
   and renders it — written while the two live together, kept as the honesty check
   once they are apart.

## Known limitation

The previewer's ability to play a **transparent** layer in isolation depends on
the OS webview decoding HEVC-with-alpha in a plain `<video>` element. This is the
one engine-dependent behavior in the design and is gated behind a de-risk spike
before the relevant previewer phase is built. See
[`docs/alpha-spike.md`](docs/alpha-spike.md).
