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
