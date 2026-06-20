//! Argv assembly — the process contract (SADD §2.4).
//!
//! Given a task, the user's form values, and resolved artifact paths, produce the
//! exact argv the supervisor runs and the frontend previews. This is the Rust
//! port of the pipeline's reference assembler (`video_pipeline/schema/assemble.py`);
//! the contract test keeps the two in agreement so the GUI's resolved-command
//! preview can never diverge from a command that actually runs.

use std::collections::HashMap;

use serde_json::Value;

use crate::schema::{Schema, Task};

#[derive(Debug, thiserror::Error)]
pub enum ArgvError {
    #[error("unknown task: {0}")]
    UnknownTask(String),
    #[error("task {task}: required {what} {name} missing")]
    Missing { task: String, what: String, name: String },
}

/// Render a JSON scalar as a single argv token. Strings pass through unquoted
/// (the supervisor passes argv directly to the OS, no shell), numbers/bools
/// stringify naturally.
fn token(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        _ => true,
    }
}

pub fn resolve_argv(
    schema: &Schema,
    task_id: &str,
    form_values: &HashMap<String, Value>,
    artifact_paths: &HashMap<String, String>,
) -> Result<Vec<String>, ArgvError> {
    let task: &Task = schema
        .task(task_id)
        .ok_or_else(|| ArgvError::UnknownTask(task_id.to_string()))?;

    let mut argv: Vec<String> = vec![schema.engine.cli_entrypoint.clone()];
    argv.extend(task.subcommand.split_whitespace().map(String::from));

    // 1) positionals (params + io), interleaved by `order`
    let mut positionals: Vec<(i64, String)> = Vec::new();
    for p in &task.params {
        if p.arity == "positional" {
            let val = form_values.get(&p.key).cloned().unwrap_or(p.default.clone());
            match token(&val) {
                Some(t) => positionals.push((p.order, t)),
                None if p.required => {
                    return Err(ArgvError::Missing {
                        task: task_id.into(),
                        what: "positional".into(),
                        name: p.key.clone(),
                    })
                }
                None => {}
            }
        }
    }
    for b in &task.io {
        if b.via == "positional" {
            let path = artifact_paths.get(&b.artifact).ok_or_else(|| ArgvError::Missing {
                task: task_id.into(),
                what: "positional artifact".into(),
                name: b.artifact.clone(),
            })?;
            positionals.push((b.order, path.clone()));
        }
    }
    positionals.sort_by_key(|(o, _)| *o);
    argv.extend(positionals.into_iter().map(|(_, v)| v));

    // 2) value + switch params
    for p in &task.params {
        match p.arity.as_str() {
            "positional" => {}
            "switch" => {
                let val = form_values.get(&p.key).cloned().unwrap_or(p.default.clone());
                if truthy(&val) {
                    if let Some(flag) = &p.flag {
                        argv.push(flag.clone());
                    }
                }
            }
            "value" => {
                let val = form_values.get(&p.key).cloned().unwrap_or(p.default.clone());
                match token(&val) {
                    Some(t) => {
                        if let Some(flag) = &p.flag {
                            argv.push(flag.clone());
                            argv.push(t);
                        }
                    }
                    None if p.required => {
                        return Err(ArgvError::Missing {
                            task: task_id.into(),
                            what: "param".into(),
                            name: p.key.clone(),
                        })
                    }
                    None => {}
                }
            }
            _ => {}
        }
    }

    // 3) io flag bindings (inputs + outputs)
    for b in &task.io {
        if b.via == "flag" {
            let path = artifact_paths.get(&b.artifact).ok_or_else(|| ArgvError::Missing {
                task: task_id.into(),
                what: "artifact".into(),
                name: b.artifact.clone(),
            })?;
            if let Some(flag) = &b.flag {
                argv.push(flag.clone());
                argv.push(path.clone());
            }
        }
    }

    Ok(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/sample-schema.json");

    fn sch() -> Schema {
        Schema::from_str(FIXTURE, true).unwrap()
    }

    fn vals(pairs: &[(&str, Value)]) -> HashMap<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }
    fn paths(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn reframe_is_runnable() {
        let argv = resolve_argv(
            &sch(),
            "reframe",
            &vals(&[("mode", Value::from("dynamic"))]),
            &paths(&[("base", "work/base.mp4")]),
        )
        .unwrap();
        assert_eq!(argv[0], "video-pipeline");
        assert_eq!(argv[1], "reframe");
        assert!(argv.contains(&"work/base.mp4".to_string()));
        let oi = argv.iter().position(|x| x == "-o").unwrap();
        assert_eq!(argv[oi + 1], "work/base.mp4");
        let mi = argv.iter().position(|x| x == "--mode").unwrap();
        assert_eq!(argv[mi + 1], "dynamic");
    }

    #[test]
    fn switch_only_when_true() {
        let on = resolve_argv(&sch(), "reframe", &vals(&[("dry_run", Value::Bool(true))]),
            &paths(&[("base", "b.mp4")])).unwrap();
        let off = resolve_argv(&sch(), "reframe", &vals(&[("dry_run", Value::Bool(false))]),
            &paths(&[("base", "b.mp4")])).unwrap();
        assert!(on.contains(&"--dry-run".to_string()));
        assert!(!off.contains(&"--dry-run".to_string()));
    }

    #[test]
    fn caption_render_orders_positional_and_wires_flags() {
        let argv = resolve_argv(
            &sch(),
            "caption.render",
            &vals(&[("identity", Value::from("dyson-hope")), ("karaoke", Value::Bool(true))]),
            &paths(&[
                ("caption.def", "work/captions.yml"),
                ("caption", "layers/captions.mov"),
                ("safezone.def", "work/safezone.json"),
            ]),
        )
        .unwrap();
        assert_eq!(argv[2], "work/captions.yml");
        let oi = argv.iter().position(|x| x == "-o").unwrap();
        assert_eq!(argv[oi + 1], "layers/captions.mov");
        let si = argv.iter().position(|x| x == "--safezone").unwrap();
        assert_eq!(argv[si + 1], "work/safezone.json");
        assert!(argv.contains(&"--karaoke".to_string()));
    }
}
