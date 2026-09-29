use base64::Engine;
use orchard_workspace_host::WorkspaceHost;
use rmcp::{
    model::CallToolRequestParams,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use tempfile::TempDir;

fn packaged_br() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/bin/br")
        .canonicalize()
        .expect("approved packaged br fixture")
}

fn new_host(temp: &TempDir) -> WorkspaceHost {
    WorkspaceHost::open(temp.path().join("data"), packaged_br()).expect("open host")
}

fn workspace(host: &WorkspaceHost, name: &str) -> (String, String, PathBuf) {
    let result = host
        .call(
            "workspace_create",
            json!({"name": name, "owner_name": "Owner"}),
        )
        .expect("create workspace");
    let item = &result["workspace"];
    (
        item["id"].as_str().unwrap().to_owned(),
        item["task_stores"][0]["id"].as_str().unwrap().to_owned(),
        PathBuf::from(item["root"].as_str().unwrap()),
    )
}

fn call(host: &WorkspaceHost, operation: &str, workspace_id: &str, arguments: Value) -> Value {
    let mut arguments = arguments.as_object().unwrap().clone();
    arguments.insert("workspace_id".into(), json!(workspace_id));
    host.call(operation, Value::Object(arguments)).unwrap()
}

fn error(host: &WorkspaceHost, operation: &str, workspace_id: &str, arguments: Value) -> String {
    let mut arguments = arguments.as_object().unwrap().clone();
    arguments.insert("workspace_id".into(), json!(workspace_id));
    host.call(operation, Value::Object(arguments)).unwrap_err()
}

fn register(host: &WorkspaceHost, workspace_id: &str, participant_id: &str) {
    call(
        host,
        "mail_register",
        workspace_id,
        json!({"participant_id":participant_id, "name":participant_id, "request_id":format!("register-{participant_id}")}),
    );
}

fn definition(id: &str, version: u64) -> Value {
    json!({
        "id":id, "version":version, "label":"Review",
        "states":["draft", "review", "done"], "initial":"draft",
        "transitions":[{"from":"draft", "to":"review", "label":"submit"}, {"from":"review", "to":"done"}]
    })
}

fn attach_state(host: &WorkspaceHost, workspace_id: &str) {
    call(
        host,
        "plugin_attach",
        workspace_id,
        json!({"plugin_id":"state", "request_id":"attach-state"}),
    );
}

