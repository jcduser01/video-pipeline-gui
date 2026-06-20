#!/usr/bin/env python3
"""In-sandbox logic verification harness — SADD §4 (scheduler) + §2.4 (argv).

Why this exists
---------------
The Rust core (`src-tauri/src/scheduler.rs`, `src-tauri/src/command.rs`) carries
`cargo test` unit suites, but `cargo` is not available in the JasonOS sandbox
(no Rust toolchain, no PyPI). This harness ports the two pure algorithms to
Python and re-runs the *same* scenarios, so the hard subsystems stay
reproducibly verifiable from the sandbox between Mac builds. It is the committed
form of the throwaway port used when INI-087 was first built.

What it checks
--------------
1. **Scheduler** (no other reference exists for it anywhere): a faithful port of
   `build_plan` / `topo_levels` / `cascade_blocked` / `waves`, exercised by the
   eight scenarios mirrored from the Rust `#[test]` suite.
2. **Argv golden contract** (SADD §2.4 invariant — "the GUI's resolved-command
   preview can never diverge from a command that actually runs"): every case in
   `tests/fixtures/golden-argv.json` is reproduced by
     * the Python port of the Rust `resolve_argv` (spec equivalence), and
     * the pipeline's reference `assemble.py` when the sibling repo is importable
       (cross-language parity / reference-regression guard).
   The Mac-side `cargo test` runs the *real* Rust against the same golden file
   (`command.rs::golden_argv_matches`), closing the loop across both languages.

This file is dependency-free (stdlib only) and safe to run anywhere:
    python3 tests/verify_logic.py              # verify
    python3 tests/verify_logic.py --write-golden   # regenerate golden from the reference
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURE = HERE / "fixtures" / "sample-schema.json"
GOLDEN = HERE / "fixtures" / "golden-argv.json"
PIPELINE_SRC = Path(
    os.environ.get("VIDEO_PIPELINE_SRC", ROOT.parent / "video-pipeline" / "src")
)

# --------------------------------------------------------------------------- #
# Schema access (the fixture is the canonical document both repos share)
# --------------------------------------------------------------------------- #


def load_schema() -> dict:
    return json.loads(FIXTURE.read_text())


def _task(schema: dict, task_id: str) -> dict:
    for t in schema["tasks"]:
        if t["id"] == task_id:
            return t
    raise KeyError(task_id)


# --------------------------------------------------------------------------- #
# Port of src-tauri/src/command.rs  (argv assembly)
# --------------------------------------------------------------------------- #


def _token(v):
    """Mirror of Rust `command::token`: scalar -> single argv token, Null -> None."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, str):
        return v
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # serde_json renders an integral float as "N.0"; Python str() matches.
        return repr(v) if v != int(v) else f"{v:.1f}"
    return json.dumps(v)


def _truthy(v) -> bool:
    """Mirror of Rust `command::truthy`."""
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, str):
        return len(v) > 0
    if isinstance(v, (int, float)):
        return float(v) != 0.0
    return True


def resolve_argv_port(schema, task_id, form_values=None, artifact_paths=None):
    form_values = form_values or {}
    artifact_paths = artifact_paths or {}
    task = _task(schema, task_id)

    argv = [schema["engine"]["cli_entrypoint"], *task["subcommand"].split()]

    # 1) positionals (params + io), interleaved by `order`
    positionals = []
    for p in task.get("params", []):
        if p["arity"] == "positional":
            val = form_values.get(p["key"], p.get("default"))
            tok = _token(val)
            if tok is not None:
                positionals.append((p.get("order", 0), tok))
            elif p.get("required"):
                raise ValueError(f"{task_id}: required positional {p['key']} missing")
    for b in task.get("io", []):
        if b["via"] == "positional":
            path = artifact_paths.get(b["artifact"])
            if path is None:
                raise ValueError(f"{task_id}: positional artifact {b['artifact']} missing")
            positionals.append((b.get("order", 0), path))
    positionals.sort(key=lambda x: x[0])
    argv.extend(v for _, v in positionals)

    # 2) value + switch params
    for p in task.get("params", []):
        arity = p["arity"]
        if arity == "positional":
            continue
        val = form_values.get(p["key"], p.get("default"))
        if arity == "switch":
            if _truthy(val) and p.get("flag") is not None:
                argv.append(p["flag"])
        elif arity == "value":
            tok = _token(val)
            if tok is not None:
                if p.get("flag") is not None:
                    argv.extend([p["flag"], tok])
            elif p.get("required"):
                raise ValueError(f"{task_id}: required param {p['key']} missing")

    # 3) io flag bindings (inputs + outputs)
    for b in task.get("io", []):
        if b["via"] == "flag":
            path = artifact_paths.get(b["artifact"])
            if path is None:
                raise ValueError(f"{task_id}: artifact {b['artifact']} missing")
            if b.get("flag") is not None:
                argv.extend([b["flag"], path])

    return argv


