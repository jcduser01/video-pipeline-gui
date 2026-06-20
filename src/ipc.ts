// src/ipc.ts — the single IPC boundary between the pure-presentation frontend
// and the Rust/Tauri backend (SADD §2.1). Single responsibility: expose ONE
// `Ipc` interface and pick an implementation at runtime — `TauriIpc` (real,
// `invoke`/`listen`) when `window.__TAURI__` is present, else `MockIpc` (a JS
// port of the backend rules so the app runs in a plain browser for dev).
//
// All business logic in MockIpc is a deliberate MIRROR of the Rust backend
// (argv assembly + scheduler), kept here so dev mode behaves identically. The
// frontend itself never decides what the pipeline does; it only renders.

import type {
  AppState,
  Plan,
  ResolveArgvArgs,
  Schema,
  TaskState,
} from "./types";

// ---------------------------------------------------------------------------
// Event bus (shared shape between Tauri's `listen` and the mock emitter).
// ---------------------------------------------------------------------------

export type IpcEvent =
  | "log-line"
  | "task-status"
  | "plan-progress";

export type UnlistenFn = () => void;

export interface RunPlanArgs {
  enabled: string[];
  formValues: Record<string, unknown>;
  projectRoot: string;
  cap: number;
}

export interface Ipc {
  loadSchema(): Promise<Schema>;
  resolveArgv(args: ResolveArgvArgs): Promise<string[]>;
  buildPlan(enabled: string[]): Promise<Plan>;
  runPlan(args: RunPlanArgs): Promise<string>;
  cancelTask(taskId: string): Promise<void>;
  listPresentArtifacts(projectRoot: string): Promise<string[]>;
  readState(): Promise<AppState | null>;
  writeState(state: AppState): Promise<void>;
  listen<T>(event: IpcEvent, handler: (payload: T) => void): Promise<UnlistenFn>;
}

// ---------------------------------------------------------------------------
// Shared rule ports (used by MockIpc AND command.ts preview in mock mode).
// ---------------------------------------------------------------------------

/**
 * Pure JS port of the backend argv-assembly rule. Mirrors the Rust gateway so
 * the resolved-command preview is faithful in dev mode.
 *
 * Order:
 *   1. [cli_entrypoint, ...subcommand.split(' ')]
 *   2. positionals: params(arity=positional) + io(via=positional), sorted by `order`
 *   3. value params: flag + value, when value != null
 *   4. switch params: flag only, when truthy
 *   5. io flag bindings: flag + artifactPaths[artifact]
 */
export function assembleArgv(
  schema: Schema,
  args: ResolveArgvArgs,
): string[] {
  const task = schema.tasks.find((t) => t.id === args.taskId);
  if (!task) return [];
  const { formValues, artifactPaths } = args;

  const argv: string[] = [schema.engine.cli_entrypoint];
  for (const part of task.subcommand.split(" ")) {
    if (part.length > 0) argv.push(part);
  }

  const valueFor = (key: string): unknown => {
    const k = `${task.id}.${key}`;
    if (k in formValues && formValues[k] !== undefined && formValues[k] !== "") {
      return formValues[k];
    }
    const p = task.params.find((pp) => pp.key === key);
    return p ? p.default : undefined;
  };

  // --- positionals (params + io), interleaved, sorted by order ---
  interface Positional {
    order: number;
    value: string | null;
  }
  const positionals: Positional[] = [];

  for (const p of task.params) {
    if (p.arity !== "positional") continue;
    const v = valueFor(p.key);
    positionals.push({
      order: p.order ?? 0,
      value: v === undefined || v === null ? null : String(v),
    });
  }
  for (const io of task.io) {
    if (io.via !== "positional") continue;
    const v = artifactPaths[io.artifact];
    positionals.push({
      order: io.order ?? 0,
      value: v === undefined || v === null ? null : String(v),
    });
  }
  positionals.sort((a, b) => a.order - b.order);
  for (const pos of positionals) {
    if (pos.value !== null) argv.push(pos.value);
  }

  // --- value params (flag + value) ---
  for (const p of task.params) {
    if (p.arity !== "value") continue;
    const v = valueFor(p.key);
    if (v === undefined || v === null || v === "") continue;
    if (p.flag) argv.push(p.flag);
    argv.push(String(v));
  }

  // --- switch params (flag only when truthy) ---
  for (const p of task.params) {
    if (p.arity !== "switch") continue;
    const v = valueFor(p.key);
    if (v === true && p.flag) argv.push(p.flag);
  }

  // --- io flag bindings (flag + path) ---
  for (const io of task.io) {
    if (io.via !== "flag" || !io.flag) continue;
    const path = artifactPaths[io.artifact];
    if (path === undefined || path === null) continue;
    argv.push(io.flag, String(path));
  }

  return argv;
}

/**
 * Pure JS port of the scheduler. A consumer of channel `c` binds to the latest
 * ENABLED task that produces `c` and is declared before it (by index). Missing
 * producer => throw "NoProducer <task> <channel>". Kahn-level the enabled
 * subgraph into levels[]; skipped = disabled tasks.
 */
