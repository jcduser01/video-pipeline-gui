// src/types.ts — the frozen contract, as TypeScript types (SADD §3).
// Single responsibility: mirror schema/meta-schema.json exactly so every module
// renders the same shape. No fields are invented here; this is the read-only
// grammar the Rust gateway validates against at load. If the meta-schema moves,
// this file moves with it (and only this file).

export type ParamType = "bool" | "number" | "enum" | "string" | "path";
export type ParamArity = "positional" | "value" | "switch";
export type ControlKind =
  | "toggle"
  | "slider"
  | "stepper"
  | "dropdown"
  | "field"
  | "picker";
export type ArtifactKind = "layer" | "descriptor" | "media" | "manifest";

/** ui.depends_on:{key,equals} — conditional visibility against a sibling param. */
export interface DependsOn {
  key: string;
  equals?: unknown;
}

export interface UiSpec {
  label: string;
  control?: ControlKind;
  group?: string;
  depends_on?: DependsOn;
}

export interface Param {
  key: string;
  type: ParamType;
  arity: ParamArity;
  control: ControlKind;
  order?: number;
  flag?: string;
  default?: unknown;
  required?: boolean;
  options?: unknown[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  help?: string;
  example?: string;
  ui: UiSpec;
}

export interface Step {
  id: string;
  label: string;
  order: number;
  optional: boolean;
  hint?: string;
  help?: string;
}

export type IoRole = "input" | "output";
export type IoVia = "positional" | "flag";

export interface IoBinding {
  artifact: string;
  role: IoRole;
  via: IoVia;
  flag?: string;
  order?: number;
}

export interface Task {
  id: string;
  step: string;
  label: string;
  subcommand: string;
  optional: boolean;
  consumes: string[];
  produces: string[];
  io: IoBinding[];
  params: Param[];
  hint?: string;
  help?: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  path: string;
  previewable: boolean;
  z_order?: number;
  codec_hint?: string;
  hint?: string;
  help?: string;
}

export interface ExportTarget {
  id: string;
  label: string;
  subcommand: string;
  bundle: string;
  params: Param[];
  hint?: string;
  help?: string;
}

export interface Engine {
  name: string;
  version: string;
  schema_version: string;
  cli_entrypoint: string;
}

export interface Schema {
  engine: Engine;
  steps: Step[];
  tasks: Task[];
  artifacts: Artifact[];
  export_targets: ExportTarget[];
}

// ---- Plan (build_plan result) ----------------------------------------------

export interface PlanBinding {
  channel: string;
  producer: string;
}

export interface Plan {
  levels: string[][];
  skipped: Record<string, string>;
  bindings: Record<string, PlanBinding[]>;
  edges: Record<string, string[]>;
}

// ---- Runtime task state ----------------------------------------------------

export type TaskState =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Blocked"
  | "Skipped";

// ---- Event payloads --------------------------------------------------------

export interface LogLineEvent {
  taskId: string;
  stream: "stdout" | "stderr";
  line: string;
}

export interface TaskStatusEvent {
  taskId: string;
  state: TaskState;
}

export interface PlanProgressEvent {
  runId: string;
  level: number;
  done: number;
  total: number;
}

// ---- Persisted kv state model ----------------------------------------------

export type Theme = "light" | "dark";

export interface SessionState {
  formValues: Record<string, unknown>; // keyed "taskId.paramKey"
  previewLayer?: string;
  theme?: Theme;
}

export interface AppState {
  pipeline_path?: string;
  schema_path?: string;
  projects: Record<string, string>;
  active_project?: string;
  session: SessionState;
}

/** Inputs to argv assembly — shared by command.ts and the mock IPC. */
export interface ResolveArgvArgs {
  taskId: string;
  formValues: Record<string, unknown>;
  artifactPaths: Record<string, string>;
}
