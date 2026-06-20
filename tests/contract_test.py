"""Contract test — SADD §9.1 invariant 3.

Loads a pipeline-exported schema and asserts the GUI can parse and render it,
i.e. that the emitted document conforms to the meta-schema grammar *and* the
deeper cross-reference invariants the Rust gateway enforces at load.

Runs two ways:
  * standalone  ->  `python3 tests/contract_test.py`  (validates the committed
    fixture; if the sibling video-pipeline repo is importable, also diff-checks a
    live emit against the fixture to catch drift)
  * pytest      ->  the same checks as test functions

This is the honesty check kept once the two repos split: the GUI defines what
"conformant" means; the pipeline must keep emitting it. The dependency only ever
points GUI -> pipeline (invariant 1); the pipeline imports nothing from here.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import jsonschema

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
META = ROOT / "schema" / "meta-schema.json"
FIXTURE = HERE / "fixtures" / "sample-schema.json"
GOLDEN = HERE / "fixtures" / "golden-argv.json"

# Where the pipeline lives relative to this repo (sibling checkout). Overridable.
PIPELINE_SRC = Path(
    os.environ.get("VIDEO_PIPELINE_SRC", ROOT.parent / "video-pipeline" / "src")
)

VALID_CONTROLS = {"toggle", "slider", "stepper", "dropdown", "field", "picker"}


def _load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def _live_emit() -> dict | None:
    """Emit straight from the pipeline if it's importable, else None."""
    if not PIPELINE_SRC.exists():
        return None
    env = dict(os.environ, PYTHONPATH=str(PIPELINE_SRC))
    out = subprocess.run(
        [sys.executable, "-m", "video_pipeline.cli", "schema", "--format", "json"],
        capture_output=True, text=True, env=env,
    )
    if out.returncode != 0:
        raise AssertionError(f"pipeline schema emit failed:\n{out.stderr}")
    return json.loads(out.stdout)


# --- the checks ------------------------------------------------------------

def check_meta_schema_is_valid():
    jsonschema.Draft7Validator.check_schema(_load(META))


def check_instance_conforms(instance: dict):
    v = jsonschema.Draft7Validator(_load(META))
    errs = sorted(v.iter_errors(instance), key=lambda e: list(e.path))
    assert not errs, "; ".join(f"{list(e.path)}: {e.message}" for e in errs[:10])


def check_cross_reference_invariants(s: dict):
    """The graph-level invariants the Rust gateway enforces (the meta-schema is
    structural only; these are referential)."""
    step_ids = {x["id"] for x in s["steps"]}
    art_ids = {a["id"] for a in s["artifacts"]}
    produced = {p for t in s["tasks"] for p in t["produces"]}

    for t in s["tasks"]:
        assert t["step"] in step_ids, f"task {t['id']} -> unknown step {t['step']}"
        keys = [p["key"] for p in t["params"]]
        assert len(keys) == len(set(keys)), f"task {t['id']} duplicate param keys"
        for c in t["consumes"]:
            assert c in art_ids, f"task {t['id']} consumes unknown {c}"
            assert c in produced, f"task {t['id']} consumes orphan channel {c}"
        for p in t["produces"]:
            assert p in art_ids, f"task {t['id']} produces unknown {p}"
        for b in t["io"]:
            if b["role"] == "input":
                assert b["artifact"] in t["consumes"], f"{t['id']} io input not consumed"
            else:
                assert b["artifact"] in t["produces"], f"{t['id']} io output not produced"
        for p in t["params"]:
            assert p["control"] in VALID_CONTROLS, f"{t['id']}.{p['key']} bad control"
            dep = p.get("ui", {}).get("depends_on")
            if dep:
                assert dep["key"] in keys, f"{t['id']}.{p['key']} depends_on non-sibling"

    for a in s["artifacts"]:
        if a["previewable"]:
            assert a.get("z_order") is not None, f"previewable {a['id']} lacks z_order"

    real_cli = {"handoff", "fcpxml", "export"}
    for e in s["export_targets"]:
        assert e["subcommand"].split()[0] in real_cli, f"export {e['id']} not a real cmd"


def check_golden_argv() -> bool:
    """Assert the pipeline's reference assembler reproduces the argv golden
    contract (SADD §2.4). The Rust `resolve_argv` is pinned to the same file by
    `command.rs::golden_argv_matches`, so the two assemblers cannot diverge.
    Returns False (skip) when the pipeline is not importable."""
    if not PIPELINE_SRC.exists():
        return False
    sys.path.insert(0, str(PIPELINE_SRC))
    try:
        from video_pipeline.schema import assemble  # type: ignore
        from video_pipeline.schema.definition import build_schema  # type: ignore
    except Exception:
        return False
    schema = build_schema()
    golden = _load(GOLDEN)
    for c in golden["cases"]:
        got = assemble.resolve_argv(schema, c["task"], c["form_values"], c["artifact_paths"])
        assert got == c["argv"], (
            f"golden argv mismatch ({c['name']}):\n  exp {c['argv']}\n  got {got}"
        )
    return True


# --- pytest entry points ---------------------------------------------------

def test_meta_schema_self_valid():
    check_meta_schema_is_valid()


def test_golden_argv_reference_matches():
    check_golden_argv()  # no-op skip when the pipeline isn't importable


def test_fixture_conforms_and_holds_invariants():
    inst = _load(FIXTURE)
    check_instance_conforms(inst)
    check_cross_reference_invariants(inst)


def test_live_emit_matches_fixture_when_available():
    live = _live_emit()
    if live is None:
        return  # pipeline not present; fixture-only check already ran
    check_instance_conforms(live)
    check_cross_reference_invariants(live)
    fixture = _load(FIXTURE)
    assert live == fixture, (
        "committed fixture has drifted from the live pipeline emit — "
        "regenerate tests/fixtures/sample-schema.json"
    )


def main() -> int:
    check_meta_schema_is_valid()
    inst = _load(FIXTURE)
    check_instance_conforms(inst)
    check_cross_reference_invariants(inst)
    print("contract: fixture conforms + invariants hold")
    live = _live_emit()
    if live is None:
        print("contract: pipeline not importable; fixture-only (set VIDEO_PIPELINE_SRC)")
        return 0
    check_instance_conforms(live)
    check_cross_reference_invariants(live)
    if live != inst:
        print("contract: FAIL — fixture drifted from live emit", file=sys.stderr)
        return 1
    print("contract: live emit conforms + matches fixture")
    if check_golden_argv():
        print("contract: reference assembler reproduces the argv golden")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
