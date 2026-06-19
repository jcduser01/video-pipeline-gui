// src/main.ts — composition root (SADD §2.1).
// Single responsibility: wire the modules together. Loads the schema via the IPC
// adapter, builds the left step/task tree with enable toggles, mounts the form +
// command preview + plan + log + previewer + help, subscribes to backend events,
// and handles Run/Cancel + theme + concurrency cap. Holds no business logic of
// its own — every rule lives behind the IPC boundary.

import "./styles.css";
import { ipc, IPC_MODE } from "./ipc";
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
import { renderForm, type HelpPanel } from "./forms";
import { mountCommandPreview } from "./command";
import { mountPlanPanel, setSafezoneAdvisory } from "./plan";
import { mountLog } from "./log";
import { mountPreviewer } from "./previewer";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
};

async function boot(): Promise<void> {
  await store.load();
  initTheme();

  // Reflect the runtime mode in the top bar (helps during dev).
  $("#mode-badge").textContent = IPC_MODE === "tauri" ? "tauri" : "mock";

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
  const planPanel = mountPlanPanel($("#plan-panel"), schema);
  const logView = mountLog($("#log-view"));
  const previewer = mountPreviewer($("#previewer"), schema);

  let selectedTask: Task | null = null;

  const refreshCommand = () => void cmdPreview.update(selectedTask);
  const refreshPlan = () => void planPanel.refresh([...enabled]);

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
      onChange: refreshCommand,
      help,
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

  // Initial plan + previewer pass.
  refreshPlan();
  void previewer.refresh(store.activeProjectRoot());

  // ---- advisory safe-zone badge (SADD §4.2) ----
  // We don't have a live qc.report parse here; default to "not all-clear" until
  // a QC run reports clean. This only shows an advisory; it never blocks Run.
  const advisory = $("#safezone-advisory");
  setSafezoneAdvisory(advisory, false);

  // ---- backend event subscriptions ----
  await ipc.listen<LogLineEvent>("log-line", (p) => logView.push(p));
  await ipc.listen<TaskStatusEvent>("task-status", (p) => {
    planPanel.setStatus(p.taskId, p.state);
    if (p.state === "Succeeded") {
      // A produced artifact may now exist — refresh available preview layers.
      void previewer.refresh(store.activeProjectRoot());
    }
  });
  await ipc.listen<PlanProgressEvent>("plan-progress", (p) => {
    $("#run-progress").textContent =
      `L${p.level + 1}: ${p.done}/${p.total}`;
  });

  // ---- top-bar controls ----
  const themeBtn = $("#theme-toggle");
  themeBtn.addEventListener("click", () => {
    const t = toggleTheme();
    themeBtn.textContent = t === "dark" ? "◑ Dark" : "◐ Light";
  });
  themeBtn.textContent = store.getTheme() === "dark" ? "◑ Dark" : "◐ Light";

  const capInput = $<HTMLInputElement>("#cap-input");
  // Persisted cap isn't part of the kv model; keep it local with a sane default.
  capInput.value = "2";

  const runBtn = $<HTMLButtonElement>("#run-btn");
  const cancelBtn = $<HTMLButtonElement>("#cancel-btn");

  runBtn.addEventListener("click", () => {
    const cap = Math.max(1, Number(capInput.value) || 1);
    const root = store.activeProjectRoot() ?? "<project-root>";
    void store.flush();
    void ipc
      .runPlan({
        enabled: [...enabled],
        formValues: store.session().formValues,
        projectRoot: root,
        cap,
      })
      .then((runId) => {
        $("#run-progress").textContent = `run ${runId}`;
        cancelBtn.disabled = false;
      })
      .catch((err) => {
        $("#run-progress").textContent = `error: ${String(err)}`;
      });
  });

  cancelBtn.addEventListener("click", () => {
    // Cancel the currently selected task (per-task cancel is the IPC surface).
    if (selectedTask) void ipc.cancelTask(selectedTask.id);
  });
  cancelBtn.disabled = true;
}

void boot();
