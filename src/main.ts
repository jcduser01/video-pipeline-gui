// src/main.ts — composition root (SADD §2.1).
// Single responsibility: wire the modules together. Loads the schema via the IPC
// adapter, builds the left step/task tree with enable toggles, mounts the form +
// command preview + plan + log + previewer + help, subscribes to backend events,
// and handles Run/Cancel + theme + concurrency cap. Holds no business logic of
// its own — every rule lives behind the IPC boundary.

import "./styles.css";
import { ipc } from "./ipc";
import type {
  LogLineEvent,
  PlanProgressEvent,
  Schema,
  Step,
  Task,
  TaskStatusEvent,
} from "./types";
import { store } from "./state";
import { initTheme, toggleTheme } from "./theme";
import { renderForm } from "./forms";
import { mountCommandPreview } from "./command";
import { mountLog } from "./log";
import { mountPreviewer } from "./previewer";
import { setupDragDrop } from "./dnd";
import { confirmDialog, pickPath, tauriAvailable } from "./dialog";
import { bindLabelHelp, helpMarkup, type HelpPanel } from "./help";
import { makeSplitter } from "./splitter";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

async function boot(): Promise<void> {
  await store.load();
  initTheme();

  let schema: Schema;
  try {
    schema = await ipc.loadSchema();
  } catch (err) {
    $("#center").innerHTML = `<div class="fatal">Failed to load schema: <code>${String(
      err,
    )}</code></div>`;
    return;
  }

  $("#engine-name").textContent = `${schema.engine.name} ${schema.engine.version}`;

  // ---- enable-set: which tasks are turned on (left toggles) ----
  // Non-optional tasks default enabled; optional tasks default disabled.
  const enabled = new Set<string>();
  for (const t of schema.tasks) {
    if (!t.optional) enabled.add(t.id);
  }

  // ---- help panel (driven by form focus) ----
  const helpHost = $("#help-body");
  const help: HelpPanel = {
    show(html: string): void {
      helpHost.innerHTML = html;
    },
    clear(): void {
      helpHost.innerHTML = "";
    },
  };

  // ---- mount the center/right widgets ----
  const cmdPreview = mountCommandPreview($("#cmd-bar"), schema);
  const logView = mountLog($("#log-view"));
  const previewer = mountPreviewer($("#previewer"), schema, help);

  // ---- invalid-selection warning banner (replaces the plan panel) ----
  const banner = $("#banner");
  function planErrorToEnglish(raw: string): string {
    if (/noproducer|no enabled task produces|consumes/i.test(raw)) {
      return (
        "This selection can't run yet: a step needs an input that no enabled step " +
        "produces. Enable the step that creates it — for example, turn on " +
        "“Propose rough cut” before “Render rough cut.”"
      );
    }
    if (/cycle/i.test(raw)) {
      return "This selection can't run: the chosen steps form a dependency loop.";
    }
    return `This selection can't run: ${raw}`;
  }
  let lastPlanValid = true;
  async function validateSelection(enabledIds: string[]): Promise<void> {
    try {
      await ipc.buildPlan(enabledIds);
      banner.hidden = true;
      banner.textContent = "";
      lastPlanValid = true;
    } catch (err) {
      banner.textContent = planErrorToEnglish(String(err));
      banner.hidden = false;
      lastPlanValid = false;
    }
    updateRunEnabled();
  }

  // A run can complete only if the selection is a valid graph AND every enabled
  // task's required inputs have a value (or a default).
  function requiredInputsSatisfied(enabledIds: string[]): boolean {
    const set = new Set(enabledIds);
    for (const t of schema.tasks) {
      if (!set.has(t.id)) continue;
      for (const p of t.params) {
        if (!p.required) continue;
        const v = store.getFormValue(`${t.id}.${p.key}`);
        const provided = v !== undefined && v !== null && v !== "";
        const hasDefault =
          p.default !== undefined && p.default !== null && p.default !== "";
        if (!provided && !hasDefault) return false;
      }
    }
    return true;
  }
  // Run lifecycle: `running` gates the Run button; `pendingTasks` is the set of
  // enabled tasks we're still waiting on (cleared by terminal task-status events).
  let running = false;
  let pendingTasks = new Set<string>();

  function updateRunEnabled(): void {
    // A real run also needs the pipeline executable set (in the Tauri app).
    const pipelineOk = !tauriAvailable() || !!store.getPipelinePath();
    const ok =
      lastPlanValid && requiredInputsSatisfied([...enabled]) && pipelineOk;
    $<HTMLButtonElement>("#run-btn").disabled = running || !ok;
  }

  // Top-bar concurrency cap: a help trigger on its label (the stepper itself
  // never showed help on focus).
  bindLabelHelp(
    $("#cap-help"),
    () =>
      helpMarkup(
        "Parallel tasks",
        "How many independent tasks the scheduler runs at once within a level. Higher uses more CPU and memory; 2 is a sensible default on an M-series Mac.",
      ),
    help,
  );

  let selectedTask: Task | null = null;

  const refreshCommand = () => void cmdPreview.update(selectedTask);
  const refreshPlan = () => void validateSelection([...enabled]);

  // QoL: a project-wide control (the earliest task that carries it — project.init)
  // pre-fills the same value on the later steps' copies of that control, so the
  // user sets it once. The controls stay independent (editing a downstream one
  // doesn't propagate back) and remain separate CLI args.
  const sharedProps = ["identity", "profile"]
    .map((key) => {
      const taskIds = schema.tasks
        .filter((t) => t.params.some((p) => p.key === key))
        .map((t) => t.id);
      return {
        key,
        sourceKey: taskIds.length > 0 ? `${taskIds[0]}.${key}` : null,
        downstreamKeys: taskIds.slice(1).map((id) => `${id}.${key}`),
      };
    })
    .filter((s): s is { key: string; sourceKey: string; downstreamKeys: string[] } => s.sourceKey !== null);

  const onFormChange = (changedKey?: string): void => {
    for (const s of sharedProps) {
      if (changedKey && changedKey === s.sourceKey) {
        const val = store.getFormValue(changedKey);
        for (const k of s.downstreamKeys) store.setFormValue(k, val);
        if (s.key === "profile") previewer.setProfile(String(val ?? ""));
      }
    }
    refreshCommand();
    updateRunEnabled();
    refreshConflicts();
  };

  // Mark pipeline-tree rows whose shared fields conflict with the first step, so a
  // restored-session conflict is visible at launch without opening each step.
  function refreshConflicts(): void {
    const treeEl = document.getElementById("step-tree");
    if (!treeEl) return;
    for (const t of schema.tasks) {
      const conflict = t.params.some((p) => conflictMessage(t.id, p.key) !== null);
      const row = treeEl.querySelector<HTMLElement>(
        `.tree__task[data-task="${CSS.escape(t.id)}"]`,
      );
      if (!row) continue;
      row.classList.toggle("tree__task--conflict", conflict);
      if (conflict) {
        row.title = "A setting in this step conflicts with the project settings.";
      } else {
        row.removeAttribute("title");
      }
    }
  }

  // Soft conflict: a downstream shared control (Identity/Profile) whose value
  // differs from the project's (first-step) value — likely a mistake.
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  function conflictMessage(taskId: string, paramKey: string): string | null {
    for (const s of sharedProps) {
      if (s.key !== paramKey) continue;
      const myKey = `${taskId}.${paramKey}`;
      if (myKey === s.sourceKey || !s.downstreamKeys.includes(myKey)) continue;
      const src = store.getFormValue(s.sourceKey);
      const mine = store.getFormValue(myKey);
      const has = (v: unknown) => v != null && String(v) !== "";
      if (has(src) && has(mine) && String(src) !== String(mine)) {
        return (
          `Differs from the project ${titleCase(s.key)} ("${String(src)}") set ` +
          `in Initialize project — may produce unexpected results.`
        );
      }
    }
    return null;
  }

  // ---- left tree: steps -> tasks with enable toggles ----
  const tree = $("#step-tree");

  function selectTask(task: Task): void {
    selectedTask = task;
    // highlight
    tree
      .querySelectorAll(".tree__task--active")
      .forEach((e) => e.classList.remove("tree__task--active"));
    tree
      .querySelector(`.tree__task[data-task="${CSS.escape(task.id)}"]`)
      ?.classList.add("tree__task--active");

    renderForm($("#form-host"), task, {
      onChange: onFormChange,
      help,
      conflict: (k) => conflictMessage(task.id, k),
    });
    refreshCommand();
  }

  function buildTree(): void {
    tree.innerHTML = "";
    const steps = [...schema.steps].sort((a, b) => a.order - b.order);
    const tasksByStep = new Map<string, Task[]>();
    for (const t of schema.tasks) {
      if (!tasksByStep.has(t.step)) tasksByStep.set(t.step, []);
      tasksByStep.get(t.step)!.push(t);
    }

    const renderStep = (step: Step) => {
      const group = document.createElement("div");
      group.className = "tree__step";
      const head = document.createElement("div");
      head.className = "tree__stephead";
      head.innerHTML = `<span class="tree__steplabel">${step.label}</span>${
        step.optional ? '<span class="tree__opt">optional</span>' : ""
      }`;
      if (step.hint) head.title = step.hint;
      group.appendChild(head);

      for (const task of tasksByStep.get(step.id) ?? []) {
        const row = document.createElement("div");
        row.className = "tree__task";
        row.dataset.task = task.id;

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "tree__toggle";
        toggle.checked = enabled.has(task.id);
        toggle.disabled = !task.optional; // required tasks can't be disabled
        toggle.title = task.optional
          ? "Enable/disable this task"
          : "Required — always runs";
        toggle.addEventListener("change", () => {
          if (toggle.checked) enabled.add(task.id);
          else enabled.delete(task.id);
          refreshPlan();
        });

        const label = document.createElement("button");
        label.type = "button";
        label.className = "tree__tasklabel";
        label.textContent = task.label;
        if (task.hint) label.title = task.hint;
        label.addEventListener("click", () => selectTask(task));

        row.append(toggle, label);
        group.appendChild(row);
      }
      tree.appendChild(group);
    };

    steps.forEach(renderStep);

    // Tasks whose step isn't declared (defensive) get a catch-all group.
    const declared = new Set(steps.map((s) => s.id));
    const orphanSteps = [...tasksByStep.keys()].filter((s) => !declared.has(s));
    for (const sid of orphanSteps) {
      renderStep({ id: sid, label: sid, order: 9999, optional: true });
    }
  }

  buildTree();

  // Select the first task by default.
  if (schema.tasks.length > 0) selectTask(schema.tasks[0]);

  // Launch-time validation: a restored session may carry a downstream value that
  // conflicts with the project's. Surface it on the tree now, without waiting for
  // the user to open that step or change a value.
  refreshConflicts();

  // The project lives at <Projects root>/<Project name> (project-init creates it
  // there). Artifact paths + the run's working dir resolve against this. Single
  // shared derivation in the store so the command preview, previewer, and run all
  // agree (see store.projectRoot()).
  const projectRoot = (): string | undefined => store.projectRoot();

  // Initial plan + previewer pass.
  refreshPlan();
  void previewer.refresh(projectRoot());

  // Lock the preview aspect to the project profile (stored value or schema default).
  const profileProp = sharedProps.find((s) => s.key === "profile");
  if (profileProp) {
    const stored = store.getFormValue(profileProp.sourceKey);
    const def = schema.tasks
      .flatMap((t) => t.params)
      .find((p) => p.key === "profile")?.default;
    previewer.setProfile(String(stored ?? def ?? "reels-9x16"));
  }

  // Native file/folder drag-drop onto path pickers (no-op outside Tauri).
  void setupDragDrop();

  // ---- resizable / collapsible panels ----
  setupPanels();

  // ---- backend event subscriptions ----
  await ipc.listen<LogLineEvent>("log-line", (p) => logView.push(p));
  await ipc.listen<TaskStatusEvent>("task-status", (p) => {
    // Run status colours the pipeline tree rows (the plan chips were removed).
    const row = tree.querySelector<HTMLElement>(
      `.tree__task[data-task="${CSS.escape(p.taskId)}"]`,
    );
    if (row) row.dataset.state = p.state;
    if (p.state === "Succeeded") {
      // A produced artifact may now exist — refresh available preview layers.
      void previewer.refresh(projectRoot());
    }
    // A terminal state clears the task from the pending set; when the set empties
    // the run is over (covers failures/blocks, which `done==total` would miss).
    if (p.state !== "Running") {
      pendingTasks.delete(p.taskId);
      if (running && pendingTasks.size === 0) setRunning(false);
    }
  });
  await ipc.listen<PlanProgressEvent>("plan-progress", (p) => {
    $("#run-progress").textContent =
      `L${p.level + 1}: ${p.done}/${p.total}`;
  });

  // ---- top-bar controls ----
  const SUN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const themeBtn = $("#theme-toggle");
  // Show the icon of the mode you'll switch TO: a sun while dark, a moon while light.
  const setThemeIcon = (t: "light" | "dark") =>
    (themeBtn.innerHTML = t === "dark" ? SUN_ICON : MOON_ICON);
  themeBtn.addEventListener("click", () => setThemeIcon(toggleTheme()));
  setThemeIcon(store.getTheme());

  const capInput = $<HTMLSelectElement>("#cap-input");
  // Persisted cap isn't part of the kv model; keep it local with a sane default.
  capInput.value = "2";

  const runBtn = $<HTMLButtonElement>("#run-btn");
  const cancelBtn = $<HTMLButtonElement>("#cancel-btn");

  // Toggle the running state: Run shows a spinner + "Running" and is disabled;
  // Cancel is enabled only while a run is in flight.
  function setRunning(on: boolean): void {
    running = on;
    cancelBtn.disabled = !on;
    if (on) {
      runBtn.disabled = true;
      runBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Running`;
    } else {
      runBtn.innerHTML = "▶ Run";
      updateRunEnabled(); // restore the validity-gated enabled state
    }
  }

  runBtn.addEventListener("click", () => {
    void (async () => {
      const cap = Math.max(1, Number(capInput.value) || 1);
      const root = projectRoot() ?? "<project-root>";

      // Overwrite confirmation: re-running creates project-init over an existing
      // folder, which refreshes the project and overwrites the enabled steps'
      // outputs. Confirm first.
      if (enabled.has("project.init") && root !== "<project-root>") {
        let exists = false;
        try {
          exists = await ipc.pathExists(root);
        } catch {
          exists = false;
        }
        if (exists) {
          const ok = await confirmDialog(
            `A project already exists at:\n${root}\n\nRunning will overwrite the ` +
              `outputs of the enabled steps. Continue?`,
            "Overwrite project?",
          );
          if (!ok) return;
        }
      }

      void store.flush();
      try {
        const runId = await ipc.runPlan({
          enabled: [...enabled],
          formValues: store.session().formValues,
          projectRoot: root,
          cap,
          pipelineCmd: store.getPipelinePath(),
        });
        $("#run-progress").textContent = `run ${runId}`;
        // Wait on every enabled task; each emits a terminal status when done.
        pendingTasks = new Set([...enabled]);
        setRunning(true);
      } catch (err) {
        $("#run-progress").textContent = `error: ${String(err)}`;
      }
    })();
  });

  cancelBtn.addEventListener("click", () => {
    // Cancel the whole run: request cancellation of every task still pending.
    for (const id of pendingTasks) void ipc.cancelTask(id);
  });
  cancelBtn.disabled = true;

  // Pipeline location: point the app at the video-pipeline executable so runs work
  // regardless of how the app was launched (else it relies on PATH).
  const pipelineBtn = $<HTMLButtonElement>("#pipeline-btn");
  const reflectPipeline = () => {
    const p = store.getPipelinePath();
    pipelineBtn.textContent = p ? "Change pipeline" : "Set pipeline";
    pipelineBtn.classList.toggle("btn--attention", !p); // draw the eye when unset
    pipelineBtn.title = p
      ? `Pipeline executable:\n${p}\n\nClick to change.`
      : "Set the video-pipeline executable to run (required before a run).";
  };
  reflectPipeline();
  pipelineBtn.addEventListener("click", () => {
    void (async () => {
      const picked = await pickPath(
        { kind: "file" },
        {
          title: "Locate the video-pipeline executable",
          defaultPath: store.getPipelinePath(),
        },
      );
      if (picked && picked.length > 0) {
        store.setPipelinePath(picked[0]);
        await store.flush();
        reflectPipeline();
        updateRunEnabled();
      }
    })();
  });

  // Reset everything to defaults (confirmed), then reload to rebuild from scratch.
  const resetBtn = $<HTMLButtonElement>("#reset-btn");
  resetBtn.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmDialog(
        "Reset all fields, panel sizes, and theme to their defaults? This clears your saved values and reloads the app.",
        "Reset to defaults",
      );
      if (!ok) return;
      await store.reset();
      location.reload();
    })();
  });

  // ---- resizable + collapsible panel wiring (restored from saved state) ----
  function setupPanels(): void {
    const grid = $("#grid");
    const center = $("#center");
    const right = $("#right");
    const saved = store.getPanels();
    const mark = (btn: HTMLElement, c: boolean) =>
      (btn.dataset.collapsed = String(c));

    // center | right — resizes the whole right panel; collapse hides it.
    makeSplitter({
      handle: $("#right-split"),
      axis: "x",
      min: 260,
      max: 620,
      collapseAt: 150,
      initialSize: saved.rightWidth ?? 340,
      initialCollapsed: saved.rightCollapsed,
      onChange: (px, c) => {
        grid.style.setProperty("--right-w", `${c ? 0 : px}px`);
        grid.classList.toggle("right-collapsed", c);
        store.setPanels({ rightWidth: px, rightCollapsed: c });
      },
    });

    // preview | help (inside right) — preview keeps the remainder; help collapses.
    const helpSplit = makeSplitter({
      handle: $("#right-help-split"),
      axis: "y",
      min: 90,
      max: 460,
      collapseAt: 56,
      initialSize: saved.helpHeight ?? 220,
      initialCollapsed: saved.helpCollapsed,
      onChange: (px, c) => {
        right.style.setProperty("--help-h", `${c ? 0 : px}px`);
        right.classList.toggle("help-collapsed", c);
        mark($("#help-collapse"), c);
        store.setPanels({ helpHeight: px, helpCollapsed: c });
      },
    });
    $("#help-collapse").addEventListener("click", () => helpSplit.toggle());

    // resolved command stays docked; this handle sizes/collapses the run output.
    const logSplit = makeSplitter({
      handle: $("#log-split"),
      axis: "y",
      min: 80,
      max: 520,
      collapseAt: 52,
      initialSize: saved.logHeight ?? 200,
      initialCollapsed: saved.logCollapsed,
      onChange: (px, c) => {
        center.style.setProperty("--log-h", `${c ? 0 : px}px`);
        center.classList.toggle("log-collapsed", c);
        mark($("#log-collapse"), c);
        store.setPanels({ logHeight: px, logCollapsed: c });
      },
    });
    $("#log-collapse").addEventListener("click", () => logSplit.toggle());
  }
}

void boot();
