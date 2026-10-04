use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::{Arc, Mutex};

use crate::{
    object, required_string,
    resources::{validate_ref, ResourceRef},
    WorkspaceHost,
};

const CORE: &str = "core";
const CHAT: &str = "chat";
const TASKS: &str = "tasks";
const STATE: &str = "state";
const ROLES: &str = "roles";
const MAX_STATES: usize = 64;
const MAX_TRANSITIONS: usize = 256;
const MAX_PREREQUISITES: usize = 32;
const MAX_CAPABILITIES: usize = 32;
const MAX_DECLARED_ROLES: usize = 16;
const MAX_DECLARED_SKILLS: usize = 32;
const HANDOFF_EXAMPLE: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/assets/handoff.json"));

type SectionHook<T> = fn(&WorkspaceHost, &str) -> Result<Option<T>, String>;

#[derive(Clone, Copy)]
struct Manifest {
    id: &'static str,
    version: u32,
    name: &'static str,
    description: &'static str,
    required: bool,
    /// Hard dependencies: required plugins only (Core, Chat). See docs/plugins.md.
    dependencies: &'static [&'static str],
    /// Soft links to optional plugins this one can use when they are attached. Reached only
    /// through public host calls; a detached integration is reported, never an error.
    integrations: &'static [&'static str],
    resource_kinds: &'static [&'static str],
    operations: &'static [&'static str],
    intro_section: Option<SectionHook<String>>,
    snapshot_section: Option<SectionHook<Value>>,
}

pub(crate) struct PluginSection<T> {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) result: Result<Option<T>, String>,
}

const MANIFESTS: &[Manifest] = &[
    Manifest {
        id: CORE,
        version: 1,
        name: "Core",
        description: "Workspace discovery, resources, and owned artifacts.",
        required: true,
        dependencies: &[],
        integrations: &[],
        resource_kinds: &["file", "url"],
        operations: &[
            "workspace_info",
            "workspace_intro",
            "workspace_status",
            "resource_get",
            "resource_links",
            "resource_link",
            "artifact_roots",
            "artifact_list",
            "artifact_history",
            "artifact_upload",
            "artifact_delete",
            "artifact_commit",
        ],
        intro_section: None,
        snapshot_section: None,
    },
    Manifest {
        id: CHAT,
        version: 1,
        name: "Chat",
        description: "Workspace participants and messages.",
        required: true,
        dependencies: &[CORE],
        integrations: &[],
        resource_kinds: &["channel", "direct", "broadcast", "message", "agent"],
        operations: &[
            "mail_register",
            "mail_resume",
            "mail_leave",
            "mail_participants",
            "mail_channel_create",
            "mail_channels",
            "mail_send",
            "mail_inbox",
            "mail_history",
            "mail_acknowledge",
            "mail_search",
            "workspace_alerts",
        ],
        intro_section: None,
        snapshot_section: None,
    },
    Manifest {
        id: TASKS,
        version: 2,
        name: "Tasks",
        description: "Bounded Beads task access.",
        required: false,
        dependencies: &[CORE, CHAT],
        integrations: &[],
        resource_kinds: &["task"],
        operations: &[
            "tasks_list",
            "task_show",
            "task_create",
            "task_update",
            "task_claim",
            "task_release",
            "task_close",
            "task_dependencies",
        ],
        intro_section: None,
        snapshot_section: None,
    },
    Manifest {
        id: STATE,
        version: 2,
        name: "State",
        description: "Declarative workspace state markers.",
        required: false,
        dependencies: &[CORE, CHAT],
        // A task subject is read through `task_show`; subject_task_closed needs Tasks.
        integrations: &[TASKS],
        resource_kinds: &["state"],
        operations: &[
            "state_define",
            "state_definitions",
            "state_create",
            "state_list",
            "state_get",
            "state_opportunities",
            "state_advance",
        ],
        intro_section: Some(state_intro_section),
        snapshot_section: None,
    },
    Manifest {
        id: ROLES,
        version: 1,
        name: "Roles",
        description: "Owner-defined roles and agents' self-declared roles and skills (advisory).",
        required: false,
        dependencies: &[CORE, CHAT],
        integrations: &[],
        resource_kinds: &[],
        operations: &["roles_list", "role_declare"],
        intro_section: Some(roles_intro_section),
        snapshot_section: Some(roles_snapshot_section),
    },
];

fn manifest(id: &str) -> Result<&'static Manifest, String> {
    MANIFESTS
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("unknown bundled plugin {id:?}"))
}

fn compose_plugin_sections<T>(
    manifests: &[Manifest],
    mut attached: impl FnMut(&Manifest) -> Result<bool, String>,
    mut section: impl FnMut(&Manifest) -> Option<SectionHook<T>>,
    mut run: impl FnMut(&Manifest, SectionHook<T>) -> Result<Option<T>, String>,
) -> Vec<PluginSection<T>> {
    manifests
        .iter()
        .filter_map(|item| {
            let hook = section(item)?;
            Some(match attached(item) {
                Ok(true) => PluginSection {
                    id: item.id,
                    name: item.name,
                    result: run(item, hook),
                },
                Err(error) => PluginSection {
                    id: item.id,
                    name: item.name,
                    result: Err(error),
                },
                Ok(false) => return None,
            })
        })
        .collect()
}

