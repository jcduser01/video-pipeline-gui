//! Schema gateway — the *only* component that touches the authored schema and
//! the deny-by-default boundary (SADD §2.2).
//!
//! Responsibilities:
//!   1. Read the authored YAML (or JSON) the pipeline emits.
//!   2. Validate it against the versioned meta-schema grammar (`schema/meta-schema.json`).
//!   3. Validate the deeper *referential* invariants the grammar can't express
//!      (consumes/produces resolve, io bindings reference declared channels, etc.).
//!   4. Normalize to strongly-typed structs the rest of the core uses.
//!
//! A malformed schema fails loudly here, before any form renders or task runs.

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The compiled meta-schema grammar, embedded so the validator never depends on
/// a file path at runtime. Kept byte-identical to `schema/meta-schema.json`.
pub const META_SCHEMA: &str = include_str!("../../schema/meta-schema.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engine {
    pub name: String,
    pub version: String,
    pub schema_version: String,
    pub cli_entrypoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub label: String,
    pub order: i64,
    pub optional: bool,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub help: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DependsOn {
    pub key: String,
    #[serde(default)]
    pub equals: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ui {
    pub label: String,
    #[serde(default)]
    pub control: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub depends_on: Option<DependsOn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Param {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub arity: String,
    pub control: String,
    pub ui: Ui,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub help: String,
    #[serde(default)]
    pub example: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IoBinding {
    pub artifact: String,
    pub role: String, // input | output
    pub via: String,  // positional | flag
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default)]
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub step: String,
    pub label: String,
    pub subcommand: String,
    pub optional: bool,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub produces: Vec<String>,
    #[serde(default)]
    pub io: Vec<IoBinding>,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub help: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub previewable: bool,
    #[serde(default)]
    pub z_order: Option<i64>,
    #[serde(default)]
    pub codec_hint: Option<String>,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub help: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportTarget {
    pub id: String,
    pub label: String,
    pub subcommand: String,
    pub bundle: String,
    #[serde(default)]
    pub params: Vec<Param>,
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub help: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schema {
    pub engine: Engine,
    pub steps: Vec<Step>,
    pub tasks: Vec<Task>,
    pub artifacts: Vec<Artifact>,
    pub export_targets: Vec<ExportTarget>,
}

#[derive(Debug, thiserror::Error)]
pub enum SchemaError {
    #[error("read error: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("meta-schema validation failed:\n{0}")]
    MetaSchema(String),
    #[error("referential validation failed:\n{0}")]
    Reference(String),
}

impl Schema {
    /// Load + validate + normalize from a YAML or JSON file. The single entry
    /// point; nothing downstream constructs a Schema another way.
    pub fn load(path: &Path) -> Result<Schema, SchemaError> {
        let text = std::fs::read_to_string(path)?;
        let is_json = path.extension().map(|e| e == "json").unwrap_or(false);
        Self::from_str(&text, is_json)
    }

    pub fn from_str(text: &str, is_json: bool) -> Result<Schema, SchemaError> {
        // Parse to a generic Value first so we validate the raw document against
        // the grammar before trusting the typed deserialize.
        let value: serde_json::Value = if is_json {
            serde_json::from_str(text).map_err(|e| SchemaError::Parse(e.to_string()))?
        } else {
            serde_yaml::from_str(text).map_err(|e| SchemaError::Parse(e.to_string()))?
        };

        validate_against_meta(&value)?;

        let schema: Schema =
            serde_json::from_value(value).map_err(|e| SchemaError::Parse(e.to_string()))?;
        schema.validate_references()?;
        Ok(schema)
    }

    /// Referential invariants the JSON-Schema grammar can't express (§4.1).
    pub fn validate_references(&self) -> Result<(), SchemaError> {
        let mut problems: Vec<String> = Vec::new();
        let step_ids: HashSet<&str> = self.steps.iter().map(|s| s.id.as_str()).collect();
        let art_ids: HashSet<&str> = self.artifacts.iter().map(|a| a.id.as_str()).collect();
        let produced: HashSet<&str> = self
            .tasks
            .iter()
            .flat_map(|t| t.produces.iter().map(String::as_str))
            .collect();

        for t in &self.tasks {
            if !step_ids.contains(t.step.as_str()) {
                problems.push(format!("task {} -> unknown step {}", t.id, t.step));
            }
            for c in &t.consumes {
                if !art_ids.contains(c.as_str()) {
                    problems.push(format!("task {} consumes unknown artifact {}", t.id, c));
                }
                if !produced.contains(c.as_str()) {
                    problems.push(format!("task {} consumes orphan channel {}", t.id, c));
                }
            }
            for p in &t.produces {
                if !art_ids.contains(p.as_str()) {
                    problems.push(format!("task {} produces unknown artifact {}", t.id, p));
                }
            }
            for b in &t.io {
                match b.role.as_str() {
                    "input" if !t.consumes.contains(&b.artifact) => problems
                        .push(format!("task {} io input {} not in consumes", t.id, b.artifact)),
                    "output" if !t.produces.contains(&b.artifact) => problems
                        .push(format!("task {} io output {} not in produces", t.id, b.artifact)),
                    _ => {}
                }
            }
            let keys: HashSet<&str> = t.params.iter().map(|p| p.key.as_str()).collect();
            for p in &t.params {
                if let Some(dep) = &p.ui.depends_on {
                    if !keys.contains(dep.key.as_str()) {
                        problems.push(format!(
                            "task {} param {} depends_on non-sibling {}",
                            t.id, p.key, dep.key
                        ));
                    }
                }
            }
        }

        if problems.is_empty() {
            Ok(())
        } else {
            Err(SchemaError::Reference(problems.join("\n")))
        }
    }

    pub fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }

    pub fn artifact(&self, id: &str) -> Option<&Artifact> {
        self.artifacts.iter().find(|a| a.id == id)
    }
}

/// Validate a raw document against the embedded meta-schema grammar.
fn validate_against_meta(value: &serde_json::Value) -> Result<(), SchemaError> {
    let meta: serde_json::Value =
        serde_json::from_str(META_SCHEMA).expect("embedded meta-schema is valid JSON");
    let compiled = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .compile(&meta)
        .expect("embedded meta-schema compiles");
    if let Err(errors) = compiled.validate(value) {
        let joined = errors
            .map(|e| format!("  {} (at {})", e, e.instance_path))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(SchemaError::MetaSchema(joined));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/sample-schema.json");

    #[test]
    fn loads_and_validates_the_fixture() {
        let s = Schema::from_str(FIXTURE, true).expect("fixture should load");
        assert_eq!(s.engine.name, "video-pipeline");
        assert!(s.task("caption.render").is_some());
        s.validate_references().expect("references should resolve");
    }

    #[test]
    fn rejects_an_orphan_consume() {
        let mut v: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        // point a consume at a channel nobody produces
        v["tasks"][2]["consumes"] = serde_json::json!(["ghost-channel"]);
        // grammar passes (it's a well-formed id); reference check must catch it
        let err = Schema::from_str(&v.to_string(), true).unwrap_err();
        match err {
            SchemaError::Reference(msg) => assert!(msg.contains("ghost-channel")),
            other => panic!("expected reference error, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_grammar_violation() {
        let mut v: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        v["tasks"][0]["params"][0]["control"] = serde_json::json!("not-a-control");
        let err = Schema::from_str(&v.to_string(), true).unwrap_err();
        assert!(matches!(err, SchemaError::MetaSchema(_)));
    }
}
