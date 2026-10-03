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
different identity.

`dirty` means tracked files differ from `HEAD`, staged or not, matching
`git describe --dirty`; untracked files do not count. The build script runs Git
with `--no-optional-locks` so it never touches the repository it describes, and
watches only files that exist: the embedded distribution, the desktop manifest,
`HEAD`, the current branch ref, `index`, `packed-refs` when present, and each
tracked file. Edits, staging, commits, and branch switches refresh the identity,
while repeated builds of an unchanged tree do not rerun the script. Outside a
Git checkout no Git paths are watched.

Settings fetches the endpoint once when opened and renders it with the shared
copyable code block. A failed or malformed response shows an unavailable
identity without polling or changing application chrome.

The menu bar offers the same identity natively. **About Orchard** opens the
system About panel: the app version, the 12-character revision with its
clean, dirty, or unknown state, the server version, and the full UI hash.
**Build Identity…** shows that identity as text, with Copy identity and Open
notices actions. Both read the identity embedded at build time.
