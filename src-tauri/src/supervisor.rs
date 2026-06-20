//! Process supervisor & live logging (SADD §5).
//!
//! Runs a `Plan`: spawns each task as a child process, streams stdout/stderr
//! line-by-line, verifies the declared output artifacts appeared on disk, and
//! propagates `Blocked` downstream on failure. Concurrency within a level is
//! bounded by the cap (SADD §4.4).
//!
//! Emission is abstracted behind `Emitter` so the Tauri layer wires real events
//! and tests can capture them. Everything that touches the OS lives here; the
//! scheduler stays pure.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;

use crate::command::resolve_argv;
use crate::scheduler::{Plan, TaskState};
use crate::schema::Schema;

// Event payloads serialize camelCase to match the frontend's event types
// (taskId / runId). Tauri does not auto-convert emitted event bodies (only
// command argument names), so the casing must match here.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub task_id: String,
    pub stream: String, // stdout | stderr
    pub line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub task_id: String,
    pub state: TaskState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgress {
    pub run_id: String,
    pub level: usize,
    pub done: usize,
    pub total: usize,
}

/// Sink for the three event kinds. The Tauri layer forwards these to the webview;
/// tests collect them.
pub trait Emitter: Send + Sync {
    fn log(&self, line: LogLine);
    fn status(&self, ev: StatusEvent);
    fn progress(&self, p: PlanProgress);
}

/// Shared cancellation registry: task_id -> child pid handle slot. A cancel
/// request flips the flag; a running task checks it and is killed.
#[derive(Default)]
pub struct Cancellation {
    cancelled: Mutex<BTreeSet<String>>,
}

impl Cancellation {
    pub async fn request(&self, task_id: &str) {
        self.cancelled.lock().await.insert(task_id.to_string());
    }
    async fn is_cancelled(&self, task_id: &str) -> bool {
        self.cancelled.lock().await.contains(task_id)
    }
}

pub struct RunConfig {
    pub run_id: String,
    pub project_root: PathBuf,
    pub cap: usize,
    /// form values keyed "task_id.param_key" (as persisted in state)
    pub form_values: HashMap<String, Value>,
}

/// Resolve the concrete on-disk path for an artifact id within a project.
fn artifact_path(schema: &Schema, project_root: &Path, artifact_id: &str) -> Option<String> {
    schema
        .artifact(artifact_id)
        .map(|a| project_root.join(&a.path).to_string_lossy().to_string())
}

/// Build the form-value map for a single task (strip the "task_id." prefix).
fn task_form_values(all: &HashMap<String, Value>, task_id: &str) -> HashMap<String, Value> {
    let prefix = format!("{task_id}.");
    all.iter()
        .filter_map(|(k, v)| k.strip_prefix(&prefix).map(|key| (key.to_string(), v.clone())))
        .collect()
}

/// Run the whole plan. Returns the final per-task state map.
pub async fn run_plan(
    schema: Arc<Schema>,
    plan: Arc<Plan>,
    cfg: RunConfig,
    emitter: Arc<dyn Emitter>,
    cancel: Arc<Cancellation>,
) -> HashMap<String, TaskState> {
    let mut states: HashMap<String, TaskState> = HashMap::new();
    for id in plan.scheduled() {
        emitter.status(StatusEvent {
            task_id: id.clone(),
            state: TaskState::Pending,
        });
        states.insert(id, TaskState::Pending);
    }
    // Disabled tasks are reported Skipped up front (they never enter the graph).
    for id in plan.skipped.keys() {
        emitter.status(StatusEvent {
            task_id: id.clone(),
            state: TaskState::Skipped,
        });
    }
    let states = Arc::new(Mutex::new(states));
    let mut failed: BTreeSet<String> = BTreeSet::new();
    let total = plan.scheduled().len();
    let mut done = 0usize;

    for (level_idx, _) in plan.levels.iter().enumerate() {
        // Tasks in this level whose upstreams haven't failed; the rest are Blocked.
        let blocked = plan.cascade_blocked(&failed);
        for wave in plan.waves(level_idx, cfg.cap) {
            let mut handles = Vec::new();
            for task_id in wave {
                if blocked.contains(&task_id) {
                    set_state(&states, &task_id, TaskState::Blocked, &emitter).await;
                    continue;
                }
                let schema = schema.clone();
                let cfg_root = cfg.project_root.clone();
                let form = task_form_values(&cfg.form_values, &task_id);
                let emitter = emitter.clone();
                let cancel = cancel.clone();
                let states = states.clone();
                handles.push(tokio::spawn(async move {
                    let ok = run_one(&schema, &task_id, &cfg_root, &form, &emitter, &cancel, &states)
                        .await;
                    (task_id, ok)
                }));
            }
            for h in handles {
                if let Ok((task_id, ok)) = h.await {
                    done += 1;
                    if !ok {
                        failed.insert(task_id);
                    }
                    emitter.progress(PlanProgress {
                        run_id: cfg.run_id.clone(),
                        level: level_idx,
                        done,
                        total,
                    });
                }
            }
        }
    }

    // Anything reverse-reachable from a failure that never ran is Blocked.
    let blocked = plan.cascade_blocked(&failed);
    for b in &blocked {
        set_state(&states, b, TaskState::Blocked, &emitter).await;
    }

    Arc::try_unwrap(states).map(|m| m.into_inner()).unwrap_or_default()
}

