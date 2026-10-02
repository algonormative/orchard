use base64::Engine;
use rmcp::{
    model::CallToolRequestParams,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::OsString};
use std::{fs, path::PathBuf, time::Duration};
use url::{Host, Url};

const INVOCATION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_UPLOAD_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionOptions {
    pub endpoint: String,
    pub credential_file: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Tools,
    Call {
        tool: String,
        arguments: Value,
    },
    Register {
        participant_id: String,
        name: String,
        request_id: String,
    },
    Resume {
        participant_id: String,
    },
    Alerts {
        participant_id: String,
        after: u64,
    },
    Send {
        sender_id: String,
        destination: Value,
        body: String,
        request_id: String,
    },
    Upload {
        local_file: PathBuf,
        path: String,
        request_id: String,
    },
    Status,
}

impl Request {
    /// Checks local invariants before credentials are read or a network session is opened.
    pub fn preflight(&self) -> Result<(), String> {
        match self {
            Self::Call { tool, arguments } => {
                required_text(tool, "tool")?;
                if !arguments.is_object() {
                    return Err("tool arguments must be a JSON object".to_owned());
                }
                if mutation_requires_request_id(tool) {
                    require_request_id(arguments)?;
                }
            }
            Self::Register {
                participant_id,
                name,
                request_id,
            } => {
                required_text(participant_id, "participant ID")?;
                required_text(name, "name")?;
                required_text(request_id, "request ID")?;
            }
            Self::Resume { participant_id } | Self::Alerts { participant_id, .. } => {
                required_text(participant_id, "participant ID")?;
            }
            Self::Send {
                sender_id,
                destination,
                body,
                request_id,
            } => {
                required_text(sender_id, "sender ID")?;
                required_text(body, "message body")?;
                required_text(request_id, "request ID")?;
                if !destination.is_object() {
                    return Err(
                        "message destination must be a channel or direct participant".to_owned(),
                    );
                }
            }
            Self::Upload {
                local_file,
                path,
                request_id,
            } => {
                required_text(path, "workspace path")?;
                required_text(request_id, "request ID")?;
                let metadata = fs::metadata(local_file).map_err(|error| {
                    format!(
                        "cannot inspect upload file {}: {error}",
                        local_file.display()
                    )
                })?;
                if !metadata.is_file() {
                    return Err("upload source must be a regular file".to_owned());
                }
                if metadata.len() > MAX_UPLOAD_BYTES {
                    return Err("upload source exceeds the 512 KiB limit".to_owned());
                }
            }
            Self::Tools | Self::Status => {}
        }
        Ok(())
    }
}

pub async fn execute(connection: &ConnectionOptions, request: Request) -> Result<Value, String> {
    request.preflight()?;
    let endpoint = loopback_endpoint(&connection.endpoint)?;
    let credential = read_credential(&connection.credential_file)?;
    let mut client = tokio::time::timeout(INVOCATION_TIMEOUT, async {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| format!("cannot configure loopback HTTP client: {error}"))?;
        let transport = StreamableHttpClientTransport::with_client(
            http,
            StreamableHttpClientTransportConfig::with_uri(endpoint.as_str())
                .auth_header(credential.clone())
                .reinit_on_expired_session(false),
        );
        ().serve(transport)
            .await
            .map_err(|error| redact(&error.to_string(), &credential))
    })
    .await
    .map_err(|_| "MCP session setup timed out after 15 seconds".to_owned())??;
    let operation = tokio::time::timeout(INVOCATION_TIMEOUT, perform(&client, request))
        .await
        .map_err(|_| "MCP invocation timed out after 15 seconds".to_owned())?;
    // A completed operation remains successful even when best-effort session cleanup fails.
    let _ = tokio::time::timeout(Duration::from_secs(1), client.close()).await;
    operation.map_err(|error| redact(&error, &credential))
}

/// Parses and runs the packaged `orchard agent` command without starting a server.
pub async fn run_cli(arguments: Vec<OsString>) -> Result<(), String> {
    let mut values = arguments.into_iter();
    let mut endpoint = None;
    let mut credential_file = None;
    let command = loop {
        match values.next().as_ref().and_then(|value| value.to_str()) {
            Some("--endpoint" | "--url") => {
                let value = next_text(&mut values, "--endpoint requires a URL")?;
                if endpoint.replace(value).is_some() {
                    return Err("--endpoint may be specified only once".to_owned());
                }
            }
            Some("--credential-file") => {
                let value =
                    PathBuf::from(next_os(&mut values, "--credential-file requires a path")?);
                if credential_file.replace(value).is_some() {
                    return Err("--credential-file may be specified only once".to_owned());
                }
            }
            Some("-h" | "--help") => {
                println!("{}", usage());
                return Ok(());
            }
            Some(command) => break command.to_owned(),
            None => return Err(usage().to_owned()),
        }
    };
    let connection = ConnectionOptions {
        endpoint: endpoint.ok_or_else(|| format!("--endpoint is required\n{}", usage()))?,
        credential_file: credential_file
            .ok_or_else(|| format!("--credential-file is required\n{}", usage()))?,
    };
    let request = parse_command(&command, values.collect())?;
    let result = execute(&connection, request).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|error| error.to_string())?
    );
    Ok(())
}

