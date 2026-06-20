//! Dependency scheduler — the hard core (SADD §4).
//!
//! Two failure modes are kept rigorously distinct:
//!   * **Skip** (not in workflow) — a *compile-time* graph transform: the node is
//!     dropped and consumers rebind to the nearest enabled producer of the channel.
//!   * **Fail** (in workflow, errored at runtime) — a *runtime* cascade: every node
//!     reverse-reachable from the break becomes `Blocked`; independent branches run on.
//!
//! Channel binding (SADD §3.2): a consumer of channel `c` binds to the **latest
//! enabled writer** of `c` declared before it (schema declaration order is the
//! canonical pipeline order). Disabling a writer rewires with no special-casing.
//!
//! This module is pure (no I/O, no async). The process supervisor consumes its
//! `Plan`. It mirrors the Python reference assembler in the pipeline repo; the
//! contract test keeps the two honest.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::schema::Schema;

/// Why a task is absent from the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum SkipReason {
    /// The user disabled the step/task in the form.
    Disabled,
}

/// Lifecycle of a task within a run (SADD §4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Blocked,
    Skipped,
}

/// A resolved consume: which task (if any) supplies the channel this task reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Binding {
    pub channel: String,
    /// The producing task id the consumer binds to (latest enabled writer).
    pub producer: String,
}

/// The computed, glass-box plan shown before anything runs (SADD §4.5).
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    /// Execution levels: tasks within a level have no inter-dependency and may
    /// run in parallel; levels run in series.
    pub levels: Vec<Vec<String>>,
    /// Disabled tasks and why they're absent.
    pub skipped: BTreeMap<String, SkipReason>,
    /// Per-task resolved input bindings (the rewiring made explicit).
    pub bindings: BTreeMap<String, Vec<Binding>>,
    /// Forward edges producer -> consumers (used for the cascade computation).
    pub edges: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PlanError {
    #[error("task {task} consumes channel {channel} but no enabled task produces it")]
    NoProducer { task: String, channel: String },
    #[error("the task graph has a cycle involving: {0}")]
    Cycle(String),
    #[error("unknown task id: {0}")]
    UnknownTask(String),
}

impl Plan {
    /// All task ids that will actually run, flattened in level order.
    pub fn scheduled(&self) -> Vec<String> {
        self.levels.iter().flatten().cloned().collect()
    }

    /// Split a level into execution waves bounded by the concurrency cap. The cap
    /// governs *task* concurrency, not core usage (SADD §4.4); it never changes the
    /// levels, only how many of a level's tasks are in flight at once.
    pub fn waves(&self, level_index: usize, cap: usize) -> Vec<Vec<String>> {
        let cap = cap.max(1);
        self.levels
            .get(level_index)
            .map(|lvl| lvl.chunks(cap).map(|c| c.to_vec()).collect())
            .unwrap_or_default()
    }

    /// Runtime cascade: given the set of failed tasks, return every task that is
    /// reverse-reachable downstream and therefore Blocked. Independent branches
    /// are untouched.
    pub fn cascade_blocked(&self, failed: &BTreeSet<String>) -> BTreeSet<String> {
        let mut blocked: BTreeSet<String> = BTreeSet::new();
        let mut queue: VecDeque<String> = failed.iter().cloned().collect();
        while let Some(node) = queue.pop_front() {
            if let Some(children) = self.edges.get(&node) {
                for c in children {
                    if !failed.contains(c) && blocked.insert(c.clone()) {
                        queue.push_back(c.clone());
                    }
                }
            }
        }
        blocked
    }
}

