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
