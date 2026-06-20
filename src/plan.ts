// src/plan.ts — the glass-box plan panel (SADD §4.5).
// Single responsibility: render the backend's build_plan result so the operator
// can SEE the execution order before running — which tasks run in parallel per
// level, which are skipped and why, and the channel bindings that wire producers
// to consumers. Also surfaces the advisory safe-zone QC warning at the
// export/composite control (SADD §4.2): non-blocking, never disables the button.

import { ipc } from "./ipc";
import type { Plan, Schema, TaskState } from "./types";

function labelOf(schema: Schema, taskId: string): string {
  return schema.tasks.find((t) => t.id === taskId)?.label ?? taskId;
}

export interface PlanPanel {
  /** Recompute + render the plan for the given enabled task ids. */
  refresh(enabled: string[]): Promise<void>;
  /** Update a task's status chip in the plan (driven by task-status events). */
  setStatus(taskId: string, state: TaskState): void;
}

export function mountPlanPanel(host: HTMLElement, schema: Schema): PlanPanel {
  host.classList.add("plan");
  const body = document.createElement("div");
  body.className = "plan__body";
  host.appendChild(body);

  const statusByTask: Map<string, TaskState> = new Map();

  const renderError = (msg: string) => {
    body.innerHTML = `<div class="plan__error">Cannot plan: <code>${msg}</code></div>`;
  };

  const renderPlan = (plan: Plan) => {
    body.innerHTML = "";

    plan.levels.forEach((level, i) => {
      const row = document.createElement("div");
      row.className = "plan__level";
      const head = document.createElement("span");
      head.className = "plan__levelhead";
      head.textContent = `Level ${i + 1}`;
      row.appendChild(head);

      const tasksWrap = document.createElement("span");
      tasksWrap.className = "plan__tasks";
      level.forEach((taskId, j) => {
        if (j > 0) {
          const sep = document.createElement("span");
          sep.className = "plan__par";
          sep.textContent = " ∥ ";
          tasksWrap.appendChild(sep);
        }
        const chip = document.createElement("span");
        chip.className = "plan__chip";
        chip.dataset.task = taskId;
        const st = statusByTask.get(taskId);
        if (st) chip.dataset.state = st;
        chip.textContent = labelOf(schema, taskId);
        // Show channel bindings as a tooltip (which producer feeds it).
        const binds = plan.bindings[taskId] ?? [];
        if (binds.length > 0) {
          chip.title = binds
            .map((b) => `${b.channel} ← ${labelOf(schema, b.producer)}`)
            .join("\n");
        }
        tasksWrap.appendChild(chip);
      });
      row.appendChild(tasksWrap);
      body.appendChild(row);
    });

    const skipped = Object.keys(plan.skipped);
    if (skipped.length > 0) {
      const row = document.createElement("div");
      row.className = "plan__skipped";
      row.innerHTML =
        `<span class="plan__levelhead">Skipped</span> ` +
        skipped
          .map(
            (id) =>
              `<span class="plan__chip plan__chip--skip">${labelOf(
                schema,
                id,
              )} <em>(${plan.skipped[id].toLowerCase()})</em></span>`,
          )
          .join(" ");
      body.appendChild(row);
    }

    if (plan.levels.length === 0 && skipped.length === 0) {
      body.innerHTML = `<div class="plan__empty">No tasks enabled.</div>`;
    }
  };

  return {
    async refresh(enabled: string[]): Promise<void> {
      try {
        const plan = await ipc.buildPlan(enabled);
        renderPlan(plan);
      } catch (err) {
        renderError(String(err));
      }
    },
    setStatus(taskId: string, state: TaskState): void {
      statusByTask.set(taskId, state);
      const chip = body.querySelector<HTMLElement>(
        `.plan__chip[data-task="${CSS.escape(taskId)}"]`,
      );
      if (chip) chip.dataset.state = state;
    },
  };
}

/**
 * Advisory safe-zone QC warning at the export/composite control (SADD §4.2).
 * NON-BLOCKING by contract: this toggles a warning badge only; it must NEVER
 * disable the Run/Export button. `allClear` comes from the qc.report artifact
 * (or absence of QC findings). When QC hasn't run / isn't all-clear we advise.
 */
export function setSafezoneAdvisory(
  badgeHost: HTMLElement,
  allClear: boolean,
): void {
  badgeHost.classList.toggle("advisory--warn", !allClear);
  badgeHost.hidden = allClear;
  badgeHost.textContent = allClear
    ? ""
    : "⚠ Safe-zone QC not all-clear — advisory only, export still allowed";
  badgeHost.title =
    "SADD §4.2: QC is advisory and never blocks export/composite.";
}