pub fn usage() -> &'static str {
    "usage: Orchard agent --endpoint URL --credential-file FILE COMMAND\n\ncommands: tools | call TOOL (--args-file FILE | stdin) | join --participant-id ID --name NAME --request-id ID | resume --participant-id ID | alerts --participant-id ID --after CURSOR | send --sender-id ID (--channel ID | --direct ID) --body TEXT --request-id ID | upload FILE --path PATH --request-id ID | status"
}
fn parse_command(command: &str, arguments: Vec<OsString>) -> Result<Request, String> {
    match command {
        "tools" => none(arguments, Request::Tools),
        "status" => none(arguments, Request::Status),
        "call" => {
            let mut it = arguments.into_iter();
            let tool = next_text(&mut it, "call requires TOOL")?;
            let source = next_text(&mut it, "call requires --args-file FILE or stdin")?;
            let text = if source == "stdin" {
                if it.next().is_some() {
                    return Err("call stdin accepts no additional arguments".into());
                };
                std::io::read_to_string(std::io::stdin()).map_err(|e| e.to_string())?
            } else if source == "--args-file" {
                let path = next_os(&mut it, "--args-file requires a path")?;
                if it.next().is_some() {
                    return Err("call accepts exactly one argument source".into());
                };
                fs::read_to_string(path).map_err(|e| format!("cannot read arguments file: {e}"))?
            } else {
                return Err("call requires --args-file FILE or stdin".into());
            };
            Ok(Request::Call {
                tool,
                arguments: serde_json::from_str(&text)
                    .map_err(|e| format!("arguments must be a JSON object: {e}"))?,
            })
        }
        "join" | "register" => {
            let v = named(arguments, &["--participant-id", "--name", "--request-id"])?;
            Ok(Request::Register {
                participant_id: need(&v, "--participant-id")?,
                name: need(&v, "--name")?,
                request_id: need(&v, "--request-id")?,
            })
        }
        "resume" => {
            let v = named(arguments, &["--participant-id"])?;
            Ok(Request::Resume {
                participant_id: need(&v, "--participant-id")?,
            })
        }
        "alerts" => {
            let v = named(arguments, &["--participant-id", "--after"])?;
            Ok(Request::Alerts {
                participant_id: need(&v, "--participant-id")?,
                after: need(&v, "--after")?
                    .parse()
                    .map_err(|_| "--after must be a non-negative integer")?,
            })
        }
        "send" => {
            let v = named(
                arguments,
                &[
                    "--sender-id",
                    "--channel",
                    "--direct",
                    "--body",
                    "--request-id",
                ],
            )?;
            let destination = match (v.get("--channel"), v.get("--direct")) {
                (Some(id), None) => json!({"kind":"channel","id":id}),
                (None, Some(id)) => json!({"kind":"direct","id":id}),
                _ => return Err("send requires exactly one of --channel or --direct".into()),
            };
            Ok(Request::Send {
                sender_id: need(&v, "--sender-id")?,
                destination,
                body: need(&v, "--body")?,
                request_id: need(&v, "--request-id")?,
            })
        }
        "upload" => {
            let mut it = arguments.into_iter();
            let local_file = PathBuf::from(next_os(&mut it, "upload requires FILE")?);
            let v = named(it.collect(), &["--path", "--request-id"])?;
            Ok(Request::Upload {
                local_file,
                path: need(&v, "--path")?,
                request_id: need(&v, "--request-id")?,
            })
        }
        _ => Err(format!("unknown agent command {command:?}\n{}", usage())),
    }
}
fn none(arguments: Vec<OsString>, request: Request) -> Result<Request, String> {
    if arguments.is_empty() {
        Ok(request)
    } else {
        Err("this agent command accepts no arguments".into())
    }
}
fn named(arguments: Vec<OsString>, allowed: &[&str]) -> Result<BTreeMap<String, String>, String> {
    let mut it = arguments.into_iter();
    let mut out = BTreeMap::new();
    while let Some(k) = it.next() {
        let k = k
            .into_string()
            .map_err(|_| "agent arguments must be valid UTF-8")?;
        if !allowed.contains(&k.as_str()) {
            return Err(format!("unknown agent argument {k:?}"));
        }
        let v = next_text(&mut it, &format!("{k} requires a value"))?;
        if out.insert(k.clone(), v).is_some() {
            return Err(format!("{k} may be specified only once"));
        }
    }
    Ok(out)
}
fn need(values: &BTreeMap<String, String>, key: &str) -> Result<String, String> {
    values
        .get(key)
        .cloned()
        .ok_or_else(|| format!("{key} is required"))
}
fn next_text(it: &mut impl Iterator<Item = OsString>, error: &str) -> Result<String, String> {
    next_os(it, error)?
        .into_string()
        .map_err(|_| "agent arguments must be valid UTF-8".into())
}
fn next_os(it: &mut impl Iterator<Item = OsString>, error: &str) -> Result<OsString, String> {
    it.next().ok_or_else(|| error.into())
}

