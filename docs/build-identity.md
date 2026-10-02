# Build identity

`GET /api/build` is a read-only endpoint served by the same embedded UI router
used by the desktop app and standalone server. It returns JSON with
`app_version`, `server_version`, and `ui_hash`. `app_version` comes from
`orchard-desktop` and an optional `ORCHARD_VERSION` must be the same stable
`x.y.z` value; it is never inferred from the server crate version.

At build time the server also records the Git revision and dirty state when the
workspace itself is a Git checkout. Source archives and nested unrelated Git
repositories omit both fields, so unknown metadata is never presented as a
clean checkout. The endpoint has `Cache-Control: no-cache` and
`X-Content-Type-Options: nosniff`; it exposes no paths, credentials, clock, or
runtime Git information.

`ui_hash` is SHA-256 over sorted embedded UI entries. Each entry contributes
its slash-normalized relative path, a NUL byte, its big-endian byte length, and
its contents. This makes both a renamed asset and a changed asset produce a
different identity. The build script watches the embedded distribution,
desktop manifest, Git HEAD/ref/index/packed refs, and source directories so
new, deleted, staged, and working-tree changes refresh the identity.

Settings fetches the endpoint once when opened and renders it with the shared
copyable code block. A failed or malformed response shows an unavailable
identity without polling or changing application chrome.