/// Build the execution plan from the schema and the set of enabled task ids.
///
/// `enabled` is exactly the tasks the user switched on in the form. Everything
/// else is reported as `Skipped` and removed from the graph (consumers rebind).
pub fn build_plan(schema: &Schema, enabled: &HashSet<String>) -> Result<Plan, PlanError> {
    // Declaration order index = canonical pipeline order.
    let order: HashMap<&str, usize> = schema
        .tasks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), i))
        .collect();

    for id in enabled {
        if !order.contains_key(id.as_str()) {
            return Err(PlanError::UnknownTask(id.clone()));
        }
    }

    // Resolve bindings + edges over the *enabled* subgraph.
    let mut bindings: BTreeMap<String, Vec<Binding>> = BTreeMap::new();
    let mut edges: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut indeg: HashMap<String, usize> = HashMap::new();
    for id in enabled {
        indeg.entry(id.clone()).or_insert(0);
        edges.entry(id.clone()).or_default();
    }

    for task in &schema.tasks {
        if !enabled.contains(&task.id) {
            continue;
        }
        let t_idx = order[task.id.as_str()];
        let mut my_bindings: Vec<Binding> = Vec::new();
        for channel in &task.consumes {
            // latest enabled writer of `channel` strictly before this task
            let producer = schema
                .tasks
                .iter()
                .filter(|w| {
                    enabled.contains(&w.id)
                        && w.produces.contains(channel)
                        && order[w.id.as_str()] < t_idx
                })
                .max_by_key(|w| order[w.id.as_str()])
                .map(|w| w.id.clone());

            match producer {
                Some(p) => {
                    edges.get_mut(&p).expect("producer enabled").push(task.id.clone());
                    *indeg.get_mut(&task.id).unwrap() += 1;
                    my_bindings.push(Binding {
                        channel: channel.clone(),
                        producer: p,
                    });
                }
                None => {
                    return Err(PlanError::NoProducer {
                        task: task.id.clone(),
                        channel: channel.clone(),
                    });
                }
            }
        }
        bindings.insert(task.id.clone(), my_bindings);
    }

    let levels = topo_levels(enabled, &edges, &mut indeg)?;

    let skipped: BTreeMap<String, SkipReason> = schema
        .tasks
        .iter()
        .filter(|t| !enabled.contains(&t.id))
        .map(|t| (t.id.clone(), SkipReason::Disabled))
        .collect();

    Ok(Plan {
        levels,
        skipped,
        bindings,
        edges,
    })
}

