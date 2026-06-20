// src/forms.ts — the schema-driven dynamic form engine + docked help (SADD §3.4/§3.6).
// Single responsibility: render a task's params as controls, mapping type+ui to a
// concrete control, sectioning by ui.group, applying ui.depends_on visibility, and
// — critically — TEACHING the CLI: focusing any control writes its `help`, its
// `flag`, and an example invocation into the docked help panel. Values persist
// keyed "taskId.paramKey" via the store. No assembly logic lives here (that's
// command.ts); this module only collects values and notifies on change.

import type { Param, Task, ControlKind } from "./types";
import { store } from "./state";

/** The help panel this engine drives on focus (SADD §3.6 — the GUI teaches CLI). */
export interface HelpPanel {
  show(html: string): void;
  clear(): void;
}

export interface FormHooks {
  /** Called on any value change (debounced upstream) so previews re-resolve. */
  onChange: () => void;
  help: HelpPanel;
}

/** Decide the concrete control: ui.control overrides; else derive from type. */
export function controlFor(param: Param): ControlKind {
  if (param.ui.control) return param.ui.control;
  switch (param.type) {
    case "bool":
      return "toggle";
    case "number":
      // bounded => slider; unbounded => stepper
      return param.min !== undefined && param.max !== undefined
        ? "slider"
        : "stepper";
    case "enum":
      return "dropdown";
    case "path":
      return "picker";
    case "string":
    default:
      return "field";
  }
}

function stateKey(task: Task, param: Param): string {
  return `${task.id}.${param.key}`;
}