async fn perform(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    request: Request,
) -> Result<Value, String> {
    match request {
        Request::Tools => serde_json::to_value(client.list_all_tools().await.map_err(|error| error.to_string())?)
            .map_err(|error| format!("cannot encode tool schemas: {error}")),
        Request::Call { tool, arguments } => call(client, &tool, arguments).await,
        Request::Register { participant_id, name, request_id } => {
            call(client, "mail_register", json!({"participant_id": participant_id, "name": name, "request_id": request_id})).await
        }
        Request::Resume { participant_id } => call(client, "mail_resume", json!({"participant_id": participant_id})).await,
        Request::Alerts { participant_id, after } => {
            call(client, "workspace_alerts", json!({"participant_id": participant_id, "after": after})).await
        }
        Request::Send { sender_id, destination, body, request_id } => {
            call(client, "mail_send", json!({"sender_id": sender_id, "destination": destination, "body": body, "request_id": request_id})).await
        }
        Request::Upload { local_file, path, request_id } => {
            let content = fs::read(&local_file).map_err(|error| format!("cannot read upload file {}: {error}", local_file.display()))?;
            if content.len() as u64 > MAX_UPLOAD_BYTES {
                return Err("upload source exceeds the 512 KiB limit".to_owned());
            }
            call(client, "artifact_upload", json!({"path": path, "content_base64": base64::engine::general_purpose::STANDARD.encode(content), "request_id": request_id})).await
        }
        Request::Status => call(client, "workspace_status", json!({})).await,
    }
}

async fn call(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let arguments = arguments
        .as_object()
        .cloned()
        .ok_or_else(|| "tool arguments must be a JSON object".to_owned())?;
    let result = client
        .call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments))
        .await
        .map_err(|error| error.to_string())?;
    if result.is_error == Some(true) {
        let detail = result
            .structured_content
            .or_else(|| serde_json::to_value(&result.content).ok())
            .unwrap_or(Value::Null);
        return Err(format!("MCP tool {name:?} returned an error: {detail}"));
    }
    result
        .structured_content
        .ok_or_else(|| format!("MCP tool {name:?} returned no structured JSON result"))
}

pub fn loopback_endpoint(input: &str) -> Result<Url, String> {
    let url = Url::parse(input)
        .map_err(|_| "workspace MCP URL must be an absolute loopback http URL".to_owned())?;
    if url.scheme() != "http"
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "workspace MCP URL must be a credential-free loopback http endpoint".to_owned(),
        );
    }
    let is_loopback = match url.host() {
        Some(Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if !is_loopback {
        return Err("workspace MCP URL must target localhost, 127.0.0.1, or ::1".to_owned());
    }
    let mut parts = url
        .path_segments()
        .ok_or_else(|| "workspace MCP URL must have a path".to_owned())?;
    if parts.next() != Some("workspaces")
        || !parts.next().is_some_and(|id| !id.is_empty())
        || parts.next() != Some("mcp")
        || parts.next().is_some()
    {
        return Err("workspace MCP URL must be exactly /workspaces/{id}/mcp".to_owned());
    }
    Ok(url)
}

fn read_credential(path: &PathBuf) -> Result<String, String> {
    let credential = fs::read_to_string(path)
        .map_err(|error| format!("cannot read credential file {}: {error}", path.display()))?;
    let credential = credential.trim().to_owned();
    if credential.is_empty() {
        return Err("credential file is empty".to_owned());
    }
    Ok(credential)
}

fn mutation_requires_request_id(tool: &str) -> bool {
    matches!(
        tool,
        "mail_register"
            | "mail_leave"
            | "mail_channel_create"
            | "mail_send"
            | "mail_acknowledge"
            | "task_create"
            | "task_update"
            | "task_claim"
            | "task_close"
            | "artifact_upload"
            | "artifact_delete"
            | "artifact_commit"
            | "resource_link"
            | "plugin_attach"
            | "plugin_detach"
            | "state_define"
            | "state_create"
            | "state_advance"
    )
}

fn require_request_id(arguments: &Value) -> Result<(), String> {
    arguments
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "this mutation requires a non-empty request_id before connecting".to_owned()
        })?;
    Ok(())
}