async fn set_state(
    states: &Arc<Mutex<HashMap<String, TaskState>>>,
    task_id: &str,
    state: TaskState,
    emitter: &Arc<dyn Emitter>,
) {
    states.lock().await.insert(task_id.to_string(), state);
    emitter.status(StatusEvent {
        task_id: task_id.to_string(),
        state,
    });
}

/// Spawn one task, stream its output, verify its produced artifacts. Returns
/// true on success (exit 0 AND all declared outputs present).
async fn run_one(
    schema: &Schema,
    task_id: &str,
    project_root: &Path,
    form: &HashMap<String, Value>,
    emitter: &Arc<dyn Emitter>,
    cancel: &Arc<Cancellation>,
    states: &Arc<Mutex<HashMap<String, TaskState>>>,
) -> bool {
    let task = match schema.task(task_id) {
        Some(t) => t,
        None => return false,
    };

    // Resolve artifact paths for every consumed/produced channel.
    let mut artifact_paths: HashMap<String, String> = HashMap::new();
    for ch in task.consumes.iter().chain(task.produces.iter()) {
        if let Some(p) = artifact_path(schema, project_root, ch) {
            artifact_paths.insert(ch.clone(), p);
        }
    }

    let argv = match resolve_argv(schema, task_id, form, &artifact_paths) {
        Ok(a) => a,
        Err(e) => {
            emitter.log(LogLine {
                task_id: task_id.into(),
                stream: "stderr".into(),
                line: format!("argv error: {e}"),
            });
            set_state(states, task_id, TaskState::Failed, emitter).await;
            return false;
        }
    };

    set_state(states, task_id, TaskState::Running, emitter).await;
    // The resolved argv is printed at task start — the teaching/debugging affordance.
    emitter.log(LogLine {
        task_id: task_id.into(),
        stream: "stdout".into(),
        line: format!("$ {}", argv.join(" ")),
    });

    let mut cmd = TokioCommand::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(project_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emitter.log(LogLine {
                task_id: task_id.into(),
                stream: "stderr".into(),
                line: format!("spawn failed: {e}"),
            });
            set_state(states, task_id, TaskState::Failed, emitter).await;
            return false;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_task = stream_lines(stdout, task_id.to_string(), "stdout", emitter.clone());
    let err_task = stream_lines(stderr, task_id.to_string(), "stderr", emitter.clone());

    // Poll for completion or cancellation.
    let status = loop {
        if cancel.is_cancelled(task_id).await {
            let _ = child.kill().await;
            emitter.log(LogLine {
                task_id: task_id.into(),
                stream: "stderr".into(),
                line: "cancelled".into(),
            });
            let _ = tokio::join!(out_task, err_task);
            set_state(states, task_id, TaskState::Failed, emitter).await;
            return false;
        }
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            Err(_) => break std::process::ExitStatus::default(),
        }
    };
    let _ = tokio::join!(out_task, err_task);

    // Fail = exit != 0, OR exit 0 but a declared output is missing (silent no-op).
    let exit_ok = status.success();
    let outputs_present = task.produces.iter().all(|ch| {
        artifact_path(schema, project_root, ch)
            .map(|p| Path::new(&p).exists())
            .unwrap_or(false)
    });

    if exit_ok && outputs_present {
        set_state(states, task_id, TaskState::Succeeded, emitter).await;
        true
    } else {
        if exit_ok && !outputs_present {
            emitter.log(LogLine {
                task_id: task_id.into(),
                stream: "stderr".into(),
                line: "exit 0 but a declared output artifact is missing — treating as failure"
                    .into(),
            });
        }
        set_state(states, task_id, TaskState::Failed, emitter).await;
        false
    }
}

/// Read a child stream line-by-line on its own task, emitting each line. Returns
/// a JoinHandle the caller awaits so output drains before exit is reported.
fn stream_lines<R>(
    reader: Option<R>,
    task_id: String,
    stream: &'static str,
    emitter: Arc<dyn Emitter>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        if let Some(r) = reader {
            let mut lines = BufReader::new(r).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emitter.log(LogLine {
                    task_id: task_id.clone(),
                    stream: stream.into(),
                    line,
                });
            }
        }
    })
}