# --------------------------------------------------------------------------- #
# Port of src-tauri/src/scheduler.rs  (dependency scheduler — the hard core)
# --------------------------------------------------------------------------- #


class PlanError(Exception):
    pass


class NoProducer(PlanError):
    def __init__(self, task, channel):
        self.task, self.channel = task, channel
        super().__init__(f"{task} consumes {channel} but no enabled task produces it")


class Cycle(PlanError):
    pass


class UnknownTask(PlanError):
    pass


class Plan:
    def __init__(self, levels, skipped, bindings, edges):
        self.levels = levels          # list[list[str]]
        self.skipped = skipped        # dict[str, "Disabled"]
        self.bindings = bindings      # dict[str, list[(channel, producer)]]
        self.edges = edges            # dict[str, list[str]]

    def scheduled(self):
        return [t for lvl in self.levels for t in lvl]

    def waves(self, level_index, cap):
        cap = max(cap, 1)
        if level_index >= len(self.levels):
            return []
        lvl = self.levels[level_index]
        return [lvl[i:i + cap] for i in range(0, len(lvl), cap)]

    def cascade_blocked(self, failed):
        blocked = set()
        queue = list(failed)
        while queue:
            node = queue.pop(0)
            for c in self.edges.get(node, []):
                if c not in failed and c not in blocked:
                    blocked.add(c)
                    queue.append(c)
        return blocked


def build_plan(schema, enabled):
    tasks = schema["tasks"]
    order = {t["id"]: i for i, t in enumerate(tasks)}

    for tid in enabled:
        if tid not in order:
            raise UnknownTask(tid)

    bindings = {}
    edges = {tid: [] for tid in enabled}
    indeg = {tid: 0 for tid in enabled}

    for task in tasks:
        tid = task["id"]
        if tid not in enabled:
            continue
        t_idx = order[tid]
        my_bindings = []
        for channel in task.get("consumes", []):
            # latest enabled writer of `channel` strictly before this task
            producer = None
            best = -1
            for w in tasks:
                wid = w["id"]
                if (
                    wid in enabled
                    and channel in w.get("produces", [])
                    and order[wid] < t_idx
                    and order[wid] > best
                ):
                    producer, best = wid, order[wid]
            if producer is None:
                raise NoProducer(tid, channel)
            edges[producer].append(tid)
            indeg[tid] += 1
            my_bindings.append((channel, producer))
        bindings[tid] = my_bindings

    levels = _topo_levels(enabled, edges, dict(indeg))

    skipped = {t["id"]: "Disabled" for t in tasks if t["id"] not in enabled}
    return Plan(levels, skipped, bindings, edges)


def _topo_levels(enabled, edges, indeg):
    levels = []
    remaining = len(enabled)
    frontier = sorted(k for k, d in indeg.items() if d == 0)
    done = set()
    while frontier:
        levels.append(list(frontier))
        nxt = set()
        for node in frontier:
            done.add(node)
            remaining -= 1
            for c in edges.get(node, []):
                indeg[c] -= 1
                if indeg[c] == 0:
                    nxt.add(c)
        frontier = sorted(nxt)
    if remaining != 0:
        stuck = sorted(n for n in enabled if n not in done)
        raise Cycle(", ".join(stuck))
    return levels


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #

ALL = [
    "project.init", "safezone.gen", "reframe", "roughcut",
    "roughcut.render", "caption.define", "caption.render", "safezone.qc",
]


def _level_of(plan, tid):
    for i, lvl in enumerate(plan.levels):
        if tid in lvl:
            return i
    raise AssertionError(f"{tid} not scheduled")