export function computePlan(schema: Schema, enabled: string[]): Plan {
  const enabledSet = new Set(enabled);
  const tasks = schema.tasks;
  const enabledTasks = tasks.filter((t) => enabledSet.has(t.id));

  const bindings: Record<string, { channel: string; producer: string }[]> = {};
  const edges: Record<string, string[]> = {};
  const indeg: Record<string, number> = {};

  for (const t of enabledTasks) {
    bindings[t.id] = [];
    edges[t.id] = [];
    indeg[t.id] = 0;
  }

  // Resolve each consumer's binding to the latest-prior enabled producer.
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!enabledSet.has(t.id)) continue;
    for (const channel of t.consumes) {
      let producer: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const cand = tasks[j];
        if (!enabledSet.has(cand.id)) continue;
        if (cand.produces.includes(channel)) {
          producer = cand.id;
          break;
        }
      }
      if (producer === null) {
        throw `NoProducer ${t.id} ${channel}`;
      }
      bindings[t.id].push({ channel, producer });
    }
  }

  // Build the DAG edges (producer -> consumer) and in-degrees.
  for (const consumer of Object.keys(bindings)) {
    for (const b of bindings[consumer]) {
      // de-dup multi-channel edges between the same pair
      if (!edges[b.producer].includes(consumer)) {
        edges[b.producer].push(consumer);
        indeg[consumer] += 1;
      }
    }
  }

  // Kahn level assignment, preserving declaration order within a level.
  const levels: string[][] = [];
  const remaining = new Set(enabledTasks.map((t) => t.id));
  const localIndeg = { ...indeg };

  while (remaining.size > 0) {
    const level = enabledTasks
      .filter((t) => remaining.has(t.id) && localIndeg[t.id] === 0)
      .map((t) => t.id);
    if (level.length === 0) {
      throw "PlanError cycle detected";
    }
    levels.push(level);
    for (const id of level) {
      remaining.delete(id);
      for (const child of edges[id]) {
        localIndeg[child] -= 1;
      }
    }
  }

  const skipped: Record<string, string> = {};
  for (const t of tasks) {
    if (!enabledSet.has(t.id)) skipped[t.id] = "Disabled";
  }

  return { levels, skipped, bindings, edges };
}

// ---------------------------------------------------------------------------
// TauriIpc — the real backend. Delegates everything to Rust.
// ---------------------------------------------------------------------------

class TauriIpc implements Ipc {
  // Lazily imported so the module loads in a plain browser without @tauri-apps.
  private async core() {
    return await import("@tauri-apps/api/core");
  }
  private async events() {
    return await import("@tauri-apps/api/event");
  }

  async loadSchema(): Promise<Schema> {
    const { invoke } = await this.core();
    return await invoke<Schema>("load_schema");
  }

  async resolveArgv(args: ResolveArgvArgs): Promise<string[]> {
    const { invoke } = await this.core();
    return await invoke<string[]>("resolve_argv", {
      taskId: args.taskId,
      formValues: args.formValues,
      artifactPaths: args.artifactPaths,
    });
  }

  async buildPlan(enabled: string[]): Promise<Plan> {
    const { invoke } = await this.core();
    return await invoke<Plan>("build_plan", { enabled });
  }