fn state_intro_section(host: &WorkspaceHost, workspace_id: &str) -> Result<Option<String>, String> {
    let mut db = host.plugin_db(workspace_id)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let mut definitions = HashMap::new();
    let mut definition_statement = tx
        .prepare("SELECT id, version, body FROM state_definition")
        .map_err(|error| error.to_string())?;
    let definition_rows = definition_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for definition in definition_rows {
        let (id, version, body) = definition.map_err(|error| error.to_string())?;
        definitions.insert(
            (id, version),
            serde_json::from_str::<Value>(&body).map_err(|error| error.to_string())?,
        );
    }
    drop(definition_statement);

    let mut marker_statement = tx
        .prepare("SELECT body FROM state_marker")
        .map_err(|error| error.to_string())?;
    let marker_rows = marker_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut count = 0;
    for marker in marker_rows {
        let marker: Value = serde_json::from_str(&marker.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        let definition_id = marker["definition_id"]
            .as_str()
            .ok_or_else(|| "invalid stored state marker definition_id".to_owned())?;
        let definition_version = marker["definition_version"]
            .as_i64()
            .ok_or_else(|| "invalid stored state marker definition_version".to_owned())?;
        let definition = definitions
            .get(&(definition_id.to_owned(), definition_version))
            .ok_or_else(|| "state marker definition is missing".to_owned())?;
        if definition["transitions"]
            .as_array()
            .is_some_and(|transitions| {
                transitions
                    .iter()
                    .any(|transition| transition["from"] == marker["state"])
            })
        {
            count += 1;
        }
    }
    drop(marker_statement);
    tx.commit().map_err(|error| error.to_string())?;

    Ok(Some(format!(
        "Markers in nonterminal states: {count}. Call `state_opportunities` with a `capability` to find matching work."
    )))
}

fn roles_intro_section(host: &WorkspaceHost, workspace_id: &str) -> Result<Option<String>, String> {
    let listing = host.roles_list(json!({"workspace_id":workspace_id}))?;
    let roles = listing["roles"]
        .as_array()
        .ok_or_else(|| "invalid roles listing".to_owned())?;
    if roles.is_empty() {
        return Ok(Some(
            "No roles are defined yet. Declare your skills with roles/role_declare; the owner may define roles."
                .to_owned(),
        ));
    }
    let mut open = Vec::new();
    let mut filled = Vec::new();
    for role in roles {
        let id = role["id"]
            .as_str()
            .ok_or_else(|| "invalid stored role id".to_owned())?;
        let label = role["label"]
            .as_str()
            .ok_or_else(|| "invalid stored role label".to_owned())?;
        let count = role["filled"]
            .as_i64()
            .ok_or_else(|| "invalid stored role filled count".to_owned())?;
        let needed = role["needed"]
            .as_i64()
            .ok_or_else(|| "invalid stored role needed count".to_owned())?;
        if role["open"] == true {
            open.push(format!("{label} (`{id}`, {count} of {needed})"));
        }
        if count > 0 {
            filled.push(format!("{label} (`{id}`)"));
        }
    }
    let mut lines = vec!["Roles are advisory and self-declared.".to_owned()];
    lines.push(if open.is_empty() {
        "Open: none".to_owned()
    } else {
        format!("Open: {}", open.join(", "))
    });
    if !filled.is_empty() {
        lines.push(format!("Filled: {}", filled.join(", ")));
    }
    lines.push("Declare what you can do with `plugin_call` → roles/role_declare; read role instructions with roles/roles_list.".to_owned());
    Ok(Some(lines.join("\n")))
}

fn roles_snapshot_section(
    host: &WorkspaceHost,
    workspace_id: &str,
) -> Result<Option<Value>, String> {
    let listing = host.roles_list(json!({"workspace_id":workspace_id}))?;
    Ok(Some(json!({
        "roles": listing["roles"],
        "declarations": listing["declarations"]
    })))
}

impl WorkspaceHost {
    pub(crate) fn intro_plugin_sections(&self, workspace_id: &str) -> Vec<PluginSection<String>> {
        compose_plugin_sections(
            MANIFESTS,
            |item| self.attached(workspace_id, item.id),
            |item| item.intro_section,
            |_, hook| hook(self, workspace_id),
        )
    }

    pub(crate) fn snapshot_plugin_sections(&self, workspace_id: &str) -> Vec<PluginSection<Value>> {
        compose_plugin_sections(
            MANIFESTS,
            |item| self.attached(workspace_id, item.id),
            |item| item.snapshot_section,
            |_, hook| hook(self, workspace_id),
        )
    }

    fn plugin_db(&self, workspace_id: &str) -> Result<Connection, String> {
        self.active_runtime(workspace_id)?;
        let workspace = self.workspace_config(workspace_id)?;
        let directory = workspace.root.join(".orchard");
        if let Ok(metadata) = fs::symlink_metadata(&directory) {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("workspace plugin directory must not be a symlink".to_owned());
            }
        }
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join("plugins.sqlite");
        let wal = directory.join("plugins.sqlite-wal");
        let shm = directory.join("plugins.sqlite-shm");
        let journal = directory.join("plugins.sqlite-journal");
        for candidate in [&path, &wal, &shm, &journal] {
            match fs::symlink_metadata(candidate) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(
                        "workspace plugin database and journal files must not be symlinks"
                            .to_owned(),
                    )
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let connection = Connection::open(&path)
            .map_err(|e| format!("plugin database is corrupt or unavailable: {e}"))?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("plugin database is corrupt or unavailable: {e}"))?;
        if version != 0 && version != 1 {
            return Err(format!(
                "unsupported workspace plugin database version {version}"
            ));
        }
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS plugin_attachment (plugin_id TEXT PRIMARY KEY, attached INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS plugin_receipt (plugin_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, PRIMARY KEY(plugin_id, request_id));
            CREATE TABLE IF NOT EXISTS state_definition (id TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(id, version));
            CREATE TABLE IF NOT EXISTS state_marker (id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS state_history (marker_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(marker_id, revision));
            CREATE TABLE IF NOT EXISTS role (id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS role_declaration (participant_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(participant_id, revision));")
            .map_err(|e| format!("could not initialize plugin database: {e}"))?;
        if version == 0 {
            connection
                .execute_batch("PRAGMA user_version=1")
                .map_err(|e| e.to_string())?;
        }
        // v0.2 compatibility default: legacy and new workspaces retain Tasks.
        connection
            .execute(
                "INSERT OR IGNORE INTO plugin_attachment(plugin_id, attached) VALUES(?1, 1)",
                [TASKS],
            )
            .map_err(|e| e.to_string())?;
        connection
            .execute(
                "INSERT OR IGNORE INTO plugin_attachment(plugin_id, attached) VALUES(?1, 1)",
                [ROLES],
            )
            .map_err(|e| e.to_string())?;
        Ok(connection)
    }

    fn attached(&self, workspace_id: &str, plugin_id: &str) -> Result<bool, String> {
        let item = manifest(plugin_id)?;
        if item.required {
            return Ok(true);
        }
        let db = self.plugin_db(workspace_id)?;
        db.query_row(
            "SELECT attached FROM plugin_attachment WHERE plugin_id=?1",
            [plugin_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
        .map(|value| value.unwrap_or(0) != 0)
    }

    fn plugin_view(&self, workspace_id: &str, item: &Manifest) -> Result<Value, String> {
        let attached = self.attached(workspace_id, item.id)?;
        let (available, health) = if item.id == TASKS && self.inner.beads.availability().is_err() {
            (false, "Beads backend unavailable")
        } else {
            (true, "ok")
        };
        Ok(
            json!({"id":item.id,"version":item.version,"name":item.name,"description":item.description,"required":item.required,"attached":attached,"available":available,"health":health,"dependencies":item.dependencies,"integrations":item.integrations,"resource_kinds":item.resource_kinds,"operations":item.operations}),
        )
    }

    pub(crate) fn plugin_list(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        let workspace_id = required_string(&args, "workspace_id")?;
        self.active_runtime(&workspace_id)?;
        Ok(
            json!({"plugins":MANIFESTS.iter().map(|item| self.plugin_view(&workspace_id, item)).collect::<Result<Vec<_>,_>>()?}),
        )
    }
    pub(crate) fn plugin_inspect(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let item = manifest(&required_string(&args, "plugin_id")?)?;
        let mut view = self.plugin_view(&workspace_id, item)?;
        view.as_object_mut().unwrap().insert("operations".to_owned(), Value::Array(item.operations.iter().map(|name| json!({"name":name,"description":mail_definition(name).map(|tool| tool.description).unwrap_or_else(|| operation_description(name).to_owned()),"input_schema":operation_schema(name)})).collect()));
        if item.id == STATE {
            let handoff: Value = serde_json::from_str(HANDOFF_EXAMPLE)
                .map_err(|error| format!("bundled handoff example is invalid JSON: {error}"))?;
            view.as_object_mut().unwrap().insert(
                "examples".to_owned(),
                json!([{"name":"handoff","definition":handoff}]),
            );
        }
        Ok(json!({"plugin":view}))
    }
    pub(crate) fn plugin_attach(&self, args: Value) -> Result<Value, String> {
        self.set_attachment(args, true)
    }
    pub(crate) fn plugin_detach(&self, args: Value) -> Result<Value, String> {
        self.set_attachment(args, false)
    }
    fn set_attachment(&self, args: Value, attached: bool) -> Result<Value, String> {
        let args = object(args)?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let plugin_id = required_string(&args, "plugin_id")?;
        let request_id = bounded(&required_string(&args, "request_id")?, 200, "request_id")?;
        let item = manifest(&plugin_id)?;
        if item.required {
            if !attached {
                return Err(format!("required plugin {plugin_id:?} cannot be detached"));
            }
            return Ok(json!({"plugin":self.plugin_view(&workspace_id,item)?}));
        }
        let fingerprint = format!("{}:{}", attached, plugin_id);
        let mut db = self.plugin_db(&workspace_id)?;
        let transaction = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some((old, outcome)) = transaction.query_row("SELECT fingerprint,outcome FROM plugin_receipt WHERE plugin_id=?1 AND request_id=?2", params![plugin_id, request_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())? {
            if old != fingerprint { return Err("request_id was already used for a different plugin attachment request".to_owned()); }
            transaction.commit().map_err(|e|e.to_string())?;
            let mut plugin = self.plugin_view(&workspace_id,item)?; plugin.as_object_mut().unwrap().insert("attached".into(), Value::Bool(outcome == "attached"));
            return Ok(json!({"plugin":plugin,"idempotent_replay":true}));
        }
        transaction.execute("INSERT INTO plugin_attachment(plugin_id,attached) VALUES(?1,?2) ON CONFLICT(plugin_id) DO UPDATE SET attached=excluded.attached,updated_at=CURRENT_TIMESTAMP",params![plugin_id,attached as i64]).map_err(|e|e.to_string())?;
        transaction.execute("INSERT INTO plugin_receipt(plugin_id,request_id,fingerprint,outcome) VALUES(?1,?2,?3,?4)",params![plugin_id,request_id,fingerprint,if attached {"attached"} else {"detached"}]).map_err(|e|e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(json!({"plugin":self.plugin_view(&workspace_id,item)?}))
    }

    pub(crate) fn ensure_plugin_write(&self, args: &Value, plugin_id: &str) -> Result<(), String> {
        let workspace_id = required_string(&object(args.clone())?, "workspace_id")?;
        if !self.attached(&workspace_id, plugin_id)? {
            return Err(format!(
                "plugin {plugin_id:?} is detached; attach it before writing"
            ));
        }
        Ok(())
    }
    pub(crate) fn plugin_call(&self, args: Value) -> Result<Value, String> {
        let mut args = object(args)?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let plugin_id = required_string(&args, "plugin_id")?;
        let operation = required_string(&args, "operation")?;
        let manifest = manifest(&plugin_id)?;
        if !manifest.operations.contains(&operation.as_str()) {
            return Err(format!(
                "operation {operation:?} is not declared by plugin {plugin_id:?}"
            ));
        }
        let mut inner = args
            .remove("arguments")
            .ok_or_else(|| "arguments is required".to_owned())?
            .as_object()
            .cloned()
            .ok_or_else(|| "arguments must be an object".to_owned())?;
        if inner.contains_key("workspace_id") {
            return Err("plugin_call arguments may not supply workspace_id".to_owned());
        }
        if operation == "plugin_call" {
            return Err("recursive plugin gateway calls are not allowed".to_owned());
        }
        inner.insert("workspace_id".to_owned(), Value::String(workspace_id));
        self.call(&operation, Value::Object(inner))
    }

    fn participant(&self, workspace_id: &str, participant_id: &str) -> Result<(), String> {
        let participants =
            self.mail_call("mail_participants", json!({"workspace_id":workspace_id}))?;
        if participant_id == "orchard" {
            return Err("the system participant cannot mutate plugin state".to_owned());
        }
        if participants["participants"]
            .as_array()
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|p| p["id"] == participant_id && p["registered"] == true)
            })
        {
            Ok(())
        } else {
            Err(format!("unknown registered participant {participant_id:?}"))
        }
    }

    pub(crate) fn roles_list(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        reject_unknown(&args, &["workspace_id"])?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let participants =
            self.mail_call("mail_participants", json!({"workspace_id":workspace_id}))?;
        let registered = participants["participants"]
            .as_array()
            .ok_or_else(|| "invalid mail participants response".to_owned())?
            .iter()
            .filter_map(|participant| {
                let id = participant["id"].as_str()?;
                (id != "orchard" && participant["registered"] == true).then(|| id.to_owned())
            })
            .collect::<HashSet<_>>();

        let db = self.plugin_db(&workspace_id)?;
        let mut role_statement = db
            .prepare("SELECT body FROM role ORDER BY id")
            .map_err(|error| error.to_string())?;
        let role_rows = role_statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let stored_roles = role_rows
            .map(|row| {
                serde_json::from_str::<Value>(&row.map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        drop(role_statement);

        let mut declaration_statement = db
            .prepare(
                "SELECT participant_id, body FROM role_declaration
                 WHERE revision = (
                     SELECT MAX(latest.revision) FROM role_declaration AS latest
                     WHERE latest.participant_id = role_declaration.participant_id
                 )
                 ORDER BY participant_id",
            )
            .map_err(|error| error.to_string())?;
        let declaration_rows = declaration_statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut declarations = Vec::new();
        for row in declaration_rows {
            let (participant_id, body) = row.map_err(|error| error.to_string())?;
            if !registered.contains(&participant_id) {
                continue;
            }
            let declaration: Value =
                serde_json::from_str(&body).map_err(|error| error.to_string())?;
            if declaration["participant_id"] != participant_id {
                return Err("invalid stored role declaration participant_id".to_owned());
            }
            declarations.push(declaration);
        }

        let mut roles = Vec::new();
        for mut role in stored_roles {
            let id = role["id"]
                .as_str()
                .ok_or_else(|| "invalid stored role id".to_owned())?;
            let needed = role["needed"]
                .as_i64()
                .filter(|needed| (0..=20).contains(needed))
                .ok_or_else(|| "invalid stored role needed count".to_owned())?;
            let declared_by = declarations
                .iter()
                .filter_map(|declaration| {
                    declaration["roles"]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|item| item == id))
                        .then(|| declaration["participant_id"].as_str().map(str::to_owned))
                        .flatten()
                })
                .collect::<Vec<_>>();
            let filled = declared_by.len();
            let fields = role
                .as_object_mut()
                .ok_or_else(|| "invalid stored role".to_owned())?;
            fields.insert("filled".to_owned(), json!(filled));
            fields.insert(
                "open".to_owned(),
                Value::Bool(needed > 0 && (filled as i64) < needed),
            );
            fields.insert("declared_by".to_owned(), json!(declared_by));
            roles.push(role);
        }
        Ok(json!({"roles":roles,"declarations":declarations,"advisory":true}))
    }

    pub(crate) fn role_declare(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        reject_unknown(
            &args,
            &[
                "workspace_id",
                "participant_id",
                "request_id",
                "roles",
                "skills",
                "model",
                "tier",
            ],
        )?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let participant_id = bounded(
            &required_string(&args, "participant_id")?,
            128,
            "participant_id",
        )?;
        let request_id = bounded(&required_string(&args, "request_id")?, 200, "request_id")?;
        let roles = parse_declared_roles(
            args.get("roles")
                .ok_or_else(|| "roles is required".to_owned())?,
        )?;
        let skills = parse_declared_skills(
            args.get("skills")
                .ok_or_else(|| "skills is required".to_owned())?,
        )?;
        let model = optional_role_text(&args, "model", 120)?;
        let tier = optional_role_text(&args, "tier", 64)?;
        let fingerprint = serde_json::to_string(&json!({
            "participant_id":participant_id,
            "roles":roles,
            "skills":skills,
            "model":model,
            "tier":tier
        }))
        .unwrap();
        let participant_for_validation = participant_id.clone();
        self.state_mutate(
            &workspace_id,
            ROLES,
            &request_id,
            &fingerprint,
            || self.participant(&workspace_id, &participant_for_validation),
            |transaction| {
                let revision = transaction
                    .query_row(
                        "SELECT MAX(revision) FROM role_declaration WHERE participant_id=?1",
                        [&participant_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                    .map_err(|error| error.to_string())?
                    .unwrap_or(0)
                    + 1;
                let mut declaration = json!({
                    "participant_id":participant_id,
                    "roles":roles,
                    "skills":skills,
                    "revision":revision,
                    "declared_at":now_timestamp()
                });
                if let Some(model) = &model {
                    declaration
                        .as_object_mut()
                        .unwrap()
                        .insert("model".to_owned(), json!(model));
                }
                if let Some(tier) = &tier {
                    declaration
                        .as_object_mut()
                        .unwrap()
                        .insert("tier".to_owned(), json!(tier));
                }
                transaction
                    .execute(
                        "INSERT INTO role_declaration(participant_id, revision, body) VALUES(?1, ?2, ?3)",
                        params![participant_id, revision, serde_json::to_string(&declaration).unwrap()],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(json!({"declaration":declaration}))
            },
        )
    }

    pub(crate) fn role_put(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        reject_unknown(&args, &["workspace_id", "request_id", "role"])?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let request_id = bounded(&required_string(&args, "request_id")?, 200, "request_id")?;
        let role = parse_role(
            args.get("role")
                .ok_or_else(|| "role is required".to_owned())?,
        )?;
        let id = role["id"]
            .as_str()
            .ok_or_else(|| "invalid role id".to_owned())?
            .to_owned();
        let fingerprint = serde_json::to_string(&json!({"role":role})).unwrap();
        self.state_mutate(
            &workspace_id,
            ROLES,
            &request_id,
            &fingerprint,
            || Ok(()),
            |transaction| {
                let revision = transaction
                    .query_row(
                        "SELECT revision FROM role WHERE id=?1",
                        [&id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .unwrap_or(0)
                    + 1;
                let mut stored = role;
                let fields = stored
                    .as_object_mut()
                    .ok_or_else(|| "invalid role".to_owned())?;
                fields.insert("revision".to_owned(), json!(revision));
                fields.insert("updated_at".to_owned(), json!(now_timestamp()));
                transaction
                    .execute(
                        "INSERT INTO role(id, body, revision) VALUES(?1, ?2, ?3)
                         ON CONFLICT(id) DO UPDATE SET body=excluded.body, revision=excluded.revision",
                        params![id, serde_json::to_string(&stored).unwrap(), revision],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(json!({"role":stored}))
            },
        )
    }

    pub(crate) fn role_delete(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        reject_unknown(&args, &["workspace_id", "request_id", "role_id"])?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let request_id = bounded(&required_string(&args, "request_id")?, 200, "request_id")?;
        let role_id = parse_role_id(&required_string(&args, "role_id")?, "role_id")?;
        let fingerprint = serde_json::to_string(&json!({"role_id":role_id})).unwrap();
        self.state_mutate(
            &workspace_id,
            ROLES,
            &request_id,
            &fingerprint,
            || Ok(()),
            |transaction| {
                if transaction
                    .execute("DELETE FROM role WHERE id=?1", [&role_id])
                    .map_err(|error| error.to_string())?
                    == 0
                {
                    return Err(format!("unknown role {role_id:?}"));
                }
                Ok(json!({"deleted":role_id}))
            },
        )
    }

    pub(crate) fn state_define(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        let workspace = required_string(&args, "workspace_id")?;
        let participant = bounded(
            &required_string(&args, "participant_id")?,
            128,
            "participant_id",
        )?;
        let request = bounded(&required_string(&args, "request_id")?, 200, "request_id")?;
        let definition = parse_definition(
            args.get("definition")
                .ok_or_else(|| "definition is required".to_owned())?,
        )?;
        let body = serde_json::to_string(&definition).unwrap();
        let id = definition["id"].as_str().unwrap().to_owned();
        let version = definition["version"].as_i64().unwrap();
        let fingerprint =
            serde_json::to_string(&json!({"participant_id":participant,"definition":definition}))
                .unwrap();
        self.state_mutate(
            &workspace,
            STATE,
            &request,
            &fingerprint,
            || self.participant(&workspace, &participant),
            |tx| {
                tx.execute(
                    "INSERT INTO state_definition(id,version,body) VALUES(?1,?2,?3)",
                    params![id, version, body],
                )
                .map_err(|e| {
                    if e.to_string().contains("UNIQUE") {
                        "state definitions are immutable; id/version already exists".to_owned()
                    } else {
                        e.to_string()
                    }
                })?;
                Ok(json!({"definition":definition}))
            },
        )
    }
    pub(crate) fn state_definitions(&self, args: Value) -> Result<Value, String> {
        let a = object(args)?;
        let w = required_string(&a, "workspace_id")?;
        let db = self.plugin_db(&w)?;
        let mut s = db
            .prepare("SELECT body FROM state_definition ORDER BY id,version")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"definitions":rows.map(|x|serde_json::from_str::<Value>(&x.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect::<Result<Vec<_>,String>>()?}),
        )
    }
    pub(crate) fn state_create(&self, args: Value) -> Result<Value, String> {
        let a = object(args)?;
        let w = required_string(&a, "workspace_id")?;
        let p = bounded(
            &required_string(&a, "participant_id")?,
            128,
            "participant_id",
        )?;
        let r = bounded(&required_string(&a, "request_id")?, 200, "request_id")?;
        let id = bounded(&required_string(&a, "id")?, 128, "id")?;
        let title = bounded(&required_string(&a, "title")?, 500, "title")?;
        let did = bounded(&required_string(&a, "definition_id")?, 128, "definition_id")?;
        let version = a
            .get("definition_version")
            .and_then(Value::as_i64)
            .filter(|v| *v > 0)
            .ok_or_else(|| "definition_version must be a positive integer".to_owned())?;
        let subject = canonical_subject(
            a.get("subject")
                .ok_or_else(|| "subject is required".to_owned())?,
            &w,
        )?;
        let fingerprint=serde_json::to_string(&json!({"participant_id":p,"id":id,"title":title,"definition_id":did,"definition_version":version,"subject":subject})).unwrap();
        self.state_mutate(&w,STATE,&r,&fingerprint,||self.participant(&w,&p),|tx|{let body:String=tx.query_row("SELECT body FROM state_definition WHERE id=?1 AND version=?2",params![did,version],|x|x.get(0)).map_err(|_|"unknown state definition".to_owned())?; let def:Value=serde_json::from_str(&body).map_err(|e|e.to_string())?; let marker=json!({"id":id,"title":title,"definition_id":did,"definition_version":version,"state":def["initial"],"revision":1,"subject":subject,"created_by":p}); tx.execute("INSERT INTO state_marker(id,body,revision) VALUES(?1,?2,1)",params![id,serde_json::to_string(&marker).unwrap()]).map_err(|e|e.to_string())?; tx.execute("INSERT INTO state_history(marker_id,revision,body) VALUES(?1,1,?2)",params![id,serde_json::to_string(&json!({"from":Value::Null,"to":marker["state"],"revision":1,"participant_id":p,"action":"create","timestamp":now_timestamp(),"note":Value::Null,"references":[]})).unwrap()]).map_err(|e|e.to_string())?; Ok(json!({"marker":marker}))})
    }
    pub(crate) fn state_list(&self, args: Value) -> Result<Value, String> {
        let a = object(args)?;
        let w = required_string(&a, "workspace_id")?;
        let db = self.plugin_db(&w)?;
        let mut s = db
            .prepare("SELECT body FROM state_marker ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        Ok(
            json!({"markers":rows.map(|x|serde_json::from_str::<Value>(&x.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect::<Result<Vec<_>,String>>()?}),
        )
    }
    pub(crate) fn state_get(&self, args: Value) -> Result<Value, String> {
        let a = object(args)?;
        let w = required_string(&a, "workspace_id")?;
        let id = required_string(&a, "id")?;
        self.state_detail(&w, &id)
    }
    pub(crate) fn state_advance(&self, args: Value) -> Result<Value, String> {
        let a = object(args)?;
        reject_unknown(
            &a,
            &[
                "workspace_id",
                "participant_id",
                "request_id",
                "id",
                "expected_revision",
                "to",
                "note",
                "references",
            ],
        )?;
        let w = required_string(&a, "workspace_id")?;
        let p = bounded(
            &required_string(&a, "participant_id")?,
            128,
            "participant_id",
        )?;
        let r = bounded(&required_string(&a, "request_id")?, 200, "request_id")?;
        let id = bounded(&required_string(&a, "id")?, 128, "id")?;
        let expected = a
            .get("expected_revision")
            .and_then(Value::as_i64)
            .filter(|v| *v > 0)
            .ok_or_else(|| "expected_revision must be a positive integer".to_owned())?;
        let to = bounded(&required_string(&a, "to")?, 128, "to")?;
        let note = match a.get("note") {
            None => None,
            Some(Value::String(note)) => Some(bounded(note, 4000, "note")?),
            _ => return Err("note must be a string".to_owned()),
        };
        let references = canonical_references(a.get("references"), &w)?;
        let fingerprint = serde_json::to_string(&json!({"participant_id":p,"id":id,"expected_revision":expected,"to":to,"note":note,"references":references})).unwrap();
        let request_lock = {
            let mut locks = self.inner.request_locks.lock().unwrap();
            locks
                .entry((w.clone(), r.clone()))
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _request_guard = request_lock.lock().unwrap();
        if let Some(replay) = self.state_replay(&w, STATE, &r, &fingerprint)? {
            return Ok(replay);
        }
        let (marker, definition, _, attached) = self.state_stored_detail(&w, &id)?;
        if marker["revision"].as_i64() != Some(expected) {
            return Err(format!(
                "state marker revision conflict: expected {expected}, current {}",
                marker["revision"]
            ));
        }
        let transition = declared_transition(&definition, &marker, &to)?;
        let task_observation = self.marker_task_observation(&w, &marker);
        let readiness = self.transition_readiness(
            &w,
            &marker,
            &transition,
            attached,
            &references,
            task_observation.as_ref(),
        );
        if readiness["readiness"] != "ready" {
            return Err(format!(
                "state transition is {}: {}",
                readiness["readiness"],
                readiness["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("; ")
            ));
        }
        self.state_mutate(&w, STATE, &r, &fingerprint, || self.participant(&w, &p), |tx| {
            let (body, rev): (String, i64) = tx.query_row("SELECT body,revision FROM state_marker WHERE id=?1", [&id], |x| Ok((x.get(0)?, x.get(1)?))).map_err(|_| "unknown state marker".to_owned())?;
            if rev != expected { return Err(format!("state marker revision conflict: expected {expected}, current {rev}")); }
            let mut marker: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            let definition_id = marker["definition_id"].as_str().ok_or_else(|| "invalid stored marker definition_id".to_owned())?;
            let definition_version = marker["definition_version"].as_i64().ok_or_else(|| "invalid stored marker definition_version".to_owned())?;
            let definition: String = tx.query_row("SELECT body FROM state_definition WHERE id=?1 AND version=?2", params![definition_id, definition_version], |x| x.get(0)).map_err(|e| e.to_string())?;
            let definition: Value = serde_json::from_str(&definition).map_err(|e| e.to_string())?;
            let from = marker["state"].clone();
            if !definition["transitions"].as_array().unwrap_or(&Vec::new()).iter().any(|edge| edge["from"] == from && edge["to"] == to) { return Err("requested state transition is not declared".to_owned()); }
            marker["state"] = Value::String(to.clone()); marker["revision"] = json!(rev + 1);
            tx.execute("UPDATE state_marker SET body=?1,revision=?2 WHERE id=?3 AND revision=?4", params![serde_json::to_string(&marker).unwrap(), rev + 1, id, rev]).map_err(|e| e.to_string())?;
            let history = json!({"from":from,"to":to,"revision":rev+1,"participant_id":p,"action":"advance","timestamp":now_timestamp(),"note":note,"references":references});
            tx.execute("INSERT INTO state_history(marker_id,revision,body) VALUES(?1,?2,?3)", params![id, rev + 1, serde_json::to_string(&history).unwrap()]).map_err(|e| e.to_string())?;
            Ok(json!({"marker":marker}))
        })
    }
    fn state_replay(
        &self,
        workspace_id: &str,
        plugin: &str,
        request_id: &str,
        fingerprint: &str,
    ) -> Result<Option<Value>, String> {
        let db = self.plugin_db(workspace_id)?;
        let item = db.query_row("SELECT fingerprint,outcome FROM plugin_receipt WHERE plugin_id=?1 AND request_id=?2", params![plugin, request_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .optional().map_err(|error| error.to_string())?;
        item.map(|(old, outcome)| {
            if old != fingerprint {
                return Err("request_id was already used for a different request".to_owned());
            }
            let mut value: Value =
                serde_json::from_str(&outcome).map_err(|error| error.to_string())?;
            value
                .as_object_mut()
                .ok_or_else(|| "invalid stored state receipt".to_owned())?
                .insert("idempotent_replay".to_owned(), Value::Bool(true));
            Ok(value)
        })
        .transpose()
    }
    fn state_mutate<F, V>(
        &self,
        w: &str,
        plugin: &str,
        r: &str,
        fingerprint: &str,
        validate: V,
        work: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<Value, String>,
        V: FnOnce() -> Result<(), String>,
    {
        let mut db = self.plugin_db(w)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some((old,outcome))=tx.query_row("SELECT fingerprint,outcome FROM plugin_receipt WHERE plugin_id=?1 AND request_id=?2",params![plugin,r],|x|Ok((x.get::<_,String>(0)?,x.get::<_,String>(1)?))).optional().map_err(|e|e.to_string())?{if old!=fingerprint{return Err("request_id was already used for a different request".to_owned())}let mut v:Value=serde_json::from_str(&outcome).map_err(|e|e.to_string())?;v.as_object_mut().ok_or_else(||"invalid stored state receipt".to_owned())?.insert("idempotent_replay".to_owned(),Value::Bool(true));tx.commit().map_err(|e|e.to_string())?;return Ok(v);}
        validate()?;
        let attached: i64 = tx
            .query_row(
                "SELECT attached FROM plugin_attachment WHERE plugin_id=?1",
                [plugin],
                |x| x.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if attached == 0 {
            return Err(format!(
                "plugin {plugin:?} is detached; attach it before writing"
            ));
        }
        let outcome = work(&tx)?;
        tx.execute("INSERT INTO plugin_receipt(plugin_id,request_id,fingerprint,outcome) VALUES(?1,?2,?3,?4)",params![plugin,r,fingerprint,serde_json::to_string(&outcome).unwrap()]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(outcome)
    }
    pub(crate) fn state_detail(&self, w: &str, id: &str) -> Result<Value, String> {
        let (marker, definition, history, attached) = self.state_stored_detail(w, id)?;
        let task_observation = self.marker_task_observation(w, &marker);
        let transitions = definition["transitions"]
            .as_array()
            .ok_or_else(|| "invalid stored state definition transitions".to_owned())?
            .iter()
            .filter(|edge| edge["from"] == marker["state"])
            .map(|edge| {
                self.transition_readiness(
                    w,
                    &marker,
                    edge,
                    attached,
                    &[],
                    task_observation.as_ref(),
                )
            })
            .collect::<Vec<_>>();
        let mut response = json!({"marker":marker,"definition":definition,"history":history,"available_transitions":transitions,"attached":attached});
        if let Some(guidance) =
            state_guidance(&response["definition"], &response["marker"]["state"])
        {
            response
                .as_object_mut()
                .unwrap()
                .insert("guidance".to_owned(), guidance);
        }
        if let Some(task_observation) = task_observation {
            match task_observation {
                Ok(task) => {
                    response
                        .as_object_mut()
                        .unwrap()
                        .insert("task".to_owned(), task);
                }
                Err(error) => {
                    response
                        .as_object_mut()
                        .unwrap()
                        .insert("task_error".to_owned(), Value::String(error));
                }
            }
        }
        Ok(response)
    }
    fn state_stored_detail(
        &self,
        w: &str,
        id: &str,
    ) -> Result<(Value, Value, Vec<Value>, bool), String> {
        let mut db = self.plugin_db(w)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|error| error.to_string())?;
        let body: String = tx
            .query_row("SELECT body FROM state_marker WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| format!("unknown state marker {id:?}"))?;
        let marker: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let definition_id = marker["definition_id"]
            .as_str()
            .ok_or_else(|| "invalid stored marker definition_id".to_owned())?;
        let definition_version = marker["definition_version"]
            .as_i64()
            .ok_or_else(|| "invalid stored marker definition_version".to_owned())?;
        let definition: String = tx
            .query_row(
                "SELECT body FROM state_definition WHERE id=?1 AND version=?2",
                params![definition_id, definition_version],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let definition: Value = serde_json::from_str(&definition).map_err(|e| e.to_string())?;
        let mut stmt = tx
            .prepare("SELECT body FROM state_history WHERE marker_id=?1 ORDER BY revision")
            .map_err(|e| e.to_string())?;
        let history = stmt
            .query_map([id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|x| {
                serde_json::from_str::<Value>(&x.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        let attached: i64 = tx
            .query_row(
                "SELECT attached FROM plugin_attachment WHERE plugin_id=?1",
                [STATE],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(0);
        drop(stmt);
        tx.commit().map_err(|error| error.to_string())?;
        Ok((marker, definition, history, attached != 0))
    }
    pub(crate) fn state_opportunities(&self, args: Value) -> Result<Value, String> {
        let args = object(args)?;
        reject_unknown(
            &args,
            &["workspace_id", "state", "capability", "unassigned"],
        )?;
        let workspace_id = required_string(&args, "workspace_id")?;
        let state = args
            .get("state")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "state must be a string".to_owned())
            })
            .transpose()?
            .map(|value| bounded(value, 128, "state"))
            .transpose()?;
        let capability = args
            .get("capability")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "capability must be a string".to_owned())
            })
            .transpose()?
            .map(|value| bounded(value, 128, "capability"))
            .transpose()?;
        let unassigned = args
            .get("unassigned")
            .map(|value| {
                value
                    .as_bool()
                    .ok_or_else(|| "unassigned must be a boolean".to_owned())
            })
            .transpose()?
            .unwrap_or(false);
        let markers = self.state_list(json!({"workspace_id":workspace_id}))?["markers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut opportunities = Vec::new();
        for marker in markers {
            if state
                .as_deref()
                .is_some_and(|wanted| marker["state"] != wanted)
            {
                continue;
            }
            let id = marker["id"]
                .as_str()
                .ok_or_else(|| "invalid stored state marker id".to_owned())?;
            let detail = self.state_detail(&workspace_id, id)?;
            if detail["available_transitions"]
                .as_array()
                .is_none_or(Vec::is_empty)
            {
                continue;
            }
            if capability.as_deref().is_some_and(|wanted| {
                !detail
                    .pointer("/guidance/capabilities")
                    .and_then(Value::as_array)
                    .is_some_and(|values| values.iter().any(|value| value == wanted))
            }) {
                continue;
            }
            if unassigned
                && !detail
                    .get("task")
                    .is_some_and(|task| task["assignee"].is_null() || task["assignee"] == "")
            {
                continue;
            }
            let mut opportunity = json!({"marker":detail["marker"],"resource":{"kind":"state","workspace_id":workspace_id,"id":id},"transitions":detail["available_transitions"]});
            for key in ["guidance", "task", "task_error"] {
                if let Some(value) = detail.get(key) {
                    opportunity
                        .as_object_mut()
                        .unwrap()
                        .insert(key.to_owned(), value.clone());
                }
            }
            opportunities.push(opportunity);
        }
        Ok(json!({"opportunities":opportunities}))
    }
    fn task_observation(
        &self,
        workspace_id: &str,
        reference: &ResourceRef,
    ) -> Result<Value, String> {
        let store_id = reference
            .store_id
            .as_deref()
            .ok_or_else(|| "task subject is missing store_id".to_owned())?;
        let task_id = reference
            .task_id
            .as_deref()
            .ok_or_else(|| "task subject is missing task_id".to_owned())?;
        self.call(
            "task_show",
            json!({"workspace_id":workspace_id,"store_id":store_id,"task_id":task_id}),
        )
    }
    fn marker_task_observation(
        &self,
        workspace_id: &str,
        marker: &Value,
    ) -> Option<Result<Value, String>> {
        let subject = serde_json::from_value::<ResourceRef>(marker["subject"].clone()).ok()?;
        matches!(subject.kind, crate::resources::ResourceKind::Task)
            .then(|| self.task_observation(workspace_id, &subject))
    }
    fn transition_readiness(
        &self,
        workspace_id: &str,
        marker: &Value,
        edge: &Value,
        attached: bool,
        supplied_references: &[Value],
        task_observation: Option<&Result<Value, String>>,
    ) -> Value {
        let mut reasons = Vec::new();
        let mut needs_input = false;
        let mut blocked = !attached;
        if !attached {
            reasons.push("State is detached; readiness cannot be acted on".to_owned());
        }
        let subject = serde_json::from_value::<ResourceRef>(marker["subject"].clone());
        if let Ok(subject) = &subject {
            if matches!(subject.kind, crate::resources::ResourceKind::Task)
                && task_observation.is_some_and(Result::is_err)
            {
                blocked = true;
                reasons.push("task subject does not resolve".to_owned());
            }
        } else {
            blocked = true;
            reasons.push("state marker subject is invalid".to_owned());
        }
        for prerequisite in edge["prerequisites"].as_array().into_iter().flatten() {
            match prerequisite["kind"].as_str() {
                Some("subject_task_closed") => match &subject {
                    Ok(subject) if matches!(subject.kind, crate::resources::ResourceKind::Task) => {
                        match task_observation {
                            Some(Ok(task)) if task["status"] == "closed" => {}
                            Some(Ok(_)) => {
                                blocked = true;
                                reasons.push("subject task is not closed".to_owned())
                            }
                            _ => {
                                blocked = true;
                                reasons.push("subject task does not resolve".to_owned())
                            }
                        }
                    }
                    _ => {
                        blocked = true;
                        reasons.push("subject_task_closed requires a task subject".to_owned())
                    }
                },
                Some("reference_kind") => {
                    let kind = prerequisite["resource_kind"].as_str().unwrap_or_default();
                    let matching = supplied_references
                        .iter()
                        .filter(|reference| reference["kind"] == kind)
                        .collect::<Vec<_>>();
                    if matching.is_empty() {
                        needs_input = true;
                        reasons.push(format!("requires a submitted {kind} reference"));
                    } else if !matching.iter().any(|reference| {
                        self.resource_get(json!({"workspace_id":workspace_id,"ref":reference}))
                            .is_ok()
                    }) {
                        blocked = true;
                        reasons.push(format!("submitted {kind} reference does not resolve"));
                    }
                }
                _ => {
                    blocked = true;
                    reasons.push("invalid stored transition prerequisite".to_owned())
                }
            }
        }
        let readiness = if blocked {
            "blocked"
        } else if needs_input {
            "needs_input"
        } else {
            "ready"
        };
        let mut enriched = edge.clone();
        enriched
            .as_object_mut()
            .unwrap()
            .insert("readiness".to_owned(), Value::String(readiness.to_owned()));
        enriched
            .as_object_mut()
            .unwrap()
            .insert("reasons".to_owned(), json!(reasons));
        enriched
    }
}

pub(crate) fn unavailable_plugin_catalog(error: &str) -> Value {
    json!({"plugins": MANIFESTS.iter().map(|item| json!({
        "id":item.id,"version":item.version,"name":item.name,"description":item.description,
        "required":item.required,"attached":item.required,"available":item.required,
        "health":if item.required { "degraded: plugin state unavailable" } else { error },
        "dependencies":item.dependencies,"integrations":item.integrations,"resource_kinds":item.resource_kinds,"operations":item.operations
    })).collect::<Vec<_>>()})
}

fn parse_role(value: &Value) -> Result<Value, String> {
    let fields = value
        .as_object()
        .ok_or_else(|| "role must be an object".to_owned())?;
    if fields.keys().any(|field| {
        !matches!(
            field.as_str(),
            "id" | "label" | "instructions" | "capabilities" | "needed" | "tier_hint"
        )
    }) {
        return Err("role contains unknown fields".to_owned());
    }
    let id = parse_role_id(&required_string(fields, "id")?, "role.id")?;
    let label = required_role_text(fields, "label", 120)?;
    let instructions = required_role_text(fields, "instructions", 4000)?;
    let capabilities = parse_role_capabilities(
        fields
            .get("capabilities")
            .ok_or_else(|| "role.capabilities is required".to_owned())?,
    )?;
    let needed = fields
        .get("needed")
        .and_then(Value::as_i64)
        .filter(|needed| (0..=20).contains(needed))
        .ok_or_else(|| "role.needed must be an integer from 0 through 20".to_owned())?;
    let tier_hint = optional_role_text(fields, "tier_hint", 64)?;
    let mut role = json!({
        "id":id,
        "label":label,
        "instructions":instructions,
        "capabilities":capabilities,
        "needed":needed
    });
    if let Some(tier_hint) = tier_hint {
        role.as_object_mut()
            .unwrap()
            .insert("tier_hint".to_owned(), json!(tier_hint));
    }
    Ok(role)
}

fn parse_role_id(value: &str, field: &str) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 64
        || value.starts_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(format!(
            "{field} must be a 1..64 character lowercase role id"
        ));
    }
    Ok(value.to_owned())
}

fn required_role_text(
    fields: &serde_json::Map<String, Value>,
    field: &str,
    maximum: usize,
) -> Result<String, String> {
    let value = required_string(fields, field)?;
    role_text(&value, maximum, field, field == "instructions")?;
    Ok(value)
}

fn optional_role_text(
    fields: &serde_json::Map<String, Value>,
    field: &str,
    maximum: usize,
) -> Result<Option<String>, String> {
    match fields.get(field) {
        None => Ok(None),
        Some(Value::String(value)) => {
            role_text(value, maximum, field, true)?;
            Ok(Some(value.to_owned()))
        }
        Some(_) => Err(format!("{field} must be a string")),
    }
}

fn role_text(value: &str, maximum: usize, field: &str, allow_empty: bool) -> Result<(), String> {
    if (!allow_empty && value.is_empty()) || value.chars().count() > maximum || value.contains('\0')
    {
        let lower_bound = if allow_empty { 0 } else { 1 };
        return Err(format!(
            "{field} must contain {lower_bound}..{maximum} characters"
        ));
    }
    Ok(())
}

fn parse_role_capabilities(value: &Value) -> Result<Vec<String>, String> {
    let capabilities = value
        .as_array()
        .filter(|values| values.len() <= MAX_CAPABILITIES)
        .ok_or_else(|| "role.capabilities must contain at most 32 strings".to_owned())?;
    capabilities
        .iter()
        .map(|capability| {
            let capability = capability
                .as_str()
                .ok_or_else(|| "role.capabilities must contain strings".to_owned())?;
            role_text(capability, 128, "role.capability", false)?;
            Ok(capability.to_owned())
        })
        .collect()
}

fn parse_declared_roles(value: &Value) -> Result<Vec<String>, String> {
    let roles = value
        .as_array()
        .filter(|values| values.len() <= MAX_DECLARED_ROLES)
        .ok_or_else(|| "roles must contain at most 16 role ids".to_owned())?;
    roles
        .iter()
        .map(|role| {
            let role = role
                .as_str()
                .ok_or_else(|| "roles must contain role ids".to_owned())?;
            parse_role_id(role, "role")
        })
        .collect()
}

fn parse_declared_skills(value: &Value) -> Result<Vec<String>, String> {
    let skills = value
        .as_array()
        .filter(|values| values.len() <= MAX_DECLARED_SKILLS)
        .ok_or_else(|| "skills must contain at most 32 strings".to_owned())?;
    skills
        .iter()
        .map(|skill| {
            let skill = skill
                .as_str()
                .ok_or_else(|| "skills must contain strings".to_owned())?;
            role_text(skill, 200, "skill", false)?;
            Ok(skill.to_owned())
        })
        .collect()
}

fn parse_definition(value: &Value) -> Result<Value, String> {
    let map = value
        .as_object()
        .ok_or_else(|| "definition must be an object".to_owned())?;
    let allowed: HashSet<&str> = [
        "id",
        "version",
        "label",
        "states",
        "initial",
        "transitions",
        "state_guidance",
    ]
    .into_iter()
    .collect();
    if map.keys().any(|k| !allowed.contains(k.as_str())) {
        return Err("definition contains unknown fields".to_owned());
    }
    let id = map
        .get("id")
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .ok_or_else(|| "definition.id is required".to_owned())?;
    checked_text(id, 128, "definition.id")?;
    let version = map
        .get("version")
        .and_then(Value::as_i64)
        .filter(|x| *x > 0)
        .ok_or_else(|| "definition.version must be a positive integer".to_owned())?;
    let label = map
        .get("label")
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
        .ok_or_else(|| "definition.label is required".to_owned())?;
    checked_text(label, 500, "definition.label")?;
    let states = map
        .get("states")
        .and_then(Value::as_array)
        .filter(|x| !x.is_empty() && x.len() <= MAX_STATES)
        .ok_or_else(|| "definition.states must contain 1..64 strings".to_owned())?;
    let mut names = HashSet::new();
    for state in states {
        let n = state
            .as_str()
            .filter(|x| !x.is_empty())
            .ok_or_else(|| "definition states must be non-empty strings".to_owned())?;
        checked_text(n, 128, "definition state")?;
        if !names.insert(n) {
            return Err("definition states must be unique".to_owned());
        }
    }
    let initial = map
        .get("initial")
        .and_then(Value::as_str)
        .filter(|x| names.contains(*x))
        .ok_or_else(|| "definition.initial must be one declared state".to_owned())?;
    let state_guidance = match map.get("state_guidance") {
        None => None,
        Some(Value::Object(entries)) if entries.len() <= MAX_STATES => {
            let mut normalized = serde_json::Map::new();
            for (state, guidance) in entries {
                if !names.contains(state.as_str()) {
                    return Err("state_guidance keys must be declared states".to_owned());
                }
                let guidance = guidance
                    .as_object()
                    .ok_or_else(|| "state guidance must be an object".to_owned())?;
                if guidance
                    .keys()
                    .any(|key| key != "instructions" && key != "capabilities")
                {
                    return Err("state guidance contains unknown fields".to_owned());
                }
                let instructions = guidance
                    .get("instructions")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "state guidance.instructions is required".to_owned())?;
                checked_text(instructions, 4000, "state guidance.instructions")?;
                let capabilities = match guidance.get("capabilities") {
                    None => None,
                    Some(Value::Array(items)) if items.len() <= MAX_CAPABILITIES => {
                        let mut unique = HashSet::new();
                        for capability in items {
                            let capability = capability.as_str().ok_or_else(|| {
                                "state guidance.capabilities must contain strings".to_owned()
                            })?;
                            checked_text(capability, 128, "state guidance.capability")?;
                            if !unique.insert(capability) {
                                return Err("state guidance.capabilities must be unique".to_owned());
                            }
                        }
                        Some(items.clone())
                    }
                    _ => {
                        return Err(
                            "state guidance.capabilities must contain at most 32 strings"
                                .to_owned(),
                        )
                    }
                };
                let mut item = json!({"instructions":instructions});
                if let Some(capabilities) = capabilities {
                    item.as_object_mut()
                        .unwrap()
                        .insert("capabilities".to_owned(), Value::Array(capabilities));
                }
                normalized.insert(state.clone(), item);
            }
            Some(Value::Object(normalized))
        }
        _ => return Err("state_guidance must be an object with at most 64 entries".to_owned()),
    };
    let transitions = map
        .get("transitions")
        .and_then(Value::as_array)
        .filter(|x| x.len() <= MAX_TRANSITIONS)
        .ok_or_else(|| "definition.transitions must contain at most 256 edges".to_owned())?;
    let mut edges = HashSet::new();
    for edge in transitions {
        let edge = edge
            .as_object()
            .ok_or_else(|| "transition must be an object".to_owned())?;
        if edge.keys().any(|k| {
            k != "from" && k != "to" && k != "label" && k != "instructions" && k != "prerequisites"
        }) {
            return Err("transition contains unknown fields".to_owned());
        }
        let from = edge
            .get("from")
            .and_then(Value::as_str)
            .filter(|x| names.contains(*x))
            .ok_or_else(|| "transition.from must be a declared state".to_owned())?;
        let to = edge
            .get("to")
            .and_then(Value::as_str)
            .filter(|x| names.contains(*x))
            .ok_or_else(|| "transition.to must be a declared state".to_owned())?;
        if edge.get("label").is_some_and(|v| !v.is_string()) {
            return Err("transition.label must be a string".to_owned());
        }
        if let Some(label) = edge.get("label").and_then(Value::as_str) {
            checked_text(label, 500, "transition.label")?;
        }
        if edge
            .get("instructions")
            .is_some_and(|value| !value.is_string())
        {
            return Err("transition.instructions must be a string".to_owned());
        }
        if let Some(instructions) = edge.get("instructions").and_then(Value::as_str) {
            checked_text(instructions, 4000, "transition.instructions")?;
        }
        if let Some(prerequisites) = edge.get("prerequisites") {
            let prerequisites = prerequisites
                .as_array()
                .filter(|items| items.len() <= MAX_PREREQUISITES)
                .ok_or_else(|| {
                    "transition.prerequisites must contain at most 32 entries".to_owned()
                })?;
            let mut seen = HashSet::new();
            for prerequisite in prerequisites {
                let prerequisite = prerequisite
                    .as_object()
                    .ok_or_else(|| "transition prerequisite must be an object".to_owned())?;
                match prerequisite.get("kind").and_then(Value::as_str) {
                    Some("subject_task_closed") if prerequisite.len() == 1 => {
                        if !seen.insert("subject_task_closed".to_owned()) {
                            return Err("transition prerequisites must be unique".to_owned());
                        }
                    }
                    Some("reference_kind") if prerequisite.len() == 2 => {
                        let resource_kind = prerequisite
                            .get("resource_kind")
                            .and_then(Value::as_str)
                            .filter(|kind| matches!(*kind, "file" | "message" | "task"))
                            .ok_or_else(|| {
                                "reference_kind resource_kind must be file, message, or task"
                                    .to_owned()
                            })?;
                        if !seen.insert(format!("reference_kind:{resource_kind}")) {
                            return Err("transition prerequisites must be unique".to_owned());
                        }
                    }
                    _ => return Err("transition prerequisite is invalid".to_owned()),
                }
            }
        }
        if !edges.insert((from, to)) {
            return Err("definition transitions must be unique".to_owned());
        }
    }
    let mut definition = json!({"id":id,"version":version,"label":label,"states":states,"initial":initial,"transitions":transitions});
    if let Some(guidance) = state_guidance {
        definition
            .as_object_mut()
            .unwrap()
            .insert("state_guidance".to_owned(), guidance);
    }
    Ok(definition)
}
fn state_guidance(definition: &Value, state: &Value) -> Option<Value> {
    definition
        .get("state_guidance")?
        .get(state.as_str()?)
        .cloned()
}
fn declared_transition(definition: &Value, marker: &Value, to: &str) -> Result<Value, String> {
    definition["transitions"]
        .as_array()
        .and_then(|edges| {
            edges
                .iter()
                .find(|edge| edge["from"] == marker["state"] && edge["to"] == to)
        })
        .cloned()
        .ok_or_else(|| "requested state transition is not declared".to_owned())
}
fn canonical_subject(value: &Value, w: &str) -> Result<Value, String> {
    let mut subject = value
        .as_object()
        .cloned()
        .ok_or_else(|| "subject must be a ResourceRef object".to_owned())?;
    if subject
        .get("workspace_id")
        .and_then(Value::as_str)
        .is_some_and(|v| v != w)
    {
        return Err("cross-workspace state subjects are not allowed".to_owned());
    }
    subject.insert("workspace_id".into(), Value::String(w.to_owned()));
    let reference: ResourceRef = serde_json::from_value(Value::Object(subject))
        .map_err(|e| format!("invalid state subject: {e}"))?;
    validate_ref(&reference, w)?;
    if matches!(reference.kind, crate::resources::ResourceKind::File)
        && reference
            .revision
            .as_deref()
            .filter(|r| r.len() == 40 && r.chars().all(|c| c.is_ascii_hexdigit()))
            .is_none()
    {
        return Err("file state subjects require a full 40-character Git revision; read the file at a pinned revision first".to_owned());
    }
    serde_json::to_value(reference).map_err(|e| e.to_string())
}
fn canonical_references(value: Option<&Value>, workspace_id: &str) -> Result<Vec<Value>, String> {
    let items = match value {
        None => return Ok(Vec::new()),
        Some(Value::Array(items)) if items.len() <= 32 => items,
        _ => {
            return Err("references must be an array of at most 32 canonical resources".to_owned())
        }
    };
    items
        .iter()
        .map(|reference| canonical_subject(reference, workspace_id))
        .collect()
}
fn reject_unknown(args: &serde_json::Map<String, Value>, allowed: &[&str]) -> Result<(), String> {
    if args.keys().any(|key| !allowed.contains(&key.as_str())) {
        Err("operation contains unknown fields".to_owned())
    } else {
        Ok(())
    }
}
fn operation_schema(name: &str) -> Value {
    if let Some(schema) = crate::mcp::host_tool_schema(name) {
        return schema;
    }
    if let Some(tool) = mail_definition(name) {
        return tool.input_schema;
    }
    match name {
        "roles_list" => {
            json!({"type":"object","properties":{},"additionalProperties":false})
        }
        "role_declare" => roles_declare_schema(),
        "state_definitions" | "state_list" => {
            json!({"type":"object","properties":{},"additionalProperties":false})
        }
        "state_get" => {
            json!({"type":"object","properties":{"id":{"type":"string","maxLength":128}},"required":["id"],"additionalProperties":false})
        }
        "state_opportunities" => crate::mcp::state_schema("opportunities"),
        "state_define" => crate::mcp::state_schema("definition"),
        "state_create" => crate::mcp::state_schema("create"),
        "state_advance" => crate::mcp::state_schema("advance"),
        _ => json!({"type":"object","properties":{},"additionalProperties":false}),
    }
}
fn roles_declare_schema() -> Value {
    json!({
        "type":"object",
        "properties":{
            "participant_id":{"type":"string","maxLength":128},
            "request_id":{"type":"string","maxLength":200},
            "roles":{"type":"array","maxItems":16,"items":{"type":"string","pattern":"^[a-z0-9][a-z0-9-]{0,63}$"}},
            "skills":{"type":"array","maxItems":32,"items":{"type":"string","minLength":1,"maxLength":200}},
            "model":{"type":"string","maxLength":120},
            "tier":{"type":"string","maxLength":64}
        },
        "required":["participant_id","request_id","roles","skills"],
        "additionalProperties":false
    })
}
fn mail_definition(name: &str) -> Option<orchard_mail_mcp::ToolDefinition> {
    orchard_mail_mcp::tool_definitions()
        .into_iter()
        .find(|tool| tool.name == name)
}
fn operation_description(name: &str) -> &'static str {
    match name {
        "workspace_info" => {
            "Discover workspace paths, capabilities, task stores, and plugin state."
        }
        "workspace_intro" => "Read the workspace README and generic bounded-contribution guidance.",
        "workspace_status" => {
            "Read current workspace counts and source health without changing state."
        }
        "resource_get" => "Read one canonical workspace resource and its crosslinks.",
        "resource_links" => "Read incoming and outgoing links for one canonical resource.",
        "mail_register" => "Register a durable participant identity before writing as an agent.",
        "mail_resume" => "Resume a previously registered participant identity.",
        "mail_participants" => "List participant records and registration state.",
        "mail_channels" => "List shared Mail channels.",
        "mail_send" => "Send a bounded coordination message to a declared Mail destination.",
        "mail_history" => "Read bounded recent or chronological message history.",
        "mail_acknowledge" => "Record that a participant handled a delivered message.",
        "workspace_alerts" => "Poll coordination alerts without implicitly acknowledging them.",
        "tasks_list" => "List tasks from one attached Beads store.",
        "task_show" => "Read one qualified task.",
        "task_create" => "Create a task idempotently in an attached store.",
        "task_update" => "Update only supplied task fields idempotently.",
        "task_claim" => "Claim one open task as a registered participant.",
        "task_release" => "Return a task you hold to open and unassigned.",
        "task_close" => "Close one task idempotently.",
        "task_dependencies" => "Read task dependencies; dependency editing is unavailable.",
        "roles_list" => "List owner-defined advisory roles and current self-declarations.",
        "role_declare" => "Declare a registered participant's advisory roles and skills.",
        "state_define" => "Store an immutable declarative state-machine definition.",
        "state_definitions" => "List retained immutable state definitions.",
        "state_create" => "Create a marker for a canonical same-workspace subject.",
        "state_list" => "List retained state markers.",
        "state_get" => "Read marker history and currently available transitions.",
        "state_opportunities" => "Discover nonterminal markers by workflow state, guidance capability, or task assignment.",
        "state_advance" => "Advance a marker using optimistic revision compare-and-swap.",
        _ => "Bundled workspace operation.",
    }
}
fn bounded(value: &str, maximum: usize, field: &str) -> Result<String, String> {
    checked_text(value, maximum, field)?;
    Ok(value.to_owned())
}
fn checked_text(value: &str, maximum: usize, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        Err(format!("{field} exceeds {maximum} bytes"))
    } else {
        Ok(())
    }
}
fn now_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn snapshot_hook(_: &WorkspaceHost, _: &str) -> Result<Option<Value>, String> {
        unreachable!("synthetic hooks are run through the composition test callback")
    }

    fn manifest_with_snapshot(id: &'static str) -> Manifest {
        Manifest {
            id,
            version: 1,
            name: id,
            description: "synthetic",
            required: false,
            dependencies: &[],
            integrations: &[],
            resource_kinds: &[],
            operations: &[],
            intro_section: None,
            snapshot_section: Some(snapshot_hook),
        }
    }

    #[test]
    fn snapshot_sections_include_some_omit_none_and_skip_detached_hooks() {
        let manifests = [
            manifest_with_snapshot("some"),
            manifest_with_snapshot("none"),
            manifest_with_snapshot("error"),
            manifest_with_snapshot("detached"),
            manifest_with_snapshot("attachment-error"),
        ];
        let invoked = RefCell::new(Vec::new());
        let sections = compose_plugin_sections(
            &manifests,
            |item| match item.id {
                "detached" => Ok(false),
                "attachment-error" => Err("attachment unavailable".to_owned()),
                _ => Ok(true),
            },
            |item| item.snapshot_section,
            |item, _| {
                invoked.borrow_mut().push(item.id);
                match item.id {
                    "some" => Ok(Some(json!({"markers": 1}))),
                    "none" => Ok(None),
                    "error" => Err("hook unavailable".to_owned()),
                    other => panic!("unexpected hook invocation for {other}"),
                }
            },
        );

        assert_eq!(*invoked.borrow(), vec!["some", "none", "error"]);
        assert_eq!(sections.len(), 4);
        assert_eq!(sections[0].id, "some");
        assert_eq!(
            sections[0].result.as_ref().unwrap().as_ref(),
            Some(&json!({"markers": 1}))
        );
        assert_eq!(sections[1].id, "none");
        assert_eq!(sections[1].result.as_ref().unwrap(), &None);
        assert_eq!(sections[2].result.as_ref().unwrap_err(), "hook unavailable");
        assert_eq!(
            sections[3].result.as_ref().unwrap_err(),
            "attachment unavailable"
        );
    }
}