def check_scheduler(schema):
    """The eight scenarios mirrored from scheduler.rs #[test]."""
    s = schema

    # 1: roots share the first level
    plan = build_plan(s, set(ALL))
    assert "project.init" in plan.levels[0] and "safezone.gen" in plan.levels[0]

    # 2: full-graph ordering
    assert _level_of(plan, "reframe") < _level_of(plan, "roughcut")
    assert _level_of(plan, "roughcut.render") < _level_of(plan, "caption.define")
    assert _level_of(plan, "caption.define") < _level_of(plan, "caption.render")
    assert _level_of(plan, "caption.render") < _level_of(plan, "safezone.qc")

    # 3: skip rewires base to nearest enabled writer
    plan = build_plan(s, {"project.init", "roughcut", "roughcut.render", "safezone.gen"})
    base = dict(plan.bindings["roughcut"])["base"]
    assert base == "project.init", base

    # 4: skip chains collapse to project.init
    plan = build_plan(s, {"project.init", "safezone.gen", "roughcut", "caption.define"})
    assert dict(plan.bindings["caption.define"])["base"] == "project.init"
    assert plan.skipped.get("reframe") == "Disabled"

    # 5: missing producer is a plan-time error. With safezone.gen disabled,
    # caption.define is the FIRST enabled consumer of safezone.def in declaration
    # order, so the error names it (not caption.render, which also consumes it but
    # is processed later).
    try:
        build_plan(s, {"project.init", "caption.define", "caption.render"})
        raise AssertionError("expected NoProducer")
    except NoProducer as e:
        assert e.task == "caption.define" and e.channel == "safezone.def", (e.task, e.channel)

    # 6: fail cascades only to reverse-reachable downstream
    plan = build_plan(s, set(ALL))
    blocked = plan.cascade_blocked({"reframe"})
    for t in ["roughcut", "roughcut.render", "caption.define", "caption.render", "safezone.qc"]:
        assert t in blocked, t
    assert "safezone.gen" not in blocked and "project.init" not in blocked

    # 7: concurrency cap chunks a level into waves
    plan = build_plan(s, set(ALL))
    assert len(plan.waves(0, 1)) == 2
    assert len(plan.waves(0, 2)) == 1

    # 8: single-step run
    plan = build_plan(s, {"project.init"})
    assert plan.scheduled() == ["project.init"]
    assert len(plan.skipped) == len(ALL) - 1

    return 8


def _load_reference():
    """Return the pipeline's reference assemble.resolve_argv + schema, or None."""
    if not PIPELINE_SRC.exists():
        return None
    sys.path.insert(0, str(PIPELINE_SRC))
    try:
        from video_pipeline.schema import assemble  # type: ignore
        from video_pipeline.schema.definition import build_schema  # type: ignore
    except Exception:
        return None
    return assemble.resolve_argv, build_schema()


def check_golden_argv(schema):
    golden = json.loads(GOLDEN.read_text())
    cases = golden["cases"]
    ref = _load_reference()
    port_ok = ref_ok = 0
    for c in cases:
        expected = c["argv"]
        got = resolve_argv_port(schema, c["task"], c["form_values"], c["artifact_paths"])
        assert got == expected, f"PORT mismatch {c['name']}:\n  exp {expected}\n  got {got}"
        port_ok += 1
        if ref is not None:
            resolve_ref, ref_schema = ref
            rgot = resolve_ref(ref_schema, c["task"], c["form_values"], c["artifact_paths"])
            assert rgot == expected, f"REFERENCE mismatch {c['name']}:\n  exp {expected}\n  got {rgot}"
            ref_ok += 1
    return port_ok, ref_ok, (ref is not None)


def write_golden():
    ref = _load_reference()
    if ref is None:
        print("cannot regenerate: pipeline reference not importable", file=sys.stderr)
        return 1
    resolve_ref, ref_schema = ref
    golden = json.loads(GOLDEN.read_text())
    for c in golden["cases"]:
        c["argv"] = resolve_ref(ref_schema, c["task"], c["form_values"], c["artifact_paths"])
    GOLDEN.write_text(json.dumps(golden, indent=2) + "\n")
    print(f"rewrote {GOLDEN.name} ({len(golden['cases'])} cases)")
    return 0


def main(argv):
    if "--write-golden" in argv:
        return write_golden()
    schema = load_schema()
    n = check_scheduler(schema)
    print(f"scheduler: {n}/8 scenarios pass (port of scheduler.rs)")
    port_ok, ref_ok, had_ref = check_golden_argv(schema)
    print(f"argv golden: {port_ok} cases match the Rust port (command.rs)")
    if had_ref:
        print(f"argv golden: {ref_ok} cases match the pipeline reference (assemble.py)")
    else:
        print("argv golden: reference assemble.py not importable — skipped cross-language parity")
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
