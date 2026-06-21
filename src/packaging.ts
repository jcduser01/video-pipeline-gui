// src/packaging.ts — the Output / Packaging sidebar section (SADD §7).
// Lists the schema's export targets (Premiere, Final Cut/Resolve, CapCut). Each
// shows its parameter form and a glass-box export command built as
//   <pipeline> export <target> --project <root> [--flag value …]
// The CLI's `--project` mode resolves every input + the bundle output from the
// project layout, so the GUI supplies only the root + params (no per-arg path
// mapping — tenet 3, zero core hardcoding). Execution stays glass-box: the user
// copies the exact command (the in-app spawn + the reframed-clip input-model
// decision are tracked separately for the CEO).

import type { ExportTarget, Param, Schema } from "./types";
import { quoteToken } from "./command";

export interface Packaging {
  /** Recompute every target's command (call when the project root/pipeline changes). */
  refresh(): void;
}

export interface PackagingDeps {
  projectRoot: () => string | undefined;
  pipelineCmd: () => string | undefined;
}

export function mountPackaging(
  host: HTMLElement,
  schema: Schema,
  deps: PackagingDeps,
): Packaging {
  const targets = (schema.export_targets ?? []) as ExportTarget[];
  host.classList.add("packaging");
  host.innerHTML = `<div class="packaging__head">Output / Packaging</div>`;

  if (targets.length === 0) {
    const none = document.createElement("div");
    none.className = "packaging__empty";
    none.textContent = "No export targets defined.";
    host.appendChild(none);
    return { refresh() {} };
  }

  // Per-target param values (default-seeded), and a recompute closure list.
  const updaters: Array<() => void> = [];

  for (const t of targets) {
    const values: Record<string, unknown> = {};
    for (const p of t.params) values[p.key] = p.default ?? "";

    const card = document.createElement("div");
    card.className = "packaging__card";
    card.innerHTML = `
      <div class="packaging__label" title="${t.hint ?? ""}">${t.label}</div>
      <div class="packaging__params"></div>
      <code class="packaging__cmd"></code>
      <button class="packaging__copy" type="button">Copy command</button>
    `;
    const paramsEl = card.querySelector<HTMLElement>(".packaging__params")!;
    const cmdEl = card.querySelector<HTMLElement>(".packaging__cmd")!;
    const copyBtn = card.querySelector<HTMLButtonElement>(".packaging__copy")!;

    const buildCommand = (): string => {
      const exe = deps.pipelineCmd() || "video-pipeline";
      const root = deps.projectRoot() ?? "<project-root>";
      const argv = [exe, ...t.subcommand.split(/\s+/), "--project", root];
      for (const p of t.params) {
        const v = values[p.key];
        if (v != null && String(v) !== "" && p.flag) {
          argv.push(p.flag, String(v));
        }
      }
      return argv.map(quoteToken).join(" ");
    };

    const updateCmd = () => {
      cmdEl.textContent = buildCommand();
    };
    updaters.push(updateCmd);

    // Minimal param controls (export params are few: fps, event name).
    for (const p of t.params) {
      const row = document.createElement("label");
      row.className = "packaging__field";
      const span = document.createElement("span");
      span.textContent = p.ui?.label ?? p.key;
      const input = paramControl(p, values[p.key], (val) => {
        values[p.key] = val;
        updateCmd();
      });
      row.append(span, input);
      paramsEl.appendChild(row);
    }

    copyBtn.addEventListener("click", () => {
      void navigator.clipboard?.writeText(cmdEl.textContent ?? "").then(
        () => {
          copyBtn.textContent = "Copied";
          setTimeout(() => (copyBtn.textContent = "Copy command"), 1200);
        },
        () => {},
      );
    });

    updateCmd();
    host.appendChild(card);
  }

  return {
    refresh() {
      for (const u of updaters) u();
    },
  };
}

/** A single export-param control (number → number input, string → text). */
function paramControl(
  p: Param,
  initial: unknown,
  onChange: (v: unknown) => void,
): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "packaging__input";
  if (p.type === "number") {
    input.type = "number";
    if (p.min != null) input.min = String(p.min);
    if (p.max != null) input.max = String(p.max);
    if (p.step != null) input.step = String(p.step);
  } else {
    input.type = "text";
  }
  input.value = initial != null ? String(initial) : "";
  input.addEventListener("input", () =>
    onChange(p.type === "number" ? Number(input.value) : input.value),
  );
  return input;
}