  async runPlan(args: RunPlanArgs): Promise<string> {
    const { invoke } = await this.core();
    return await invoke<string>("run_plan", {
      enabled: args.enabled,
      formValues: args.formValues,
      projectRoot: args.projectRoot,
      cap: args.cap,
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    const { invoke } = await this.core();
    await invoke("cancel_task", { taskId });
  }

  async listPresentArtifacts(projectRoot: string): Promise<string[]> {
    const { invoke } = await this.core();
    return await invoke<string[]>("list_present_artifacts", { projectRoot });
  }

  async readState(): Promise<AppState | null> {
    const { invoke } = await this.core();
    return await invoke<AppState | null>("read_state");
  }

  async writeState(state: AppState): Promise<void> {
    const { invoke } = await this.core();
    await invoke("write_state", { state });
  }

  async listen<T>(
    event: IpcEvent,
    handler: (payload: T) => void,
  ): Promise<UnlistenFn> {
    const { listen } = await this.events();
    const un = await listen<T>(event, (e) => handler(e.payload));
    return un;
  }
}

// ---------------------------------------------------------------------------
// MockIpc — browser dev. Loads the fixture; ports the rules; fakes a run.
// ---------------------------------------------------------------------------

class MockIpc implements Ipc {
  private schema: Schema | null = null;
  private state: AppState | null = null;
  private listeners: Map<IpcEvent, Set<(p: unknown) => void>> = new Map();
  private cancelled: Set<string> = new Set();

  private emit(event: IpcEvent, payload: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of set) h(payload);
  }

  async loadSchema(): Promise<Schema> {
    if (this.schema) return this.schema;
    // Fetch the fixture relative to the app root (also the mock-mode schema).
    const res = await fetch("./tests/fixtures/sample-schema.json");
    if (!res.ok) {
      throw `MockIpc: could not load fixture (${res.status})`;
    }
    this.schema = (await res.json()) as Schema;
    return this.schema;
  }

  async resolveArgv(args: ResolveArgvArgs): Promise<string[]> {
    const schema = await this.loadSchema();
    return assembleArgv(schema, args);
  }

  async buildPlan(enabled: string[]): Promise<Plan> {
    const schema = await this.loadSchema();
    return computePlan(schema, enabled); // may throw a PlanError string
  }

  async runPlan(args: RunPlanArgs): Promise<string> {
    const schema = await this.loadSchema();
    const plan = computePlan(schema, args.enabled);
    const runId = `mock-${Date.now()}`;
    this.cancelled.clear();
    // Drive a fake run: walk levels, stream a couple of lines per task,
    // transition status, and emit plan-progress. Async, non-blocking.
    void this.driveFakeRun(runId, schema, plan, args);
    return runId;
  }

  private async driveFakeRun(
    runId: string,
    schema: Schema,
    plan: Plan,
    args: RunPlanArgs,
  ): Promise<void> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Mark disabled tasks Skipped up front.
    for (const taskId of Object.keys(plan.skipped)) {
      this.emit("task-status", { taskId, state: "Skipped" as TaskState });
    }

    for (let lvl = 0; lvl < plan.levels.length; lvl++) {
      const level = plan.levels[lvl];
      const total = level.length;
      let done = 0;
      this.emit("plan-progress", { runId, level: lvl, done, total });

      // Tasks within a level run "in parallel" — interleave their lines.
      const runners = level.map(async (taskId) => {
        if (this.cancelled.has(taskId)) {
          this.emit("task-status", { taskId, state: "Blocked" as TaskState });
          return;
        }
        const task = schema.tasks.find((t) => t.id === taskId);
        this.emit("task-status", { taskId, state: "Running" as TaskState });

        // Echo the resolved argv at task start (mirrors backend behaviour).
        const argv = assembleArgv(schema, {
          taskId,
          formValues: args.formValues,
          artifactPaths: this.mockArtifactPaths(schema, args.projectRoot),
        });
        this.emit("log-line", {
          taskId,
          stream: "stdout",
          line: `$ ${argv.join(" ")}`,
        });

        await sleep(120 + Math.random() * 200);
        this.emit("log-line", {
          taskId,
          stream: "stdout",
          line: `[mock] ${task?.label ?? taskId}: working…`,
        });
        await sleep(180 + Math.random() * 260);

        if (this.cancelled.has(taskId)) {
          this.emit("log-line", {
            taskId,
            stream: "stderr",
            line: "[mock] cancelled",
          });
          this.emit("task-status", { taskId, state: "Failed" as TaskState });
          return;
        }
        this.emit("log-line", {
          taskId,
          stream: "stdout",
          line: `[mock] ${task?.label ?? taskId}: done.`,
        });
        this.emit("task-status", { taskId, state: "Succeeded" as TaskState });
      });

      // Emit incremental progress as each completes.
      for (const r of runners) {
        // eslint-disable-next-line no-await-in-loop
        await r;
        done += 1;
        this.emit("plan-progress", { runId, level: lvl, done, total });
      }
    }
  }

  private mockArtifactPaths(
    schema: Schema,
    projectRoot: string,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of schema.artifacts) {
      out[a.id] = `${projectRoot}/${a.path}`;
    }
    return out;
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }

  async listPresentArtifacts(_projectRoot: string): Promise<string[]> {
    // Pretend the base video and caption overlay exist on disk.
    return ["base", "caption"];
  }

  async readState(): Promise<AppState | null> {
    if (this.state) return this.state;
    // Hydrate from localStorage so mock dev persists across reloads.
    try {
      const raw = localStorage.getItem("vpgui.state");
      if (raw) this.state = JSON.parse(raw) as AppState;
    } catch {
      this.state = null;
    }
    return this.state;
  }

  async writeState(state: AppState): Promise<void> {
    this.state = state;
    try {
      localStorage.setItem("vpgui.state", JSON.stringify(state));
    } catch {
      /* ignore quota / private-mode failures in dev */
    }
  }

  async listen<T>(
    event: IpcEvent,
    handler: (payload: T) => void,
  ): Promise<UnlistenFn> {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = (p: unknown) => handler(p as T);
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }
}

// ---------------------------------------------------------------------------
// Runtime selection.
// ---------------------------------------------------------------------------

function isTauri(): boolean {
  // Tauri v2 always injects `__TAURI_INTERNALS__` into the webview; the legacy
  // `__TAURI__` global only appears when `withGlobalTauri` is enabled. Check both
  // so the real backend is used under `tauri dev` regardless of that setting.
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export const ipc: Ipc = isTauri() ? new TauriIpc() : new MockIpc();

export const IPC_MODE: "tauri" | "mock" = isTauri() ? "tauri" : "mock";