/** Current value: persisted form value, else the param default. */
function currentValue(task: Task, param: Param): unknown {
  const k = stateKey(task, param);
  const v = store.getFormValue(k);
  if (v !== undefined) return v;
  return param.default;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the help-panel HTML for a focused param (help + flag + example). */
function helpHtmlFor(task: Task, param: Param): string {
  const parts: string[] = [];
  parts.push(`<h3 class="help__title">${escapeHtml(param.ui.label)}</h3>`);
  if (param.help) {
    parts.push(`<p class="help__body">${escapeHtml(param.help)}</p>`);
  } else if (param.hint) {
    parts.push(`<p class="help__body">${escapeHtml(param.hint)}</p>`);
  }
  const meta: string[] = [];
  if (param.flag) {
    meta.push(
      `<div class="help__row"><span class="help__k">flag</span><code>${escapeHtml(
        param.flag,
      )}</code></div>`,
    );
  } else if (param.arity === "positional") {
    meta.push(
      `<div class="help__row"><span class="help__k">arg</span><code>positional</code></div>`,
    );
  }
  meta.push(
    `<div class="help__row"><span class="help__k">type</span><code>${param.type}</code></div>`,
  );
  if (param.options) {
    meta.push(
      `<div class="help__row"><span class="help__k">options</span><code>${escapeHtml(
        param.options.map(String).join(" | "),
      )}</code></div>`,
    );
  }
  parts.push(`<div class="help__meta">${meta.join("")}</div>`);

  // Example invocation: prefer the param's own example, else synthesize one.
  let example = param.example;
  if (!example) {
    if (param.arity === "switch" && param.flag) {
      example = param.flag;
    } else if (param.flag) {
      const v =
        param.default !== undefined
          ? String(param.default)
          : param.type === "path"
            ? "<path>"
            : `<${param.key}>`;
      example = `${param.flag} ${v}`;
    } else if (param.arity === "positional") {
      example =
        param.type === "path" ? "<path>" : `<${param.key}>`;
    }
  }
  if (example) {
    parts.push(
      `<div class="help__example"><span class="help__k">example</span><code>${escapeHtml(
        `${task.subcommand} … ${example}`,
      )}</code></div>`,
    );
  }
  return parts.join("");
}

interface ControlBuild {
  /** The labelled wrapper element to mount. */
  wrapper: HTMLElement;
  /** Re-evaluate depends_on visibility against current sibling values. */
  refreshVisibility: () => void;
}

/** Build a single labelled control for a param. */
function buildControl(
  task: Task,
  param: Param,
  hooks: FormHooks,
  notifyChanged: () => void,
): ControlBuild {
  const kind = controlFor(param);
  const wrapper = document.createElement("div");
  wrapper.className = `field field--${kind}`;
  wrapper.dataset.paramKey = param.key;

  const id = `ctl-${task.id}-${param.key}`.replace(/[^a-zA-Z0-9_-]/g, "_");

  const label = document.createElement("label");
  label.className = "field__label";
  label.htmlFor = id;
  label.textContent = param.ui.label;
  if (param.required) {
    const req = document.createElement("span");
    req.className = "field__req";
    req.textContent = "*";
    req.title = "required";
    label.appendChild(req);
  }
  if (param.hint) label.title = param.hint; // tooltip from hint

  const set = (value: unknown) => {
    store.setFormValue(stateKey(task, param), value);
    notifyChanged();
  };
  const focusHelp = () => hooks.help.show(helpHtmlFor(task, param));

  const cur = currentValue(task, param);
  let input: HTMLElement;

  switch (kind) {
    case "toggle": {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.id = id;
      el.className = "field__toggle";
      el.checked = Boolean(cur);
      el.addEventListener("change", () => set(el.checked));
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
    case "slider": {
      const row = document.createElement("div");
      row.className = "field__sliderrow";
      const el = document.createElement("input");
      el.type = "range";
      el.id = id;
      el.className = "field__slider";
      if (param.min !== undefined) el.min = String(param.min);
      if (param.max !== undefined) el.max = String(param.max);
      if (param.step !== undefined) el.step = String(param.step);
      el.value = cur !== undefined && cur !== null ? String(cur) : el.min || "0";
      const out = document.createElement("output");
      out.className = "field__sliderval";
      out.textContent = el.value;
      el.addEventListener("input", () => {
        out.textContent = el.value;
        set(Number(el.value));
      });
      el.addEventListener("focus", focusHelp);
      row.append(el, out);
      input = row;
      break;
    }
    case "stepper": {
      const el = document.createElement("input");
      el.type = "number";
      el.id = id;
      el.className = "field__stepper";
      if (param.min !== undefined) el.min = String(param.min);
      if (param.max !== undefined) el.max = String(param.max);
      if (param.step !== undefined) el.step = String(param.step);
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("input", () =>
        set(el.value === "" ? null : Number(el.value)),
      );
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
    case "dropdown": {
      const el = document.createElement("select");
      el.id = id;
      el.className = "field__select";
      if (!param.required) {
        const none = document.createElement("option");
        none.value = "";
        none.textContent = "(default)";
        el.appendChild(none);
      }
      for (const opt of param.options ?? []) {
        const o = document.createElement("option");
        o.value = String(opt);
        o.textContent = String(opt);
        el.appendChild(o);
      }
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("change", () =>
        set(el.value === "" ? null : el.value),
      );
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
    case "picker": {
      // A path picker: a text field + a Browse stub. Real file dialog is a
      // backend concern (Tauri dialog plugin); here we accept a typed path.
      const row = document.createElement("div");
      row.className = "field__pickerrow";
      const el = document.createElement("input");
      el.type = "text";
      el.id = id;
      el.className = "field__field";
      el.placeholder = param.example ?? "path…";
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("input", () => set(el.value === "" ? null : el.value));
      el.addEventListener("focus", focusHelp);
      const browse = document.createElement("button");
      browse.type = "button";
      browse.className = "field__browse";
      browse.textContent = "Browse…";
      browse.title = "Path picker (backend dialog) — type a path in dev mode";
      browse.addEventListener("click", () => el.focus());
      row.append(el, browse);
      input = row;
      break;
    }
    case "field":
    default: {
      const el = document.createElement("input");
      el.type = "text";
      el.id = id;
      el.className = "field__field";
      if (param.example) el.placeholder = param.example;
      if (cur !== undefined && cur !== null) el.value = String(cur);
      el.addEventListener("input", () => set(el.value === "" ? null : el.value));
      el.addEventListener("focus", focusHelp);
      input = el;
      break;
    }
  }

  input.classList.add("field__input");
  wrapper.append(label, input);

  const refreshVisibility = () => {
    const dep = param.ui.depends_on;
    if (!dep) {
      wrapper.hidden = false;
      return;
    }
    // depends_on resolves against a SIBLING param in the same task.
    const sibling = task.params.find((p) => p.key === dep.key);
    let siblingValue: unknown = undefined;
    if (sibling) {
      const v = store.getFormValue(stateKey(task, sibling));
      siblingValue = v !== undefined ? v : sibling.default;
    } else {
      // dep.key may reference a bare key already stored under this task.
      siblingValue = store.getFormValue(`${task.id}.${dep.key}`);
    }
    const visible =
      "equals" in dep ? siblingValue === dep.equals : Boolean(siblingValue);
    wrapper.hidden = !visible;
  };

  return { wrapper, refreshVisibility };
}

export interface RenderedForm {
  el: HTMLElement;
  task: Task;
}

/**
 * Render a task's full form into `host`. Groups params by ui.group, wires
 * depends_on cross-refresh, and persists every change. Returns the mounted root.
 */
export function renderForm(
  host: HTMLElement,
  task: Task,
  hooks: FormHooks,
): RenderedForm {
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "form";

  const header = document.createElement("div");
  header.className = "form__header";
  header.innerHTML = `
    <h2 class="form__title">${escapeHtml(task.label)}</h2>
    <code class="form__subcommand">${escapeHtml(task.subcommand)}</code>
  `;
  if (task.hint) {
    const hint = document.createElement("p");
    hint.className = "form__hint";
    hint.textContent = task.hint;
    header.appendChild(hint);
  }
  root.appendChild(header);

  const builds: ControlBuild[] = [];
  const refreshAll = () => builds.forEach((b) => b.refreshVisibility());

  // depends_on changes must re-evaluate visibility across the whole form.
  const notifyChanged = () => {
    refreshAll();
    hooks.onChange();
  };

  // Group params by ui.group (preserving first-seen order), sort within by order.
  const groups = new Map<string, Param[]>();
  for (const p of task.params) {
    const g = p.ui.group ?? "Options";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(p);
  }

  for (const [groupName, params] of groups) {
    const section = document.createElement("section");
    section.className = "form__group";
    const legend = document.createElement("h4");
    legend.className = "form__grouptitle";
    legend.textContent = groupName;
    section.appendChild(legend);

    const sorted = [...params].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    for (const p of sorted) {
      const build = buildControl(task, p, hooks, notifyChanged);
      builds.push(build);
      section.appendChild(build.wrapper);
    }
    root.appendChild(section);
  }

  if (task.params.length === 0) {
    const none = document.createElement("p");
    none.className = "form__empty";
    none.textContent = "This task takes no parameters.";
    root.appendChild(none);
  }

  host.appendChild(root);
  refreshAll(); // initial depends_on pass

  // Seed the help panel with the task's own help if present.
  if (task.help) {
    hooks.help.show(
      `<h3 class="help__title">${escapeHtml(task.label)}</h3>` +
        `<p class="help__body">${escapeHtml(task.help)}</p>` +
        `<div class="help__example"><span class="help__k">subcommand</span><code>${escapeHtml(
          task.subcommand,
        )}</code></div>`,
    );
  }

  return { el: root, task };
}
