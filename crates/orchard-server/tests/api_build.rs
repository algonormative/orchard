use orchard_workspace_host::WorkspaceHost;
use std::{
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::Arc,
};
use tempfile::TempDir;

fn packaged_br() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/bin/br")
        .canonicalize()
        .unwrap()
}

/// Sends a raw request so the Host and Origin headers are exactly what the test says.
fn status(endpoint: &str, path: &str, host: &str, origin: Option<&str>) -> u16 {
    let mut stream = TcpStream::connect(endpoint).unwrap();
    let origin = origin
        .map(|origin| format!("Origin: {origin}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\n{origin}Connection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap()
}

#[test]
fn build_identity_requires_the_exact_loopback_host_and_origin() {
    let temporary = TempDir::new().unwrap();
    let host = Arc::new(WorkspaceHost::open(temporary.path().join("data"), packaged_br()).unwrap());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let server = runtime
        .block_on(
            host.clone()
                .start_server_with_ui(orchard_server::ui_router()),
        )
        .unwrap();
    let endpoint = server.endpoint().to_string();
    let same_origin = format!("http://{endpoint}");

    assert_eq!(status(&endpoint, "/api/build", &endpoint, None), 200);
    assert_eq!(
        status(&endpoint, "/api/build", &endpoint, Some(&same_origin)),
        200
    );
    assert_eq!(status(&endpoint, "/api/build", "evil.example", None), 403);
    assert_eq!(
        status(
            &endpoint,
            "/api/build",
            &endpoint,
            Some("http://evil.example")
        ),
        403
    );
    // Static assets stay reachable as before; only /api reads are guarded.
    assert_eq!(status(&endpoint, "/", "evil.example", None), 200);

    runtime.block_on(server.shutdown()).unwrap();
}
