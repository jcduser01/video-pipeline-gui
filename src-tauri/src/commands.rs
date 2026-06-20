//! IPC surface (SADD §2.4 "IPC"). Thin Tauri command wrappers over the core
//! modules + a `TauriEmitter` that forwards supervisor events to the webview.
//!
//! The frontend holds no pipeline knowledge beyond what these commands return.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Emitter as _, Manager, State};
use tokio::sync::Mutex;

use crate::command::resolve_argv as core_resolve_argv;
use crate::scheduler::{build_plan as core_build_plan, Plan};
use crate::schema::Schema;
use crate::state::{default_store_path, AppState};
use crate::supervisor::{
    self, Cancellation, Emitter, LogLine, PlanProgress, RunConfig, StatusEvent,
};

/// Managed application context.
pub struct AppCtx {
    pub schema: Mutex<Option<Arc<Schema>>>,
    pub state: Mutex<AppState>,
    pub cancel: Arc<Cancellation>,
    pub store_path: PathBuf,
    pub run_seq: AtomicU64,
}

impl AppCtx {
    pub fn new(store_path: PathBuf) -> Self {
        let state = AppState::load(&store_path);
        AppCtx {
            schema: Mutex::new(None),
            state: Mutex::new(state),
            cancel: Arc::new(Cancellation::default()),
            store_path,
            run_seq: AtomicU64::new(1),
        }
    }
}

/// Forwards the supervisor's three event kinds to the webview as Tauri events.
struct TauriEmitter {
    app: AppHandle,
}

impl Emitter for TauriEmitter {
    fn log(&self, line: LogLine) {
        let _ = self.app.emit("log-line", line);
    }
    fn status(&self, ev: StatusEvent) {
        let _ = self.app.emit("task-status", ev);
    }
    fn progress(&self, p: PlanProgress) {
        let _ = self.app.emit("plan-progress", p);
    }
}

/// Bundled default schema so the GUI works with zero configuration (first launch,
/// UI QA). This is the canonical committed schema the contract test keeps in sync
/// with the live pipeline emit; a configured `schema_path` (set via
/// `set_schema_path`) overrides it.
const DEFAULT_SCHEMA: &str = include_str!("../../tests/fixtures/sample-schema.json");

async fn current_schema(ctx: &AppCtx) -> Result<Arc<Schema>, String> {
    if let Some(s) = ctx.schema.lock().await.as_ref() {
        return Ok(s.clone());
    }
    // Prefer a configured schema_path; otherwise fall back to the bundled default
    // so the app is usable out of the box.
    let path = {
        let st = ctx.state.lock().await;
        st.schema_path.clone()
    };
    let schema = match path {
        Some(p) => Schema::load(Path::new(&p)).map_err(|e| e.to_string())?,
        None => Schema::from_str(DEFAULT_SCHEMA, true).map_err(|e| e.to_string())?,
    };
    let arc = Arc::new(schema);
    *ctx.schema.lock().await = Some(arc.clone());
    Ok(arc)
}

#[tauri::command]
pub async fn load_schema(ctx: State<'_, AppCtx>) -> Result<Schema, String> {
    let s = current_schema(&ctx).await?;
    Ok((*s).clone())
}

#[tauri::command]
pub async fn set_schema_path(ctx: State<'_, AppCtx>, path: String) -> Result<Schema, String> {
    let schema = Schema::load(Path::new(&path)).map_err(|e| e.to_string())?;
    let arc = Arc::new(schema);
    *ctx.schema.lock().await = Some(arc.clone());
    {
        let mut st = ctx.state.lock().await;
        st.schema_path = Some(path);
        let _ = st.save(&ctx.store_path);
    }
    Ok((*arc).clone())
}

#[tauri::command]
pub async fn resolve_argv(
    ctx: State<'_, AppCtx>,
    task_id: String,
    form_values: HashMap<String, Value>,
    artifact_paths: HashMap<String, String>,
) -> Result<Vec<String>, String> {
    let s = current_schema(&ctx).await?;
    core_resolve_argv(&s, &task_id, &form_values, &artifact_paths).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn build_plan(ctx: State<'_, AppCtx>, enabled: Vec<String>) -> Result<Plan, String> {
    let s = current_schema(&ctx).await?;
    let set = enabled.into_iter().collect();
    core_build_plan(&s, &set).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn run_plan(
    app: AppHandle,
    ctx: State<'_, AppCtx>,
    enabled: Vec<String>,
    form_values: HashMap<String, Value>,
    project_root: String,
    cap: usize,
) -> Result<String, String> {
    let schema = current_schema(&ctx).await?;
    let set = enabled.into_iter().collect();
    let plan = core_build_plan(&schema, &set).map_err(|e| e.to_string())?;
    let run_id = format!("run-{}", ctx.run_seq.fetch_add(1, Ordering::SeqCst));

    // Fresh cancellation scope per run would be ideal; the shared registry is
    // adequate for the single-run-at-a-time control-tower workflow.
    let cancel = ctx.cancel.clone();
    let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter { app });
    let cfg = RunConfig {
        run_id: run_id.clone(),
        project_root: PathBuf::from(project_root),
        cap,
        form_values,
    };
    let schema = schema.clone();
    let plan = Arc::new(plan);
    tokio::spawn(async move {
        supervisor::run_plan(schema, plan, cfg, emitter, cancel).await;
    });
    Ok(run_id)
}

#[tauri::command]
pub async fn cancel_task(ctx: State<'_, AppCtx>, task_id: String) -> Result<(), String> {
    ctx.cancel.request(&task_id).await;
    Ok(())
}

/// Folder reconciliation: which previewable/producible artifacts exist on disk.
#[tauri::command]
pub async fn list_present_artifacts(
    ctx: State<'_, AppCtx>,
    project_root: String,
) -> Result<Vec<String>, String> {
    let s = current_schema(&ctx).await?;
    let root = Path::new(&project_root);
    let present = s
        .artifacts
        .iter()
        .filter(|a| root.join(&a.path).exists())
        .map(|a| a.id.clone())
        .collect();
    Ok(present)
}

#[tauri::command]
pub async fn read_state(ctx: State<'_, AppCtx>) -> Result<AppState, String> {
    Ok(ctx.state.lock().await.clone())
}

#[tauri::command]
pub async fn write_state(ctx: State<'_, AppCtx>, state: AppState) -> Result<(), String> {
    let mut st = ctx.state.lock().await;
    *st = state;
    st.save(&ctx.store_path).map_err(|e| e.to_string())
}

/// Build the managed context using the OS app-config dir for the store.
pub fn make_ctx(app: &AppHandle) -> AppCtx {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    AppCtx::new(default_store_path(&config_dir))
}