fn required_text(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{field} must not be empty"))
    } else {
        Ok(())
    }
}

fn redact(message: &str, credential: &str) -> String {
    message.replace(credential, "[REDACTED]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, routing::post, Router};
    use orchard_workspace_host::WorkspaceHost;
    use std::{
        path::Path,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    use tempfile::TempDir;

    fn packaged_br() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/bin/br")
            .canonicalize()
            .unwrap()
    }

    #[test]
    fn loopback_and_credentials_are_constrained_and_redacted() {
        assert!(loopback_endpoint("http://localhost:4312/workspaces/a/mcp").is_ok());
        assert!(loopback_endpoint("http://127.0.0.1:4312/workspaces/test/mcp").is_ok());
        assert!(loopback_endpoint("http://127.0.0.1:4312/mcp").is_err());
        assert!(loopback_endpoint("https://localhost/mcp").is_err());
        assert!(loopback_endpoint("http://example.test/mcp").is_err());
        assert!(loopback_endpoint("http://secret@localhost/mcp").is_err());
        assert_eq!(
            redact("authorization failed: secret-token", "secret-token"),
            "authorization failed: [REDACTED]"
        );
    }

    #[test]
    fn mutations_fail_request_id_preflight_without_connecting() {
        let request = Request::Call {
            tool: "mail_send".to_owned(),
            arguments: json!({"sender_id":"a"}),
        };
        assert_eq!(
            request.preflight().unwrap_err(),
            "this mutation requires a non-empty request_id before connecting"
        );
    }

    #[tokio::test]
    async fn redirect_responses_are_not_followed_or_allowed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/workspaces/test/mcp",
            listener.local_addr().unwrap()
        );
        let attacker_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect_target = format!(
            "http://{}/workspaces/test/mcp",
            attacker_listener.local_addr().unwrap()
        );
        let attacker_hits = Arc::new(AtomicUsize::new(0));
        let attacker_hits_for_server = attacker_hits.clone();
        let attacker = tokio::spawn(async move {
            axum::serve(
                attacker_listener,
                Router::new().route(
                    "/workspaces/test/mcp",
                    post(move || {
                        let attacker_hits = attacker_hits_for_server.clone();
                        async move {
                            attacker_hits.fetch_add(1, Ordering::Relaxed);
                            StatusCode::INTERNAL_SERVER_ERROR
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/workspaces/test/mcp",
                    post(|| async {
                        (
                            StatusCode::TEMPORARY_REDIRECT,
                            [("location", redirect_target)],
                        )
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let temporary = TempDir::new().unwrap();
        let credential_file = temporary.path().join("credential");
        fs::write(&credential_file, "redirect-test-secret").unwrap();
        let error = execute(
            &ConnectionOptions {
                endpoint,
                credential_file,
            },
            Request::Status,
        )
        .await
        .unwrap_err();
        assert!(!error.contains("redirect-test-secret"));
        assert_eq!(attacker_hits.load(Ordering::Relaxed), 0);
        server.abort();
        attacker.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchanges_with_the_real_local_mcp_endpoint_without_provider_calls() {
        let temporary = TempDir::new().unwrap();
        let host =
            Arc::new(WorkspaceHost::open(temporary.path().join("data"), packaged_br()).unwrap());
        let created = host
            .call(
                "workspace_create",
                json!({"name":"CLI test", "owner_name":"Owner"}),
            )
            .unwrap();
        let workspace_id = created["workspace"]["id"].as_str().unwrap();
        let server = host.clone().start_server().await.unwrap();
        let token = host
            .call("connection_info", json!({"workspace_id":workspace_id}))
            .unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned();
        let credential_file = temporary.path().join("credential");
        fs::write(&credential_file, &token).unwrap();
        let connection = ConnectionOptions {
            endpoint: format!("http://{}/workspaces/{workspace_id}/mcp", server.endpoint()),
            credential_file,
        };
        let tools = execute(&connection, Request::Tools).await.unwrap();
        assert!(tools
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "workspace_status"));
        let status = execute(&connection, Request::Status).await.unwrap();
        assert_eq!(status["workspace_id"], workspace_id);
        let unauthenticated_credential_file = temporary.path().join("bad-credential");
        fs::write(&unauthenticated_credential_file, "wrong-cli-test-token").unwrap();
        let unauthenticated = ConnectionOptions {
            endpoint: connection.endpoint.clone(),
            credential_file: unauthenticated_credential_file,
        };
        assert!(!execute(&unauthenticated, Request::Status)
            .await
            .unwrap_err()
            .contains("wrong-cli-test-token"));
        server.shutdown().await.unwrap();
    }
}
