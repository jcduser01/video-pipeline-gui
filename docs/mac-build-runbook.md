# Mac-side build & verification runbook (INI-087)

The control-tower GUI is built and unit-tested, but four classes of check can
only run on an Apple-Silicon Mac with the full toolchain — they need `cargo`, the
Tauri runtime / a webview, `npm`, and the real pipeline runtime deps, none of
which exist in the JasonOS sandbox. This runbook sequences those Mac-only seams,
ties each to the [Definition of Done](../../Governance/digital-organization-governance/portfolio/INI-087.md),
and states the pass criterion and what to report back.

Run the steps in order: each gates the next. Everything is CEO-operated tooling
run via narrowly-scoped Claude Code on the operating machine, outside the
director perimeter (same posture as INI-085).

## What is already verified in the sandbox (don't redo)

These run without a toolchain and are green as of this build:

- **Schema contract** — `python3 tests/contract_test.py`: the committed fixture
  conforms to the meta-schema, the cross-reference invariants hold, the **live
  pipeline emit equals the fixture**, and the reference assembler reproduces the
  argv golden.
- **Algorithm port** — `python3 tests/verify_logic.py`: a stdlib-only port of the
  Rust scheduler and argv assembler re-runs all eight scheduler scenarios and the
  ten golden-argv cases. This is the in-sandbox stand-in for `cargo test`; if you
  change `scheduler.rs` or `command.rs`, mirror it here so the logic stays
  checkable between Mac builds.

The Mac steps below are the parts those can't reach: actual compilation, the
webview, the GUI runtime, and the heavy pipeline deps.

## Step 0 — Preflight

```bash
cd <repo>/video-pipeline-gui
bash scripts/setup-check.sh
```

**Pass:** `all checks passed`. If anything fails, the script prints the fix
(missing `cargo`/`node`, unresolvable Tauri CLI, missing icon assets, or a
wrong-architecture Python wheel). Resolve before continuing.

## Step 1 — Rust unit tests (`cargo test`)

```bash
cd src-tauri && cargo test
```

Covers the schema gateway, the dependency scheduler, the argv assembler, and the
state store. Two checks here are new this build and worth watching:

- `command::tests::golden_argv_matches` — pins the **real** Rust `resolve_argv` to
  `tests/fixtures/golden-argv.json`, the same file the Python reference is pinned
  to. This is what makes the SADD §2.4 "the two assemblers can't diverge"
  invariant actually enforced rather than asserted.
- `scheduler::tests::missing_producer_is_a_plan_time_error` — corrected this build
  (it now expects `caption.define`, the first enabled consumer of `safezone.def`
  in declaration order; the prior expectation of `caption.render` was wrong and
  would have failed here).

**Pass:** all tests green. → DoD: *forms/scheduler/argv* and *repo-topology
contract test* lines. **Report:** the `test result:` summary lines.

## Step 2 — Python contract test against the live pipeline

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements-test.txt
./.venv/bin/pip install -e ../video-pipeline   # brings the pipeline's runtime deps
./.venv/bin/python tests/contract_test.py
```

**Pass:** prints `live emit conforms + matches fixture` **and** `reference
assembler reproduces the argv golden`. If the live emit has drifted from the
fixture, regenerate: `./.venv/bin/python -m video_pipeline.cli schema --format
json > tests/fixtures/sample-schema.json` and re-run Steps 1–2 (the fixture feeds
the Rust tests too). → DoD: *the video-pipeline emits a conformant schema the GUI
consumes*. **Report:** the three `contract:` lines.

## Step 3 — Frontend build + app launch

```bash
npm install
npm run build        # tsc + vite — catches type errors headless
npm run tauri dev
```

**Pass:** `npm run build` exits 0; the app window opens; the schema loads and the
step/param forms render with the resolved-`argv` preview visible. → DoD: *forms
generate from schema; logs stream with resolved argv shown*. **Report:** build
exit status + a one-line confirmation the window renders the form.

## Step 4 — Alpha spike (gates the previewer)

Follow [`docs/alpha-spike.md`](alpha-spike.md) end to end. This is the one
engine-dependent behavior in the whole design: whether WKWebView plays a
transparent HEVC-with-alpha layer in a bare `<video>`.

**Pass / decide:** record the spike result. If it passes, the previewer's alpha
path is cleared. If it fails, take the documented fallback (checkerboard composite
or a flattened-preview path) and record the decision. → DoD: *previewer switches
layers with playhead preserved (alpha spike passed, or a documented fallback
decided)*. **Report:** pass/fail + the chosen path.

## Step 5 — Acceptance walkthrough (the observable DoD items)

With the app running against a real project folder:

1. **Run a single step**, then **batch several** — confirm parallel ordering,
   that disabling a step rewires its consumers (the plan view shows the rebinding),
   and that a forced failure cascades only downstream.
2. **Switch preview layers** (base ↔ caption) — playhead and play-state preserved.
3. **Export** to Premiere and to FCP/Resolve — confirm the bundle copies media in
   and references it relatively (open the bundle; paths are relative).
4. **State persists** across a restart; the light/dark toggle holds.
5. **Zero-hardcoding, observed:** add a trivial step/param to the pipeline schema
   (`definition.py`), re-emit the schema, relaunch — it appears in the GUI with
   **no GUI recompile**. This is the headline DoD item; demonstrate it explicitly.

**Report:** a line per item (pass / issue). Items 1–5 close the remaining DoD
checkboxes that no automated test can assert.

## Reporting back

Paste the `cargo test` summary, the `contract:` lines, the spike result, and the
Step-5 walkthrough notes into the session handoff so the President Agent can check
the DoD off against observed evidence (not shipped artifacts) before INI-087 is
moved to Done.
