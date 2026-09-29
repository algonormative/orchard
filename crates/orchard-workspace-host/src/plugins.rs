use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;

use crate::{
    object, required_string,
    resources::{validate_ref, ResourceRef},
    WorkspaceHost,
};

const CORE: &str = "core";
const CHAT: &str = "chat";
const TASKS: &str = "tasks";
const STATE: &str = "state";
const MAX_STATES: usize = 64;
const MAX_TRANSITIONS: usize = 256;

#[derive(Clone, Copy)]
struct Manifest {
    id: &'static str,
    version: u32,
    name: &'static str,
    description: &'static str,
    required: bool,
    dependencies: &'static [&'static str],
    resource_kinds: &'static [&'static str],
    operations: &'static [&'static str],
}

const MANIFESTS: &[Manifest] = &[
    Manifest {
        id: CORE,
        version: 1,
        name: "Core",
        description: "Workspace discovery, resources, and owned artifacts.",
        required: true,
        dependencies: &[],
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
    },
    Manifest {
        id: CHAT,
        version: 1,
        name: "Chat",
        description: "Workspace participants and messages.",
        required: true,
        dependencies: &[CORE],
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
    },
    Manifest {
        id: TASKS,
        version: 2,
        name: "Tasks",
        description: "Bounded Beads task access.",
        required: false,
        dependencies: &[CORE, CHAT],
        resource_kinds: &["task"],
        operations: &[
            "tasks_list",
            "task_show",
            "task_create",
            "task_update",
            "task_claim",
            "task_close",
            "task_dependencies",
        ],
    },
    Manifest {
        id: STATE,
        version: 1,
        name: "State",
        description: "Declarative workspace state markers.",
        required: false,
        dependencies: &[CORE, CHAT],
        resource_kinds: &["state"],
        operations: &[
            "state_define",
            "state_definitions",
            "state_create",
            "state_list",
            "state_get",
            "state_advance",
        ],
    },
];

fn manifest(id: &str) -> Result<&'static Manifest, String> {
    MANIFESTS
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("unknown bundled plugin {id:?}"))
}

impl WorkspaceHost {
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
            CREATE TABLE IF NOT EXISTS state_history (marker_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(marker_id, revision));")
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
            json!({"id":item.id,"version":item.version,"name":item.name,"description":item.description,"required":item.required,"attached":attached,"available":available,"health":health,"dependencies":item.dependencies,"resource_kinds":item.resource_kinds,"operations":item.operations}),
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
            return Err("the system participant cannot mutate State".to_owned());
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
        let transitions = definition["transitions"]
            .as_array()
            .ok_or_else(|| "invalid stored state definition transitions".to_owned())?
            .iter()
            .filter(|x| x["from"] == marker["state"])
            .cloned()
            .collect::<Vec<_>>();
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
        Ok(
            json!({"marker":marker,"definition":definition,"history":history,"available_transitions":transitions,"attached":attached != 0}),
        )
    }
}

pub(crate) fn unavailable_plugin_catalog(error: &str) -> Value {
    json!({"plugins": MANIFESTS.iter().map(|item| json!({
        "id":item.id,"version":item.version,"name":item.name,"description":item.description,
        "required":item.required,"attached":item.required,"available":item.required,
        "health":if item.required { "degraded: plugin state unavailable" } else { error },
        "dependencies":item.dependencies,"resource_kinds":item.resource_kinds,"operations":item.operations
    })).collect::<Vec<_>>()})
}

fn parse_definition(value: &Value) -> Result<Value, String> {
    let map = value
        .as_object()
        .ok_or_else(|| "definition must be an object".to_owned())?;
    let allowed: HashSet<&str> = ["id", "version", "label", "states", "initial", "transitions"]
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
        if edge
            .keys()
            .any(|k| k != "from" && k != "to" && k != "label")
        {
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
        if !edges.insert((from, to)) {
            return Err("definition transitions must be unique".to_owned());
        }
    }
    Ok(
        json!({"id":id,"version":version,"label":label,"states":states,"initial":initial,"transitions":transitions}),
    )
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
        "state_definitions" | "state_list" => {
            json!({"type":"object","properties":{},"additionalProperties":false})
        }
        "state_get" => {
            json!({"type":"object","properties":{"id":{"type":"string","maxLength":128}},"required":["id"],"additionalProperties":false})
        }
        "state_define" => crate::mcp::state_schema("definition"),
        "state_create" => crate::mcp::state_schema("create"),
        "state_advance" => crate::mcp::state_schema("advance"),
        _ => json!({"type":"object","properties":{},"additionalProperties":false}),
    }
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
        "task_close" => "Close one task idempotently.",
        "task_dependencies" => "Read task dependencies; dependency editing is unavailable.",
        "state_define" => "Store an immutable declarative state-machine definition.",
        "state_definitions" => "List retained immutable state definitions.",
        "state_create" => "Create a marker for a canonical same-workspace subject.",
        "state_list" => "List retained state markers.",
        "state_get" => "Read marker history and currently available transitions.",
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
