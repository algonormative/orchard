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
/// Matches the server's `workspace_alerts` `wait_seconds` maximum.
const MAX_WAIT_SECONDS: u64 = 120;

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
        /// Seconds the server may hold the call waiting for a first alert (0 = no wait).
        wait_seconds: u64,
        /// Also report ordinary channel messages, not only directs/mentions/replies/broadcasts.
        include_channels: bool,
        /// Page size, 1-200; the server default (50) when absent.
        limit: Option<u64>,
    },
    Acknowledge {
        participant_id: String,
        message_ids: Vec<String>,
        request_id: String,
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
    /// The server-side wait this request asks for, which extends the invocation timeout.
    /// The generic `call workspace_alerts` path waits as long as `--wait` does.
    fn wait_seconds(&self) -> u64 {
        match self {
            Self::Alerts { wait_seconds, .. } => *wait_seconds,
            Self::Call { tool, arguments } if tool == "workspace_alerts" => arguments
                .get("wait_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            _ => 0,
        }
    }

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
                valid_request_id(request_id)?;
            }
            Self::Resume { participant_id } => {
                required_text(participant_id, "participant ID")?;
            }
            Self::Alerts {
                participant_id,
                wait_seconds,
                ..
            } => {
                required_text(participant_id, "participant ID")?;
                if *wait_seconds > MAX_WAIT_SECONDS {
                    return Err(format!("--wait must be at most {MAX_WAIT_SECONDS} seconds"));
                }
            }
            Self::Acknowledge {
                participant_id,
                message_ids,
                request_id,
            } => {
                required_text(participant_id, "participant ID")?;
                valid_request_id(request_id)?;
                if message_ids.is_empty() {
                    return Err("ack requires at least one --message-id".to_owned());
                }
                for message_id in message_ids {
                    required_text(message_id, "message ID")?;
                }
            }
            Self::Send {
                sender_id,
                destination,
                body,
                request_id,
            } => {
                required_text(sender_id, "sender ID")?;
                required_text(body, "message body")?;
                valid_request_id(request_id)?;
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
                valid_request_id(request_id)?;
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

/// Environment defaults for `--endpoint` and `--credential-file`; flags take precedence.
pub const ENDPOINT_ENV: &str = "ORCHARD_AGENT_ENDPOINT";
pub const CREDENTIAL_FILE_ENV: &str = "ORCHARD_AGENT_CREDENTIAL_FILE";

#[derive(Debug)]
struct ResolvedConnection {
    options: ConnectionOptions,
    /// How diagnostics refer to the credential file. An environment value is never
    /// echoed, in case a credential was pasted there instead of a path.
    credential_label: String,
}

fn resolve_connection(
    endpoint: Option<String>,
    credential_file: Option<PathBuf>,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<ResolvedConnection, String> {
    let from_env = |name: &str| env(name).filter(|value| !value.is_empty());
    let endpoint = match endpoint {
        Some(endpoint) => endpoint,
        None => from_env(ENDPOINT_ENV)
            .ok_or_else(|| format!("--endpoint (or {ENDPOINT_ENV}) is required\n{}", usage()))?
            .into_string()
            .map_err(|_| format!("{ENDPOINT_ENV} must be valid UTF-8"))?,
    };
    let (credential_file, credential_label) = match credential_file {
        Some(path) => {
            let label = path.display().to_string();
            (path, label)
        }
        None => {
            let path = from_env(CREDENTIAL_FILE_ENV).ok_or_else(|| {
                format!(
                    "--credential-file (or {CREDENTIAL_FILE_ENV}) is required\n{}",
                    usage()
                )
            })?;
            (
                PathBuf::from(path),
                format!("named by {CREDENTIAL_FILE_ENV}"),
            )
        }
    };
    Ok(ResolvedConnection {
        options: ConnectionOptions {
            endpoint,
            credential_file,
        },
        credential_label,
    })
}

/// Exit code when nothing was sent: invalid usage or a local precondition failed.
pub const EXIT_USAGE: u8 = 2;
/// Exit code for a connection, transport, or timeout failure; the request may be retried
/// with the same request ID.
pub const EXIT_CONNECTION: u8 = 3;
/// Exit code when the workspace tool itself reported an error; fix the request instead.
pub const EXIT_TOOL: u8 = 4;
/// rmcp waits up to five seconds for its session DELETE; never cut cleanup shorter.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
    pub code: u8,
    pub message: String,
}

impl CliError {
    fn usage(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_USAGE,
            message: message.into(),
        }
    }
    fn connection(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_CONNECTION,
            message: message.into(),
        }
    }
    fn tool(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_TOOL,
            message: message.into(),
        }
    }
    fn redacted(self, credential: &str) -> Self {
        Self {
            message: redact(&self.message, credential),
            ..self
        }
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub async fn execute(connection: &ConnectionOptions, request: Request) -> Result<Value, String> {
    let credential_label = connection.credential_file.display().to_string();
    execute_labeled(connection, request, &credential_label)
        .await
        .map_err(|error| error.message)
}

async fn execute_labeled(
    connection: &ConnectionOptions,
    request: Request,
    credential_label: &str,
) -> Result<Value, CliError> {
    request.preflight().map_err(CliError::usage)?;
    let endpoint = loopback_endpoint(&connection.endpoint).map_err(CliError::usage)?;
    let credential =
        read_credential(&connection.credential_file, credential_label).map_err(CliError::usage)?;
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
    .map_err(|_| CliError::connection("MCP session setup timed out after 15 seconds"))?
    .map_err(CliError::connection)?;
    // A deliberate server-side wait extends the budget; the margin still bounds a hang.
    let wait = Duration::from_secs(request.wait_seconds().min(MAX_WAIT_SECONDS));
    let operation = tokio::time::timeout(INVOCATION_TIMEOUT + wait, perform(&client, request))
        .await
        .unwrap_or_else(|_| {
            Err(CliError::connection(format!(
                "MCP invocation timed out after {} seconds",
                (INVOCATION_TIMEOUT + wait).as_secs()
            )))
        });
    // Close on every path, including a timeout, so the server can drop the session now
    // rather than at its idle eviction. A completed operation stays successful even if
    // best-effort cleanup fails.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, client.close()).await;
    operation.map_err(|error| error.redacted(&credential))
}

/// Parses and runs the packaged `orchard agent` command without starting a server.
pub async fn run_cli(arguments: Vec<OsString>) -> Result<(), CliError> {
    let Some((connection, request)) = parse_invocation(arguments).map_err(CliError::usage)? else {
        return Ok(());
    };
    let result =
        execute_labeled(&connection.options, request, &connection.credential_label).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|error| CliError::tool(error.to_string()))?
    );
    Ok(())
}

