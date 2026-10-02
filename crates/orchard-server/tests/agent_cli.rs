use orchard_workspace_host::WorkspaceHost;
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tempfile::TempDir;

fn packaged_br() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/bin/br")
        .canonicalize()
        .unwrap()
}

#[test]
fn agent_cli_prints_structured_results_and_keeps_errors_off_stdout() {
    let temporary = TempDir::new().unwrap();
    let host = Arc::new(WorkspaceHost::open(temporary.path().join("data"), packaged_br()).unwrap());
    let workspace_id = host
        .call(
            "workspace_create",
            json!({"name": "CLI regression", "owner_name": "Owner"}),
        )
        .unwrap()["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let server = runtime.block_on(host.clone().start_server()).unwrap();
    let token = host
        .call("connection_info", json!({"workspace_id": workspace_id}))
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let credential_file = temporary.path().join("credential");
    std::fs::write(&credential_file, &token).unwrap();
    let endpoint = format!("http://{}/workspaces/{workspace_id}/mcp", server.endpoint());
    let binary = env!("CARGO_BIN_EXE_orchard");

    let status = Command::new(binary)
        .args(["agent", "--endpoint", &endpoint, "--credential-file"])
        .arg(&credential_file)
        .arg("status")
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let output: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(output["workspace_id"], workspace_id);
    assert!(output.get("Ok").is_none());

    let bad_token = "agent-cli-regression-secret";
    let bad_credential_file = temporary.path().join("bad-credential");
    std::fs::write(&bad_credential_file, bad_token).unwrap();
    let rejected = Command::new(binary)
        .args(["agent", "--endpoint", &endpoint, "--credential-file"])
        .arg(&bad_credential_file)
        .arg("status")
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    assert!(!String::from_utf8_lossy(&rejected.stderr).contains(bad_token));

    let help = Command::new(binary)
        .args(["agent", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("usage: Orchard agent"));

    runtime.block_on(server.shutdown()).unwrap();
}

#[test]
fn agent_cli_exit_codes_separate_usage_connection_and_tool_failures() {
    let temporary = TempDir::new().unwrap();
    let host = Arc::new(WorkspaceHost::open(temporary.path().join("data"), packaged_br()).unwrap());
    let workspace_id = host
        .call(
            "workspace_create",
            json!({"name": "CLI exit codes", "owner_name": "Owner"}),
        )
        .unwrap()["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let server = runtime.block_on(host.clone().start_server()).unwrap();
    let token = host
        .call("connection_info", json!({"workspace_id": workspace_id}))
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let credential_file = temporary.path().join("credential");
    std::fs::write(&credential_file, &token).unwrap();
    let endpoint = format!("http://{}/workspaces/{workspace_id}/mcp", server.endpoint());
    let binary = env!("CARGO_BIN_EXE_orchard");
    let exit = |endpoint: &str, arguments: &[&str]| {
        Command::new(binary)
            .args(["agent", "--endpoint", endpoint, "--credential-file"])
            .arg(&credential_file)
            .args(arguments)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap()
            .status
            .code()
    };

    // 2: nothing was sent (invalid request ID, unknown command).
    let invalid = [
        "send",
        "--sender-id",
        "a",
        "--channel",
        "general",
        "--body",
        "x",
        "--request-id",
        "has space",
    ];
    assert_eq!(exit(&endpoint, &invalid), Some(2));
    assert_eq!(exit(&endpoint, &["frobnicate"]), Some(2));
    // 3: the endpoint could not be reached.
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let unreachable = format!(
        "http://{}/workspaces/{workspace_id}/mcp",
        closed.local_addr().unwrap()
    );
    drop(closed);
    assert_eq!(exit(&unreachable, &["status"]), Some(3));
    // 4: the workspace answered and the tool reported an error.
    let args = temporary.path().join("args.json");
    std::fs::write(&args, "{}").unwrap();
    assert_eq!(
        exit(
            &endpoint,
            &[
                "call",
                "no_such_tool",
                "--args-file",
                args.to_str().unwrap()
            ]
        ),
        Some(4)
    );
    // Help after a command prints usage and succeeds.
    assert_eq!(exit(&endpoint, &["status", "--help"]), Some(0));

    runtime.block_on(server.shutdown()).unwrap();
}

#[test]
fn agent_cli_alerts_wait_returns_when_a_message_arrives() {
    use std::time::{Duration, Instant};
    let temporary = TempDir::new().unwrap();
    let host = Arc::new(WorkspaceHost::open(temporary.path().join("data"), packaged_br()).unwrap());
    let workspace_id = host
        .call(
            "workspace_create",
            json!({"name": "CLI waits", "owner_name": "Owner"}),
        )
        .unwrap()["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let server = runtime.block_on(host.clone().start_server()).unwrap();
    let token = host
        .call("connection_info", json!({"workspace_id": workspace_id}))
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let credential_file = temporary.path().join("credential");
    std::fs::write(&credential_file, &token).unwrap();
    let endpoint = format!("http://{}/workspaces/{workspace_id}/mcp", server.endpoint());
    let binary = env!("CARGO_BIN_EXE_orchard");
    let agent = |arguments: &[&str]| {
        let mut command = Command::new(binary);
        command
            .arg("agent")
            .args(arguments)
            .env("ORCHARD_AGENT_ENDPOINT", &endpoint)
            .env("ORCHARD_AGENT_CREDENTIAL_FILE", &credential_file);
        command
    };
    for id in ["alice", "bob"] {
        let joined = agent(&[
            "join",
            "--participant-id",
            id,
            "--name",
            id,
            "--request-id",
            &format!("join-{id}"),
        ])
        .output()
        .unwrap();
        assert!(joined.status.success());
    }

    // Nothing pending: the wait runs to its deadline and returns empty.
    let started = Instant::now();
    let idle = agent(&[
        "alerts",
        "--participant-id",
        "bob",
        "--after",
        "0",
        "--wait",
        "1",
    ])
    .output()
    .unwrap();
    assert!(
        idle.status.success(),
        "{}",
        String::from_utf8_lossy(&idle.stderr)
    );
    assert!(started.elapsed() >= Duration::from_millis(900));
    let idle: serde_json::Value = serde_json::from_slice(&idle.stdout).unwrap();
    assert!(idle["alerts"].as_array().unwrap().is_empty());

    // A waiting call returns as soon as alice's direct message lands.
    let started = Instant::now();
    let waiter = agent(&[
        "alerts",
        "--participant-id",
        "bob",
        "--after",
        "0",
        "--wait",
        "60",
    ])
    .stdout(std::process::Stdio::piped())
    .spawn()
    .unwrap();
    // Send only once the CLI's call has scanned and is actually waiting on the server.
    let deadline = Instant::now() + Duration::from_secs(20);
    while host.waiting_alert_calls() == 0 {
        assert!(Instant::now() < deadline, "the CLI never started waiting");
        std::thread::sleep(Duration::from_millis(10));
    }
    let sent = agent(&[
        "send",
        "--sender-id",
        "alice",
        "--direct",
        "bob",
        "--body",
        "Your turn.",
        "--request-id",
        "send-wait-1",
    ])
    .output()
    .unwrap();
    assert!(sent.status.success());
    let waited = waiter.wait_with_output().unwrap();
    assert!(waited.status.success());
    assert!(
        started.elapsed() < Duration::from_secs(45),
        "{:?}",
        started.elapsed()
    );
    let waited: serde_json::Value = serde_json::from_slice(&waited.stdout).unwrap();
    assert_eq!(waited["alerts"][0]["message"]["body"], "Your turn.");

    // Ordinary channel posts appear only with --channels; --limit caps the page.
    let posted = agent(&[
        "send",
        "--sender-id",
        "alice",
        "--channel",
        "general",
        "--body",
        "Standup notes",
        "--request-id",
        "channel-post-1",
    ])
    .output()
    .unwrap();
    assert!(posted.status.success());
    let read = |extra: &[&str]| {
        let mut arguments = vec!["alerts", "--participant-id", "bob", "--after", "0"];
        arguments.extend_from_slice(extra);
        let output = agent(&arguments).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["alerts"]
            .as_array()
            .unwrap()
            .clone()
    };
    let has_channel_post = |alerts: &[serde_json::Value]| {
        alerts
            .iter()
            .any(|alert| alert["message"]["body"] == "Standup notes")
    };
    assert!(!has_channel_post(&read(&[])));
    assert!(has_channel_post(&read(&["--channels"])));
    assert_eq!(read(&["--channels", "--limit", "1"]).len(), 1);

    runtime.block_on(server.shutdown()).unwrap();
}

#[test]
fn agent_cli_core_loop_runs_from_environment_defaults() {
    let temporary = TempDir::new().unwrap();
    let host = Arc::new(WorkspaceHost::open(temporary.path().join("data"), packaged_br()).unwrap());
    let workspace_id = host
        .call(
            "workspace_create",
            json!({"name": "CLI core loop", "owner_name": "Owner"}),
        )
        .unwrap()["workspace"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let server = runtime.block_on(host.clone().start_server()).unwrap();
    let token = host
        .call("connection_info", json!({"workspace_id": workspace_id}))
        .unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let credential_file = temporary.path().join("credential");
    std::fs::write(&credential_file, &token).unwrap();
    let endpoint = format!("http://{}/workspaces/{workspace_id}/mcp", server.endpoint());
    let binary = env!("CARGO_BIN_EXE_orchard");
    let agent = |arguments: &[&str]| {
        let output = Command::new(binary)
            .arg("agent")
            .args(arguments)
            .env("ORCHARD_AGENT_ENDPOINT", &endpoint)
            .env("ORCHARD_AGENT_CREDENTIAL_FILE", &credential_file)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };

    agent(&[
        "join",
        "--participant-id",
        "alice",
        "--name",
        "Alice",
        "--request-id",
        "join-alice",
    ]);
    agent(&[
        "join",
        "--participant-id",
        "bob",
        "--name",
        "Bob",
        "--request-id",
        "join-bob",
    ]);
    agent(&[
        "send",
        "--sender-id",
        "alice",
        "--direct",
        "bob",
        "--body",
        "Ready for review.",
        "--request-id",
        "send-1",
    ]);
    let alerts = agent(&["alerts", "--participant-id", "bob", "--after", "0"]);
    let message_id = alerts["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|alert| alert["message"]["body"] == "Ready for review.")
        .expect("bob is alerted to alice's direct message")["message"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let acknowledged = agent(&[
        "ack",
        "--participant-id",
        "bob",
        "--message-id",
        &message_id,
        "--request-id",
        "ack-1",
    ]);
    assert_eq!(acknowledged["participant_id"], "bob");
    assert!(acknowledged.to_string().contains(&message_id));

    // An explicit flag overrides a stale environment endpoint.
    let flagged = Command::new(binary)
        .args(["agent", "--endpoint", &endpoint, "status"])
        .env(
            "ORCHARD_AGENT_ENDPOINT",
            "http://127.0.0.1:9/workspaces/stale/mcp",
        )
        .env("ORCHARD_AGENT_CREDENTIAL_FILE", &credential_file)
        .output()
        .unwrap();
    assert!(
        flagged.status.success(),
        "{}",
        String::from_utf8_lossy(&flagged.stderr)
    );

    // A credential pasted into the path variable is never echoed.
    let rejected = Command::new(binary)
        .args(["agent", "status"])
        .env("ORCHARD_AGENT_ENDPOINT", &endpoint)
        .env("ORCHARD_AGENT_CREDENTIAL_FILE", &token)
        .output()
        .unwrap();
    assert!(!rejected.status.success());
    let stderr = String::from_utf8_lossy(&rejected.stderr);
    assert!(stderr.contains("ORCHARD_AGENT_CREDENTIAL_FILE"), "{stderr}");
    assert!(
        !stderr.contains(&token) && !String::from_utf8_lossy(&rejected.stdout).contains(&token)
    );

    runtime.block_on(server.shutdown()).unwrap();
}