/// Kahn's algorithm producing *levels* (antichains): all nodes whose in-degree is
/// zero form a level, are removed together, and the next antichain emerges. Nodes
/// in one level have no edge between them -> safe to run in parallel.
fn topo_levels(
    enabled: &HashSet<String>,
    edges: &BTreeMap<String, Vec<String>>,
    indeg: &mut HashMap<String, usize>,
) -> Result<Vec<Vec<String>>, PlanError> {
    let mut levels: Vec<Vec<String>> = Vec::new();
    let mut remaining: usize = enabled.len();

    // current frontier = enabled nodes with in-degree 0, sorted for determinism
    let mut frontier: Vec<String> = indeg
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(k, _)| k.clone())
        .collect();
    frontier.sort();

    let mut done: HashSet<String> = HashSet::new();

    while !frontier.is_empty() {
        levels.push(frontier.clone());
        let mut next: BTreeSet<String> = BTreeSet::new();
        for node in &frontier {
            done.insert(node.clone());
            remaining -= 1;
            if let Some(children) = edges.get(node) {
                for c in children {
                    let d = indeg.get_mut(c).expect("edge target tracked");
                    *d -= 1;
                    if *d == 0 {
                        next.insert(c.clone());
                    }
                }
            }
        }
        frontier = next.into_iter().collect();
    }

    if remaining != 0 {
        let stuck: Vec<String> = enabled
            .iter()
            .filter(|n| !done.contains(*n))
            .cloned()
            .collect();
        return Err(PlanError::Cycle(stuck.join(", ")));
    }
    Ok(levels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::Schema;

    const FIXTURE: &str = include_str!("../../tests/fixtures/sample-schema.json");

    fn schema() -> Schema {
        Schema::from_str(FIXTURE, true).expect("fixture loads")
    }

    fn enabled(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    const ALL: &[&str] = &[
        "project.init",
        "safezone.gen",
        "reframe",
        "roughcut",
        "roughcut.render",
        "caption.define",
        "caption.render",
        "safezone.qc",
    ];

    fn level_of(plan: &Plan, id: &str) -> usize {
        plan.levels
            .iter()
            .position(|lvl| lvl.iter().any(|x| x == id))
            .expect("scheduled")
    }

    #[test]
    fn roots_share_the_first_level_and_run_in_parallel() {
        let plan = build_plan(&schema(), &enabled(ALL)).unwrap();
        // project.init and safezone.gen have no consumes -> same first level.
        assert!(plan.levels[0].contains(&"project.init".to_string()));
        assert!(plan.levels[0].contains(&"safezone.gen".to_string()));
    }

    #[test]
    fn full_graph_orders_render_before_define_and_qc_last() {
        let plan = build_plan(&schema(), &enabled(ALL)).unwrap();
        assert!(level_of(&plan, "reframe") < level_of(&plan, "roughcut"));
        assert!(level_of(&plan, "roughcut.render") < level_of(&plan, "caption.define"));
        assert!(level_of(&plan, "caption.define") < level_of(&plan, "caption.render"));
        // qc consumes the caption layer -> strictly after caption.render
        assert!(level_of(&plan, "caption.render") < level_of(&plan, "safezone.qc"));
    }

    #[test]
    fn skip_rewires_base_to_the_nearest_enabled_writer() {
        // Disable reframe: roughcut must bind `base` to project.init, not reframe.
        let on = enabled(&[
            "project.init", "roughcut", "roughcut.render", "safezone.gen",
        ]);
        let plan = build_plan(&schema(), &on).unwrap();
        let rc = &plan.bindings["roughcut"];
        let base = rc.iter().find(|b| b.channel == "base").unwrap();
        assert_eq!(base.producer, "project.init");
    }

    #[test]
    fn skip_chains_collapse_to_project_init() {
        // Disable reframe AND roughcut.render: caption.define binds base to project.init.
        let on = enabled(&[
            "project.init", "safezone.gen", "roughcut", "caption.define",
        ]);
        let plan = build_plan(&schema(), &on).unwrap();
        let cd = &plan.bindings["caption.define"];
        let base = cd.iter().find(|b| b.channel == "base").unwrap();
        assert_eq!(base.producer, "project.init");
        assert_eq!(plan.skipped.get("reframe"), Some(&SkipReason::Disabled));
    }

    #[test]
    fn missing_producer_is_a_plan_time_error() {
        // safezone.gen is disabled, so safezone.def has no enabled producer.
        // build_plan resolves bindings in declaration order, so the FIRST enabled
        // consumer of safezone.def — caption.define — is the one that errors
        // (caption.render also consumes it but is processed later).
        let on = enabled(&["project.init", "caption.define", "caption.render"]);
        let err = build_plan(&schema(), &on).unwrap_err();
        assert_eq!(
            err,
            PlanError::NoProducer {
                task: "caption.define".into(),
                channel: "safezone.def".into(),
            }
        );
    }

    #[test]
    fn fail_cascades_only_to_reverse_reachable_downstream() {
        let plan = build_plan(&schema(), &enabled(ALL)).unwrap();
        let mut failed = BTreeSet::new();
        failed.insert("reframe".to_string());
        let blocked = plan.cascade_blocked(&failed);
        // everything downstream of reframe is blocked...
        for t in ["roughcut", "roughcut.render", "caption.define", "caption.render", "safezone.qc"] {
            assert!(blocked.contains(t), "{t} should be blocked");
        }
        // ...but the independent safezone.gen branch is untouched.
        assert!(!blocked.contains("safezone.gen"));
        assert!(!blocked.contains("project.init"));
    }

    #[test]
    fn concurrency_cap_chunks_a_level_into_waves() {
        let plan = build_plan(&schema(), &enabled(ALL)).unwrap();
        // first level has 2 roots; cap of 1 -> two waves, cap of 2 -> one wave.
        assert_eq!(plan.waves(0, 1).len(), 2);
        assert_eq!(plan.waves(0, 2).len(), 1);
    }

    #[test]
    fn single_step_run_is_valid() {
        // Running just project.init (no consumes) yields one level, no errors.
        let plan = build_plan(&schema(), &enabled(&["project.init"])).unwrap();
        assert_eq!(plan.scheduled(), vec!["project.init".to_string()]);
        assert_eq!(plan.skipped.len(), ALL.len() - 1);
    }
}