/// Returns `None` after printing help.
fn parse_invocation(
    arguments: Vec<OsString>,
) -> Result<Option<(ResolvedConnection, Request)>, String> {
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
                return Ok(None);
            }
            Some(command) => break command.to_owned(),
            None => return Err(usage().to_owned()),
        }
    };
    let arguments: Vec<OsString> = values.collect();
    // `orchard agent status --help`; only the first argument, so a message body or
    // other value that happens to read "--help" is never mistaken for it.
    if matches!(
        arguments.first().and_then(|value| value.to_str()),
        Some("-h" | "--help")
    ) {
        println!("{}", usage());
        return Ok(None);
    }
    let connection = resolve_connection(endpoint, credential_file, |name| std::env::var_os(name))?;
    let request = parse_command(&command, arguments)?;
    Ok(Some((connection, request)))
}

pub fn usage() -> &'static str {
    "usage: Orchard agent [--endpoint URL] [--credential-file FILE] COMMAND\n\n--endpoint and --credential-file default to ORCHARD_AGENT_ENDPOINT and ORCHARD_AGENT_CREDENTIAL_FILE (a path, never the credential itself); flags take precedence.\n\ncommands: tools | call TOOL (--args-file FILE | stdin) | join --participant-id ID --name NAME --request-id ID | resume --participant-id ID | alerts --participant-id ID --after CURSOR [--wait SECONDS] [--channels] [--limit N] | ack --participant-id ID --message-id ID [--message-id ID ...] --request-id ID | send --sender-id ID (--channel ID | --direct ID) --body TEXT --request-id ID | upload FILE --path PATH --request-id ID | status"
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
            // `--channels` is a bare flag; the rest are `--name value` pairs.
            let include_channels = arguments.iter().any(|argument| argument == "--channels");
            let arguments = arguments
                .into_iter()
                .filter(|argument| argument != "--channels")
                .collect();
            let v = named(
                arguments,
                &["--participant-id", "--after", "--wait", "--limit"],
            )?;
            let limit = match v.get("--limit") {
                None => None,
                Some(value) => Some(
                    value
                        .parse::<u64>()
                        .ok()
                        .filter(|limit| (1..=200).contains(limit))
                        .ok_or("--limit must be a whole number from 1 to 200")?,
                ),
            };
            let wait_seconds = match v.get("--wait") {
                None => 0,
                Some(value) => value
                    .parse::<u64>()
                    .ok()
                    .filter(|seconds| *seconds <= MAX_WAIT_SECONDS)
                    .ok_or_else(|| {
                        format!(
                            "--wait must be a whole number of seconds from 0 to {MAX_WAIT_SECONDS}"
                        )
                    })?,
            };
            Ok(Request::Alerts {
                participant_id: need(&v, "--participant-id")?,
                after: need(&v, "--after")?
                    .parse()
                    .map_err(|_| "--after must be a non-negative integer")?,
                wait_seconds,
                include_channels,
                limit,
            })
        }
        "ack" => {
            let mut it = arguments.into_iter();
            let (mut participant_id, mut request_id, mut message_ids) = (None, None, Vec::new());
            while let Some(key) = it.next() {
                let key = key
                    .into_string()
                    .map_err(|_| "agent arguments must be valid UTF-8")?;
                if !matches!(
                    key.as_str(),
                    "--participant-id" | "--message-id" | "--request-id"
                ) {
                    return Err(format!("unknown agent argument {key:?}"));
                }
                let value = next_text(&mut it, &format!("{key} requires a value"))?;
                let single = match key.as_str() {
                    "--message-id" => {
                        message_ids.push(value);
                        continue;
                    }
                    "--participant-id" => &mut participant_id,
                    _ => &mut request_id,
                };
                if single.replace(value).is_some() {
                    return Err(format!("{key} may be specified only once"));
                }
            }
            Ok(Request::Acknowledge {
                participant_id: participant_id.ok_or("--participant-id is required")?,
                message_ids,
                request_id: request_id.ok_or("--request-id is required")?,
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
) -> Result<Value, CliError> {
    match request {
        Request::Tools => serde_json::to_value(client.list_all_tools().await.map_err(|error| CliError::connection(error.to_string()))?)
            .map_err(|error| CliError::tool(format!("cannot encode tool schemas: {error}"))),
        Request::Call { tool, arguments } => call(client, &tool, arguments).await,
        Request::Register { participant_id, name, request_id } => {
            call(client, "mail_register", json!({"participant_id": participant_id, "name": name, "request_id": request_id})).await
        }
        Request::Resume { participant_id } => call(client, "mail_resume", json!({"participant_id": participant_id})).await,
        Request::Alerts { participant_id, after, wait_seconds, include_channels, limit } => {
            let mut arguments = json!({"participant_id": participant_id, "after": after});
            if include_channels {
                arguments["include_channel_messages"] = json!(true);
            }
            if let Some(limit) = limit {
                arguments["limit"] = json!(limit);
            }
            if wait_seconds > 0 {
                arguments["wait_seconds"] = json!(wait_seconds);
            }
            call(client, "workspace_alerts", arguments).await
        }
        Request::Acknowledge { participant_id, message_ids, request_id } => {
            call(client, "mail_acknowledge", json!({"participant_id": participant_id, "message_ids": message_ids, "request_id": request_id})).await
        }
        Request::Send { sender_id, destination, body, request_id } => {
            call(client, "mail_send", json!({"sender_id": sender_id, "destination": destination, "body": body, "request_id": request_id})).await
        }
        Request::Upload { local_file, path, request_id } => {
            let content = fs::read(&local_file).map_err(|error| CliError::usage(format!("cannot read upload file {}: {error}", local_file.display())))?;
            if content.len() as u64 > MAX_UPLOAD_BYTES {
                return Err(CliError::usage("upload source exceeds the 512 KiB limit"));
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
) -> Result<Value, CliError> {
    let arguments = arguments
        .as_object()
        .cloned()
        .ok_or_else(|| CliError::usage("tool arguments must be a JSON object"))?;
    let result = client
        .call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments))
        .await
        .map_err(|error| CliError::connection(error.to_string()))?;
    if result.is_error == Some(true) {
        let detail = result
            .structured_content
            .or_else(|| serde_json::to_value(&result.content).ok())
            .unwrap_or(Value::Null);
        return Err(CliError::tool(format!(
            "MCP tool {name:?} returned an error: {detail}"
        )));
    }
    result.structured_content.ok_or_else(|| {
        CliError::tool(format!(
            "MCP tool {name:?} returned no structured JSON result"
        ))
    })
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
    // Orchard binds IPv4 loopback only, so `[::1]` could never connect.
    let is_loopback = match url.host() {
        Some(Host::Ipv4(address)) => address.octets() == [127, 0, 0, 1],
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv6(_)) | None => false,
    };
    if !is_loopback {
        return Err("workspace MCP URL must target localhost or 127.0.0.1".to_owned());
    }
    let mut parts = url
        .path_segments()
        .ok_or_else(|| "workspace MCP URL must have a path".to_owned())?;
    if parts.next() != Some("workspaces")
        || parts.next().is_none_or(|id| id.is_empty())
        || parts.next() != Some("mcp")
        || parts.next().is_some()
    {
        return Err("workspace MCP URL must be exactly /workspaces/{id}/mcp".to_owned());
    }
    Ok(url)
}

fn read_credential(path: &PathBuf, label: &str) -> Result<String, String> {
    let credential = fs::read_to_string(path)
        .map_err(|error| format!("cannot read credential file {label}: {error}"))?;
    let credential = credential.trim().to_owned();
    if credential.is_empty() {
        return Err("credential file is empty".to_owned());
    }
    // Refuse anything that is not one bounded token line (an SSH key, a JSON config)
    // rather than send it as a bearer. The contents are never echoed.
    let token_shaped = (16..=1024).contains(&credential.len())
        && credential
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._~+/=-".contains(&byte));
    if !token_shaped {
        return Err(format!(
            "credential file {label} does not contain a single workspace credential line"
        ));
    }
    Ok(credential)
}

/// The server's identifier rule: 1–128 ASCII letters, digits, dot, underscore, or hyphen.
fn valid_request_id(value: &str) -> Result<(), String> {
    let valid = (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err("request ID must be 1-128 ASCII letters, digits, '.', '_' or '-'".to_owned())
    }
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
            | "task_release"
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
    let request_id = arguments
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "this mutation requires a non-empty request_id before connecting".to_owned()
        })?;
    valid_request_id(request_id)
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
        // The server binds IPv4 loopback only.
        assert!(loopback_endpoint("http://[::1]:4312/workspaces/a/mcp").is_err());
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

    #[test]
    fn request_ids_follow_the_server_identifier_rule_before_connecting() {
        let send = |request_id: &str| Request::Send {
            sender_id: "bot".to_owned(),
            destination: json!({"kind":"channel","id":"general"}),
            body: "hi".to_owned(),
            request_id: request_id.to_owned(),
        };
        assert!(send("handoff-17.v2_a").preflight().is_ok());
        assert!(send(&"a".repeat(128)).preflight().is_ok());
        for invalid in [
            "handoff 17",
            "{uuid}",
            "upload/report.json",
            &"a".repeat(129),
        ] {
            assert!(
                send(invalid)
                    .preflight()
                    .unwrap_err()
                    .contains("request ID"),
                "{invalid:?}"
            );
        }
        let call = Request::Call {
            tool: "task_claim".to_owned(),
            arguments: json!({"request_id":"claim 1"}),
        };
        assert!(call.preflight().unwrap_err().contains("request ID"));
    }

    #[tokio::test]
    async fn a_file_that_is_not_one_credential_line_is_refused_without_echoing_it() {
        let temporary = TempDir::new().unwrap();
        let key = temporary.path().join("id_ed25519");
        let secret_line = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";
        fs::write(
            &key,
            format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{secret_line}\n-----END OPENSSH PRIVATE KEY-----\n"),
        )
        .unwrap();
        let error = execute_labeled(
            &ConnectionOptions {
                endpoint: "http://127.0.0.1:9/workspaces/t/mcp".to_owned(),
                credential_file: key,
            },
            Request::Status,
            "key-file",
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, EXIT_USAGE);
        assert!(error.message.contains("single workspace credential line"));
        assert!(!error.message.contains(secret_line));
    }

    fn os_args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn flags_take_precedence_over_environment_defaults() {
        let env = |name: &str| match name {
            ENDPOINT_ENV => Some(OsString::from("http://127.0.0.1:1/workspaces/env/mcp")),
            CREDENTIAL_FILE_ENV => Some(OsString::from("/env/credential")),
            _ => None,
        };
        let defaults = resolve_connection(None, None, env).unwrap();
        assert_eq!(
            defaults.options.endpoint,
            "http://127.0.0.1:1/workspaces/env/mcp"
        );
        assert_eq!(
            defaults.options.credential_file,
            PathBuf::from("/env/credential")
        );
        assert!(!defaults.credential_label.contains("/env/credential"));

        let flags = resolve_connection(
            Some("http://127.0.0.1:2/workspaces/flag/mcp".to_owned()),
            Some(PathBuf::from("/flag/credential")),
            env,
        )
        .unwrap();
        assert_eq!(
            flags.options.endpoint,
            "http://127.0.0.1:2/workspaces/flag/mcp"
        );
        assert_eq!(
            flags.options.credential_file,
            PathBuf::from("/flag/credential")
        );
    }

    #[test]
    fn missing_connection_values_name_the_flag_and_environment_variable() {
        let unset = |_: &str| None;
        let endpoint = resolve_connection(None, Some(PathBuf::from("/c")), unset).unwrap_err();
        assert!(endpoint.contains("--endpoint") && endpoint.contains(ENDPOINT_ENV));
        let credential = resolve_connection(Some("http://x".to_owned()), None, unset).unwrap_err();
        assert!(
            credential.contains("--credential-file") && credential.contains(CREDENTIAL_FILE_ENV)
        );
        let empty = |_: &str| Some(OsString::new());
        assert!(resolve_connection(None, None, empty).is_err());
    }

    #[tokio::test]
    async fn an_environment_credential_value_is_never_echoed() {
        let mistaken = "pasted-credential-instead-of-a-path";
        let env = |name: &str| match name {
            ENDPOINT_ENV => Some(OsString::from("http://127.0.0.1:9/workspaces/t/mcp")),
            CREDENTIAL_FILE_ENV => Some(OsString::from(mistaken)),
            _ => None,
        };
        let resolved = resolve_connection(None, None, env).unwrap();
        let error = execute_labeled(
            &resolved.options,
            Request::Status,
            &resolved.credential_label,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains(CREDENTIAL_FILE_ENV), "{error}");
        assert!(!error.message.contains(mistaken), "{error}");
    }

    #[test]
    fn alerts_wait_is_optional_and_bounded() {
        let parse = |extra: &[&str]| {
            let mut values = vec!["--participant-id", "bot", "--after", "7"];
            values.extend_from_slice(extra);
            parse_command("alerts", os_args(&values))
        };
        assert_eq!(
            parse(&[]).unwrap(),
            Request::Alerts {
                participant_id: "bot".to_owned(),
                after: 7,
                wait_seconds: 0,
                include_channels: false,
                limit: None,
            }
        );
        assert_eq!(
            parse(&["--wait", "120"]).unwrap(),
            Request::Alerts {
                participant_id: "bot".to_owned(),
                after: 7,
                wait_seconds: 120,
                include_channels: false,
                limit: None,
            }
        );
        for invalid in ["121", "-1", "soon"] {
            assert!(
                parse(&["--wait", invalid]).unwrap_err().contains("--wait"),
                "{invalid}"
            );
        }
        // Library callers get a usage error, not a timeout overflow.
        let oversized = Request::Alerts {
            participant_id: "bot".to_owned(),
            after: 0,
            wait_seconds: u64::MAX,
            include_channels: false,
            limit: None,
        };
        assert!(oversized.preflight().unwrap_err().contains("--wait"));
        assert_eq!(
            oversized.wait_seconds().min(MAX_WAIT_SECONDS),
            MAX_WAIT_SECONDS
        );
        // The generic call path extends its timeout by the same wait.
        let generic = Request::Call {
            tool: "workspace_alerts".to_owned(),
            arguments: json!({"participant_id":"bot","wait_seconds":60}),
        };
        assert_eq!(generic.wait_seconds(), 60);
    }

    #[test]
    fn alerts_channels_flag_and_limit_are_parsed_and_bounded() {
        let parse = |extra: &[&str]| {
            let mut values = vec!["--participant-id", "bot", "--after", "0"];
            values.extend_from_slice(extra);
            parse_command("alerts", os_args(&values))
        };
        let Request::Alerts {
            include_channels,
            limit,
            ..
        } = parse(&["--channels", "--limit", "5"]).unwrap()
        else {
            panic!("alerts request");
        };
        assert!(include_channels);
        assert_eq!(limit, Some(5));
        let Request::Alerts {
            include_channels,
            limit,
            ..
        } = parse(&[]).unwrap()
        else {
            panic!("alerts request");
        };
        assert!(!include_channels);
        assert_eq!(limit, None);
        for invalid in ["0", "201", "many"] {
            assert!(parse(&["--limit", invalid])
                .unwrap_err()
                .contains("--limit"));
        }
    }

    #[test]
    fn ack_accepts_repeated_message_ids_and_requires_a_request_id() {
        let request = parse_command(
            "ack",
            os_args(&[
                "--participant-id",
                "bot",
                "--message-id",
                "m_1",
                "--message-id",
                "m_2",
                "--request-id",
                "ack-1",
            ]),
        )
        .unwrap();
        assert_eq!(
            request,
            Request::Acknowledge {
                participant_id: "bot".to_owned(),
                message_ids: vec!["m_1".to_owned(), "m_2".to_owned()],
                request_id: "ack-1".to_owned(),
            }
        );
        assert!(parse_command(
            "ack",
            os_args(&["--participant-id", "bot", "--message-id", "m_1"])
        )
        .unwrap_err()
        .contains("--request-id"));
        let without_messages = parse_command(
            "ack",
            os_args(&["--participant-id", "bot", "--request-id", "ack-2"]),
        )
        .unwrap();
        assert!(without_messages
            .preflight()
            .unwrap_err()
            .contains("--message-id"));
        assert!(
            parse_command("ack", os_args(&["--request-id", "a", "--request-id", "b"]))
                .unwrap_err()
                .contains("only once")
        );
        assert!(parse_command("ack", os_args(&["--participant"]))
            .unwrap_err()
            .contains("unknown agent argument"));
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