fn mcp_arguments(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn mcp_call(name: &str, arguments: Value) -> CallToolRequestParams {
    CallToolRequestParams::new(name.to_owned()).with_arguments(mcp_arguments(arguments))
}

#[test]
fn bundled_catalog_and_inspection_make_capabilities_discoverable() {
    let temp = TempDir::new().unwrap();
    let host = new_host(&temp);
    let (workspace_id, _, _) = workspace(&host, "Catalog");
    let plugins = call(&host, "plugin_list", &workspace_id, json!({}))["plugins"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(plugins.len(), 4);
    for (id, required, attached) in [
        ("core", true, true),
        ("chat", true, true),
        ("tasks", false, true),
        ("state", false, false),
    ] {
        let plugin = plugins.iter().find(|item| item["id"] == id).unwrap();
        assert_eq!(plugin["required"], required, "{id}");
        assert_eq!(plugin["attached"], attached, "{id}");
        assert!(!plugin["operations"].as_array().unwrap().is_empty(), "{id}");
    }
    let state = call(
        &host,
        "plugin_inspect",
        &workspace_id,
        json!({"plugin_id":"state"}),
    )["plugin"]
        .clone();
    let operation = |name: &str| {
        state["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == name)
            .unwrap()
            .clone()
    };
    let define_schema = operation("state_define")["input_schema"].clone();
    let definition_schema = &define_schema["properties"]["definition"];
    assert_eq!(definition_schema["properties"]["states"]["maxItems"], 64);
    assert_eq!(definition_schema["properties"]["initial"]["type"], "string");
    let edge = &definition_schema["properties"]["transitions"]["items"];
    assert!(edge["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "from"));
    assert!(edge["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "to"));
    let create_schema = operation("state_create")["input_schema"].clone();
    assert_eq!(
        create_schema["properties"]["subject"]["required"],
        json!(["kind", "workspace_id"])
    );
    let advance_schema = operation("state_advance")["input_schema"].clone();
    assert_eq!(
        advance_schema["properties"]["expected_revision"]["minimum"],
        1
    );
    let core = call(
        &host,
        "plugin_inspect",
        &workspace_id,
        json!({"plugin_id":"core"}),
    )["plugin"]
        .clone();
    let core_operations = core["operations"].as_array().unwrap();
    for name in ["artifact_upload", "resource_get", "resource_link"] {
        assert!(
            core_operations
                .iter()
                .any(|operation| operation["name"] == name),
            "core omits {name}"
        );
    }
    let chat = call(
        &host,
        "plugin_inspect",
        &workspace_id,
        json!({"plugin_id":"chat"}),
    )["plugin"]
        .clone();
    for name in ["mail_resume", "mail_acknowledge"] {
        let schema = chat["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|operation| operation["name"] == name)
            .unwrap()["input_schema"]
            .clone();
        assert_eq!(schema["type"], "object");
        assert!(
            !schema["properties"].as_object().unwrap().is_empty(),
            "{name} must expose its real named-tool schema"
        );
    }
    assert!(!call(
        &host,
        "plugin_inspect",
        &workspace_id,
        json!({"plugin_id":"tasks"})
    )["plugin"]["operations"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(error(
        &host,
        "plugin_inspect",
        &workspace_id,
        json!({"plugin_id":"unbundled"})
    )
    .contains("unknown bundled plugin"));
    assert!(error(
        &host,
        "plugin_detach",
        &workspace_id,
        json!({"plugin_id":"unbundled", "request_id":"no-unbundled"})
    )
    .contains("unknown bundled plugin"));
    assert!(error(
        &host,
        "plugin_detach",
        &workspace_id,
        json!({"plugin_id":"core", "request_id":"no-core"})
    )
    .contains("required plugin"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_mcp_session_can_attach_and_use_state_without_refreshing_tools() {
    let temp = TempDir::new().unwrap();
    let host = Arc::new(new_host(&temp));
    let (workspace_id, _, _) = workspace(&host, "MCP plugins");
    let server = host.clone().start_server().await.unwrap();
    let token = call(&host, "connection_info", &workspace_id, json!({}))["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let uri = format!("http://{}/workspaces/{workspace_id}/mcp", server.endpoint());
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(uri).auth_header(&token),
    );
    let client = ().serve(transport).await.unwrap();
    let tools = client.list_all_tools().await.unwrap(); // exactly one tools/list for this session
    assert!(tools.iter().any(|tool| tool.name == "plugin_call"));
    assert!(tools.iter().any(|tool| tool.name == "state_advance"));
    for plugin_id in ["core", "chat"] {
        let inspected = client
            .call_tool(mcp_call("plugin_inspect", json!({"plugin_id":plugin_id})))
            .await
            .unwrap();
        assert_eq!(inspected.is_error, Some(false));
        let operations = &inspected.structured_content.unwrap()["plugin"]["operations"];
        for operation in operations.as_array().unwrap() {
            let name = operation["name"].as_str().unwrap();
            let listed = tools.iter().find(|tool| tool.name == name).unwrap();
            assert_eq!(
                serde_json::to_value(listed.input_schema.as_ref()).unwrap(),
                operation["input_schema"],
                "{plugin_id}/{name} inspection must match its named MCP tool"
            );
        }
    }
    for (name, arguments) in [
        (
            "plugin_attach",
            json!({"plugin_id":"state", "request_id":"mcp-attach"}),
        ),
        (
            "mail_register",
            json!({"participant_id":"alice", "name":"Alice", "request_id":"mcp-register"}),
        ),
        (
            "plugin_call",
            json!({"plugin_id":"state", "operation":"state_define", "arguments":{"participant_id":"alice", "request_id":"mcp-define", "definition":definition("mcp-flow", 1)}}),
        ),
        (
            "plugin_call",
            json!({"plugin_id":"state", "operation":"state_create", "arguments":{"participant_id":"alice", "request_id":"mcp-create", "id":"mcp-marker", "title":"MCP marker", "definition_id":"mcp-flow", "definition_version":1, "subject":{"kind":"channel", "id":"general"}}}),
        ),
        (
            "plugin_call",
            json!({"plugin_id":"state", "operation":"state_advance", "arguments":{"participant_id":"alice", "request_id":"mcp-advance", "id":"mcp-marker", "to":"review", "expected_revision":1}}),
        ),
    ] {
        let response = client.call_tool(mcp_call(name, arguments)).await.unwrap();
        assert_eq!(response.is_error, Some(false), "{name}: {response:?}");
    }
    let detail = call(
        &host,
        "state_get",
        &workspace_id,
        json!({"id":"mcp-marker"}),
    );
    assert_eq!(detail["marker"]["state"], "review");
    server.shutdown().await.unwrap();
}

#[test]
fn detach_gates_new_task_and_state_writes_but_keeps_retained_reads() {
    let temp = TempDir::new().unwrap();
    let host = new_host(&temp);
    let (workspace_id, store_id, _) = workspace(&host, "Detach");
    let task = call(
        &host,
        "task_create",
        &workspace_id,
        json!({"store_id":store_id, "request_id":"task-before", "title":"Retain me"}),
    );
    let task_id = task["task"]["id"].as_str().unwrap();
    call(
        &host,
        "plugin_detach",
        &workspace_id,
        json!({"plugin_id":"tasks", "request_id":"detach-tasks"}),
    );
    assert_eq!(
        call(
            &host,
            "plugin_detach",
            &workspace_id,
            json!({"plugin_id":"tasks", "request_id":"detach-tasks"})
        )["idempotent_replay"],
        true
    );
    assert!(error(
        &host,
        "plugin_attach",
        &workspace_id,
        json!({"plugin_id":"tasks", "request_id":"detach-tasks"})
    )
    .contains("different plugin attachment request"));
    assert!(error(
        &host,
        "task_create",
        &workspace_id,
        json!({"store_id":store_id, "request_id":"task-after", "title":"Blocked"})
    )
    .contains("detached"));
    assert!(error(&host, "plugin_call", &workspace_id, json!({"plugin_id":"tasks", "operation":"task_create", "arguments":{"store_id":store_id, "request_id":"gateway-task", "title":"Blocked"}})).contains("detached"));
    assert_eq!(
        call(
            &host,
            "task_show",
            &workspace_id,
            json!({"store_id":store_id, "task_id":task_id})
        )["id"],
        task_id
    );
    call(
        &host,
        "plugin_attach",
        &workspace_id,
        json!({"plugin_id":"tasks", "request_id":"reattach-tasks"}),
    );
    assert!(call(
        &host,
        "task_create",
        &workspace_id,
        json!({"store_id":store_id, "request_id":"task-after-reattach", "title":"Allowed"})
    )["task"]["id"]
        .is_string());

    register(&host, &workspace_id, "alice");
    attach_state(&host, &workspace_id);
    call(
        &host,
        "state_define",
        &workspace_id,
        json!({"participant_id":"alice", "request_id":"detach-definition", "definition":definition("detach-flow", 1)}),
    );
    call(
        &host,
        "state_create",
        &workspace_id,
        json!({"participant_id":"alice", "request_id":"detach-create", "id":"retained", "title":"Retained", "definition_id":"detach-flow", "definition_version":1, "subject":{"kind":"channel", "id":"general"}}),
    );
    call(
        &host,
        "plugin_detach",
        &workspace_id,
        json!({"plugin_id":"state", "request_id":"detach-state"}),
    );
    assert!(error(&host, "state_advance", &workspace_id, json!({"participant_id":"alice", "request_id":"detach-advance", "id":"retained", "to":"review", "expected_revision":1})).contains("detached"));
    let retained = call(&host, "state_get", &workspace_id, json!({"id":"retained"}));
    assert_eq!(retained["attached"], false);
    assert_eq!(retained["marker"]["state"], "draft");
}

#[test]
fn state_enforces_pinned_subjects_immutable_definitions_receipts_and_cas() {
    let temp = TempDir::new().unwrap();
    let data = temp.path().join("data");
    let host = Arc::new(WorkspaceHost::open(data.clone(), packaged_br()).unwrap());
    let (workspace_id, _, _) = workspace(&host, "State lifecycle");
    let (foreign_id, _, _) = workspace(&host, "Foreign");
    register(&host, &workspace_id, "alice");
    register(&host, &workspace_id, "bob");
    attach_state(&host, &workspace_id);
    let uploaded = call(
        &host,
        "artifact_upload",
        &workspace_id,
        json!({"path":"brief.md", "content_base64":base64::engine::general_purpose::STANDARD.encode(b"brief"), "request_id":"state-file"}),
    );
    let pinned_file = uploaded["resource"]["ref"].clone();
    assert_eq!(pinned_file["revision"].as_str().unwrap().len(), 40);
    let define_args = json!({"participant_id":"alice", "request_id":"define-one", "definition":definition("review-flow", 1)});
    let first_definition = call(&host, "state_define", &workspace_id, define_args.clone());
    let replay = call(&host, "state_define", &workspace_id, define_args.clone());
    assert_eq!(replay["definition"], first_definition["definition"]);
    assert_eq!(replay["idempotent_replay"], true);
    assert!(error(&host, "state_define", &workspace_id, json!({"participant_id":"bob", "request_id":"define-one", "definition":definition("review-flow", 1)})).contains("different request"));
    assert!(error(&host, "state_define", &workspace_id, json!({"participant_id":"alice", "request_id":"duplicate-definition", "definition":definition("review-flow", 1)})).contains("immutable"));
    assert_eq!(
        call(
            &host,
            "state_define",
            &workspace_id,
            json!({"participant_id":"alice", "request_id":"version-two", "definition":definition("review-flow", 2)})
        )["definition"]["version"],
        2
    );
    assert!(error(&host, "state_define", &workspace_id, json!({"participant_id":"alice", "request_id":"bad-edge", "definition":{"id":"bad", "version":1, "label":"Bad", "states":["a"], "initial":"a", "transitions":[{"from":"a", "to":"missing"}]}})).contains("declared state"));
    assert!(error(&host, "state_define", &workspace_id, json!({"participant_id":"alice", "request_id":"too-many", "definition":{"id":"large", "version":1, "label":"Large", "states":(0..65).map(|i| format!("s{i}")).collect::<Vec<_>>(), "initial":"s0", "transitions":[]}})).contains("1..64"));
    assert!(error(&host, "state_create", &workspace_id, json!({"participant_id":"alice", "request_id":"foreign-subject", "id":"foreign", "title":"Foreign", "definition_id":"review-flow", "definition_version":1, "subject":{"kind":"channel", "workspace_id":foreign_id, "id":"general"}})).contains("cross-workspace"));
    assert!(error(&host, "state_create", &workspace_id, json!({"participant_id":"alice", "request_id":"unpinned-file", "id":"unpinned", "title":"Unpinned", "definition_id":"review-flow", "definition_version":1, "subject":{"kind":"file", "root_id":pinned_file["root_id"], "path":"brief.md"}})).contains("pinned"));
    let create_args = json!({"participant_id":"alice", "request_id":"create-one", "id":"marker", "title":"Pinned marker", "definition_id":"review-flow", "definition_version":1, "subject":pinned_file});
    let created = call(&host, "state_create", &workspace_id, create_args.clone());
    assert_eq!(
        call(&host, "state_create", &workspace_id, create_args.clone())["idempotent_replay"],
        true
    );
    assert!(error(&host, "state_create", &workspace_id, json!({"participant_id":"bob", "request_id":"create-one", "id":"marker", "title":"Pinned marker", "definition_id":"review-flow", "definition_version":1, "subject":pinned_file})).contains("different request"));
    assert_eq!(created["marker"]["subject"], pinned_file);
    let advance_args = json!({"participant_id":"alice", "request_id":"advance-one", "id":"marker", "to":"review", "expected_revision":1, "note":"ready", "references":[{"kind":"channel", "id":"general"}]});
    let advanced = call(&host, "state_advance", &workspace_id, advance_args.clone());
    assert_eq!(
        call(&host, "state_advance", &workspace_id, advance_args.clone())["idempotent_replay"],
        true
    );
    assert!(error(&host, "state_advance", &workspace_id, json!({"participant_id":"alice", "request_id":"advance-one", "id":"marker", "to":"review", "expected_revision":1, "note":"changed"})).contains("different request"));
    assert_eq!(advanced["marker"]["revision"], 2);
    assert!(error(&host, "state_advance", &workspace_id, json!({"participant_id":"alice", "request_id":"illegal", "id":"marker", "to":"draft", "expected_revision":2})).contains("not declared"));
    let barrier = Arc::new(Barrier::new(2));
    let attempts = ["alice", "bob"].map(|participant_id| {
        let host = Arc::clone(&host);
        let workspace_id = workspace_id.clone();
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            host.call(
                "state_advance",
                json!({
                    "workspace_id":workspace_id, "participant_id":participant_id,
                    "request_id":format!("cas-{participant_id}"), "id":"marker",
                    "to":"done", "expected_revision":2
                }),
            )
        })
    });
    let outcomes = attempts.map(|attempt| attempt.join().expect("CAS caller must not panic"));
    assert_eq!(
        outcomes.iter().filter(|item| item.is_ok()).count(),
        1,
        "exactly one compare-and-swap winner"
    );
    let loser = outcomes
        .iter()
        .find_map(|item| item.as_ref().err())
        .expect("one CAS loser");
    assert!(
        loser.contains("revision conflict") || loser.contains("current revision"),
        "unexpected CAS error: {loser}"
    );
    let detail = call(&host, "state_get", &workspace_id, json!({"id":"marker"}));
    assert_eq!(detail["marker"]["state"], "done");
    assert_eq!(detail["history"].as_array().unwrap().len(), 3);
    drop(host);
    let reopened = WorkspaceHost::open(data, packaged_br()).unwrap();
    assert_eq!(
        call(
            &reopened,
            "state_get",
            &workspace_id,
            json!({"id":"marker"})
        )["marker"]["state"],
        "done"
    );
    assert_eq!(
        call(&reopened, "state_advance", &workspace_id, advance_args)["idempotent_replay"],
        true
    );
}

#[test]
fn state_receipts_survive_leaves_detach_archive_and_plugin_database_failures() {
    let temp = TempDir::new().unwrap();
    let host = new_host(&temp);
    let (workspace_id, _, root) = workspace(&host, "Failure boundaries");
    register(&host, &workspace_id, "alice");
    attach_state(&host, &workspace_id);
    let define_args = json!({"participant_id":"alice", "request_id":"survive-define", "definition":definition("survive", 1)});
    call(&host, "state_define", &workspace_id, define_args.clone());
    call(
        &host,
        "mail_leave",
        &workspace_id,
        json!({"participant_id":"alice", "request_id":"alice-leaves"}),
    );
    assert_eq!(
        call(&host, "state_define", &workspace_id, define_args)["idempotent_replay"],
        true
    );
    assert!(error(&host, "state_define", &workspace_id, json!({"participant_id":"alice", "request_id":"after-leave", "definition":definition("new", 1)})).contains("registered"));
    assert!(error(&host, "state_define", &workspace_id, json!({"participant_id":"nobody", "request_id":"unknown", "definition":definition("unknown", 1)})).contains("registered"));
    call(
        &host,
        "plugin_detach",
        &workspace_id,
        json!({"plugin_id":"state", "request_id":"survive-detach"}),
    );
    assert_eq!(
        call(&host, "state_definitions", &workspace_id, json!({}))["definitions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(
            &host,
            "state_define",
            &workspace_id,
            json!({"participant_id":"alice", "request_id":"survive-define", "definition":definition("survive", 1)})
        )["idempotent_replay"],
        true
    );
    assert!(error(
        &host,
        "plugin_call",
        &workspace_id,
        json!({"plugin_id":"state", "operation":"workspace_archive", "arguments":{}})
    )
    .contains("not declared"));
    assert!(error(&host, "plugin_call", &workspace_id, json!({"plugin_id":"state", "operation":"state_define", "arguments":{"workspace_id":"foreign"}})).contains("may not supply workspace_id"));
    call(&host, "workspace_archive", &workspace_id, json!({}));
    assert!(error(&host, "state_definitions", &workspace_id, json!({})).contains("archived"));

    let (healthy_id, _, healthy_root) = workspace(&host, "Corrupt database");
    call(
        &host,
        "mail_send",
        &healthy_id,
        json!({"sender_id":"owner", "destination":{"kind":"channel", "id":"general"}, "body":"still readable", "request_id":"readable-mail"}),
    );
    register(&host, &healthy_id, "alice");
    attach_state(&host, &healthy_id);
    let db = healthy_root.join(".orchard/plugins.sqlite");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    fs::write(&db, b"not sqlite").unwrap();
    assert_eq!(
        call(
            &host,
            "mail_history",
            &healthy_id,
            json!({"channel_id":"general"})
        )["messages"][0]["body"],
        "still readable"
    );
    let snapshot = call(&host, "workspace_snapshot", &healthy_id, json!({}));
    assert_eq!(snapshot["mail"]["history"][0]["body"], "still readable");
    assert!(
        !snapshot["errors"].as_array().unwrap().is_empty(),
        "snapshot must report the unavailable plugin store without hiding base data"
    );
    let corrupt_error = error(
        &host,
        "state_define",
        &healthy_id,
        json!({"participant_id":"alice", "request_id":"corrupt-write", "definition":definition("corrupt", 1)}),
    );
    assert!(
        corrupt_error.contains("database"),
        "unexpected corrupt-store error: {corrupt_error}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let (directory_id, _, directory_root) = workspace(&host, "Symlink directory");
        symlink(
            temp.path().join("outside-orchard"),
            directory_root.join(".orchard"),
        )
        .unwrap();
        assert!(error(&host, "plugin_list", &directory_id, json!({}))
            .contains("directory must not be a symlink"));
        let (symlink_id, _, symlink_root) = workspace(&host, "Symlink database");
        let directory = symlink_root.join(".orchard");
        fs::create_dir_all(&directory).unwrap();
        let target = temp.path().join("elsewhere.sqlite");
        symlink(&target, directory.join("plugins.sqlite")).unwrap();
        assert!(
            error(&host, "plugin_list", &symlink_id, json!({})).contains("must not be symlinks")
        );
        assert!(
            !target.exists(),
            "a dangling database symlink must not be followed or created"
        );
        let (journal_id, _, journal_root) = workspace(&host, "Symlink journal");
        let journal_directory = journal_root.join(".orchard");
        fs::create_dir_all(&journal_directory).unwrap();
        Connection::open(journal_directory.join("plugins.sqlite")).unwrap();
        let journal_target = temp.path().join("elsewhere-wal");
        symlink(
            &journal_target,
            journal_directory.join("plugins.sqlite-wal"),
        )
        .unwrap();
        assert!(
            error(&host, "plugin_list", &journal_id, json!({})).contains("must not be symlinks")
        );
        assert!(
            !journal_target.exists(),
            "a dangling journal symlink must not be followed"
        );
    }
    let _ = root; // root demonstrates the workspace-local fixture is intentionally owned.
}

#[test]
fn unsupported_plugin_database_version_is_rejected_without_initializing_schema() {
    let temp = TempDir::new().unwrap();
    let host = new_host(&temp);
    let (workspace_id, _, root) = workspace(&host, "Unsupported plugin database");
    let directory = root.join(".orchard");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("plugins.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=99").unwrap();
    drop(connection);
    assert!(error(&host, "plugin_list", &workspace_id, json!({}))
        .contains("unsupported workspace plugin database version 99"));
    let connection = Connection::open(path).unwrap();
    let tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0, "a future database version must remain untouched");
}
