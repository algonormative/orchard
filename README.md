# Orchard

Orchard is a local workspace for people and their already-running agents. Read
conversations, work through tasks, and browse project files in one browser UI.
The macOS menu bar app hosts the workspace and gives each workspace a connection
point for agents. Orchard does not launch agents or sign in to their providers.

Agents can discover bundled capabilities and attach the optional ones while
remaining in their own harnesses. Core and Chat are required. Tasks is attached
by default and can be toggled. State is optional: it provides declarative
definitions, durable markers, and explicit transitions. Orchard supplies no
execution scheduler and does not yet download plugins. See
[docs/plugins.md](docs/plugins.md), [docs/handoffs.md](docs/handoffs.md),
[docs/agent-cli.md](docs/agent-cli.md), and
[docs/build-identity.md](docs/build-identity.md).

[Website](https://algonormative.github.io/orchard-workspace/) ·
[Releases](https://github.com/algonormative/orchard-workspace/releases) ·
[Source](https://github.com/algonormative/orchard-workspace)

## Install on macOS

Orchard supports Apple Silicon Macs running macOS 13 or newer.

1. Download `Orchard-<version>-macos-arm64.zip` from the
   [latest GitHub Release](https://github.com/algonormative/orchard-workspace/releases/latest).
2. Optionally download its `.sha256` file and verify the ZIP with
   `shasum -a 256 -c Orchard-<version>-macos-arm64.zip.sha256`.
3. Open the ZIP and drag `Orchard.app` to Applications.
4. Open Orchard from Applications. It appears in the menu bar rather than the
   Dock. Choose **Create a Workspace…** from its menu to begin.

In the workspace, use Settings to copy the joining prompt or connection details
for an agent you already run. Your agent's own harness handles its MCP setup,
identity, permissions, and provider authentication. Orchard stores workspace
data locally in `~/Library/Application Support/Orchard`; attached Git
repositories stay at their existing paths. You can check for a newer version
from **Check for Updates…** in the menu; **About Orchard** shows which build
you are running. Updates are manual: Orchard opens the
release page and does not download or install an update for you.

Release ZIPs are signed with a Developer ID certificate, notarized by Apple,
and carry a stapled notarization ticket.

## Development

Build the browser UI before compiling Rust so the server can embed `ui/dist`:

```sh
npm --prefix ui ci
npm --prefix ui run build
cargo build -p orchard-server --locked
mkdir -p target/debug/resources/bin
cp resources/bin/br target/debug/resources/bin/br
target/debug/orchard --data-dir /tmp/orchard-data
```

The launcher prints the loopback URL. Opening that local URL creates an
HTTP-only browser session automatically after exact loopback Host and Origin
checks; there is no access key to copy into the UI. `--port PORT` deliberately
replaces the persisted loopback port; without it, Orchard reuses the last port
or assigns one on first start.

The finished package has no runtime dependency on Node, Python, Git, a provider
CLI, or `PATH`. Rust/Cargo 1.94.0 is pinned in `rust-toolchain.toml`. The approved
`br` executable is resolved relative to `orchard` as `resources/bin/br`.

## Release packages

To build an unsigned Apple Silicon app locally:

```sh
CARGO_TARGET_DIR=/private/tmp/orchard-ux-target \
  CARGO_INCREMENTAL=0 \
  ORCHARD_VERSION=0.2.0 scripts/package-macos-app.sh
```

Signing, notarization, GitHub Release setup, and the release checklist are
documented in [docs/packaging.md](docs/packaging.md).

The server-only package remains available for development and headless use:

```sh
scripts/package-server.sh
```

The script builds `dist/orchard-server/` with the executable, approved task
binary, MIT license, and third-party notices. It rebuilds the UI and verifies
the complete vendored Orchard Mail file set and hashes before compiling. The
server package is an unsigned local build artifact.

Launch a portable package with an external data directory:

```sh
./orchard --data-dir "$HOME/Library/Application Support/Orchard"
```

The bundled Beads source is the reviewed snapshot recorded in
`vendor/beads-rust/ORCHARD_SOURCE.txt`. Its approved commit is
`beff256b491e20508eab0319b23547ff145cfd04`; later upstream sources with
restrictive riders are intentionally excluded. Orchard Mail is pinned at local
commit `4ea4d304b4c12079cf442af36b2242e45887e10f` with no remote repository claim.

See [docs/backend.md](docs/backend.md), [docs/ux.md](docs/ux.md), and
[docs/packaging.md](docs/packaging.md).
