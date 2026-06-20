//! State & file store (SADD §8).
//!
//! A lightweight JSON-backed kv store: pipeline/schema paths, the project set,
//! the active project, and the per-project session (last form values keyed
//! `task.param`, last preview layer, theme). Theme is user-switchable and
//! ignores OS preference by explicit requirement.
//!
//! Persistence is a single JSON file under the app config dir. The frontend only
//! ever sees `AppState`; folder reconciliation (which artifacts exist on disk)
//! lives in the supervisor.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// Session fields serialize camelCase (formValues / previewLayer) to match the
// frontend's SessionState. read_state/write_state round-trip raw serde, so the
// casing must agree with the TypeScript contract.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Last form values, keyed "task_id.param_key".
    #[serde(default)]
    pub form_values: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub preview_layer: Option<String>,
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    "dark".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppState {
    #[serde(default)]
    pub pipeline_path: Option<String>,
    #[serde(default)]
    pub schema_path: Option<String>,
    /// project name -> root path
    #[serde(default)]
    pub projects: HashMap<String, String>,
    #[serde(default)]
    pub active_project: Option<String>,
    /// The current session (form values, preview layer, theme). One session for
    /// now — matches the frontend; a per-project map can return with a project
    /// switcher.
    #[serde(default)]
    pub session: Session,
}

impl AppState {
    pub fn load(path: &Path) -> AppState {
        // Deny-by-default does not apply to *state* — a missing/garbled store is
        // recoverable, so fall back to defaults rather than failing the app.
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => AppState::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self).expect("AppState serializes");
        // write-rename for crash safety
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)
    }
}

/// Default store location under the OS app-config dir.
pub fn default_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("video-pipeline-gui").join("state.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("vpg-state-{}", std::process::id()));
        let path = dir.join("state.json");
        let mut s = AppState::default();
        s.projects.insert("demo".into(), "/tmp/demo".into());
        s.active_project = Some("demo".into());
        s.session.theme = "light".into();
        s.session
            .form_values
            .insert("reframe.mode".into(), serde_json::json!("dynamic"));
        s.save(&path).unwrap();

        let back = AppState::load(&path);
        assert_eq!(back.active_project.as_deref(), Some("demo"));
        assert_eq!(back.session.theme, "light");
        assert_eq!(
            back.session.form_values["reframe.mode"],
            serde_json::json!("dynamic")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_store_falls_back_to_default() {
        let back = AppState::load(Path::new("/nonexistent/vpg/state.json"));
        assert!(back.projects.is_empty());
    }
}
