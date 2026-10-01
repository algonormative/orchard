# Local verification — 2026-09-15

This began as a local macOS Apple Silicon MVP with a Rust server and browser UI.
The current product also has a native menu bar shell. The evidence below is
historical and scoped by date. The release candidate was signed and notarized
later, and a second-Mac installation was subsequently reported successful.
Those observations do not establish the remaining integration checks.

## Independently checked

- Orchard Mail commit `4ea4d304b4c12079cf442af36b2242e45887e10f`: 17 Rust
  tests, formatting, and Clippy with warnings denied. Tests cover commit/retry
  recovery, conflicting IDs, exclusive writers, index reconstruction, immutable
  history, acknowledgments, and two local official-SDK MCP clients.
- Orchard Workspace: 17 Rust tests (14 host, 3 server), formatting, and Clippy
  with warnings denied. These cover scoped authentication and rotation, origin
  and body limits, restart, backup/restore, unavailable repositories, Beads
  compatibility, external changes, uncertain outcomes, concurrent retries,
  and a task-linked handoff between two local MCP clients.
- Final Playwright fixture: conversation polling, directed-message attribution,
  broadcast routing, task and ledger views, archive behavior, errors, and
  retention of draft/focus/scroll through refresh and reconnect. One workflow
  passed in 36.4 seconds. HTTP and Playwright were used instead of direct browser
  automation.
- HTTP task lifecycle and mail exchange against the embedded server, including
  acknowledgment and handoff references. A read-only SQLite backup of an
  existing Vault Beads store was attached as a disposable copy: all 1,631 IDs,
  titles, and statuses were preserved. The source store was not modified.
- Orchard Mail's vendored source is an exact committed snapshot, with portable
  dependency references and file-set/hash verification. Active Rust dependencies,
  the approved Beads graph, and frontend dependencies have license inventories
  and bundled notices.
- Final release-package Playwright passed owner login, workspace creation,
  task create/show/update/dependencies/close, message submission, and a rendered
  ledger evidence link. Screenshots were reviewed; the corrected store button
  wraps its complete path within the details panel. The package ran from `/tmp`
  with `PATH=/nonexistent`. Both binaries link only to macOS system libraries.

The local package is `dist/orchard-workspace-0.1.0-macos-arm64.tar.gz` with SHA-256
`5eb2c74ea4fbfb3eb3ffd8f0185909acc0193688f0ac9e1447a892395b41e8b0`.
The packaged `orchard` SHA-256 is
`b9e0a8cb6ae0bb57ad27e301ecfc7b2523785e43d63e0f936b90be5529654456`.
These identify this local artifact, not a promise of byte-identical builds on
arbitrary development machines.

The initially proposed Beads commit was rejected for restrictive dependency
license riders. The explicitly recorded replacement is
`beff256b491e20508eab0319b23547ff145cfd04`, still version 0.1.14. The approved
arm64 binary SHA-256 is
`8c1a0024e35535e49cd1ee97cd432f06e28bf623afbac7fcc6c19f7d3c249ba9`.

## Native macOS package — 2026-09-16

An unsigned Apple Silicon `Orchard.app` version 0.1.0 (about 28 MB) was built
at `/private/tmp/orchard-menu-bar/Orchard.app`. The pinned bundled `br` hash and
license-notice gates passed. Forty-six Rust workspace tests in release mode and
nine Playwright fixture tests passed.

With `PATH=/usr/bin:/bin`, the packaged app completed a live loopback smoke for
keyless workspace creation, task work, and upload. A normal macOS Quit stopped
the listener; reopening through LaunchServices retained the workspace. This
does not prove menu interactions, signing, notarization, GitHub CI, or a
clean-machine installation. Release credentials and distribution configuration
remain tracked in `vault-rhtyl`.

## Signed release candidate — 2026-09-17

GitHub Actions run `35231955551` completed the v0.1.0 release workflow from
commit `252255c`. It built, signed, notarized, and stapled the Apple Silicon app,
then created a draft GitHub Release. At the time, publication was pending the
other-Mac installation check.

The exact draft asset `Orchard-0.1.0-macos-arm64.zip` was downloaded to
`/private/tmp/orchard-release-0.1.0/`. Its SHA-256 is
`4d9ecc1e702205755b886fae07c3abb5edebb3b3e205d04b61c4953de7a21afa`, and
the published checksum file matched. On the development Mac, `codesign` deep
strict verification passed, `stapler validate` passed, and Gatekeeper accepted
the app with source `Notarized Developer ID`.

This proves the downloaded draft contains the expected signed and stapled app
and passes local Gatekeeper assessment. It does not prove installation, first
launch, menu interaction, quit, or restart on another Mac.

## Second-Mac installation — 2026-09-26

The user reported that installation works well on a second Mac and authorized
completion of the public release. The report did not specify the Mac model,
macOS version, whether it was a clean machine without development runtimes, or
which workspace, menu, quit, and restart actions were exercised. It is evidence
for a successful installation report, not a claim that each of those checks
passed.

## Public release — 2026-09-26

The v0.1.0 GitHub Release was published and the latest-release API returned it.
The public ZIP was downloaded again and matched the SHA-256 recorded above.
Deep strict code-signature verification, stapled-ticket validation, and
Gatekeeper assessment passed again for that download. This confirms the
published asset matches the checked candidate; it does not add harness or
sleep/wake evidence.

An anonymous request downloaded the release asset with HTTP 200. A live call
through `orchard_update` returned `UpToDate` for installed version 0.1.0; with
simulated installed version 0.0.0, it returned `UpdateAvailable` and the exact
Apple Silicon ZIP. Five targeted update tests passed. These checks exercise the
update library and public release endpoint, not the menu action in the app.

## Public release v0.1.1 — 2026-09-29

Tag `v0.1.1` at commit
`62678dc3a7da9c2948623b9969c7eddd5269ccab` completed GitHub Actions run
[`36604510088`](https://github.com/algonormative/orchard-workspace/actions/runs/36604510088).
The workflow passed 24 browser and 62 Rust tests, then signed, notarized,
packaged, and published the release. An anonymous download of
`Orchard-0.1.1-macos-arm64.zip` returned HTTP 200 and 16,881,208 bytes; its
SHA-256 was `e193b6c4345f13325a34027e3fe737d454d217b7835a8a303561f9cc274c8d92`.

The downloaded app passed deep-strict `codesign`, `stapler`, and `spctl`
verification with source `Notarized Developer ID`. Its desktop plist reports
version 0.1.1, its icon is `Orchard.icns`, and both binaries are arm64. Launched
from the downloaded app with isolated data and
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, the UI and live workspace loaded and a
task was created through bundled `br`, verified with headless Playwright. The
test app was then stopped.

A live update-library check against the public endpoint returned
`UpdateAvailable` with the matching 0.1.1 ZIP for installed version 0.1.0, and
`UpToDate` for installed version 0.1.1. This does not establish Finder or menu
interaction, second-Mac installation, sleep/wake behavior, or a clean-machine
runtime check.

## Local v0.2.0 preparation — 2026-09-29

An unsigned v0.2.0 `Orchard.app` was built at
`/private/tmp/orchard-v02-verified/Orchard.app`. The pinned bundled `br` and
license-notice package gates passed. The debug workspace suite passed 69 Rust
tests, and the Playwright suite passed 28 tests, including focused numeric
version and failed-fetch retry tests. The retry correction reduced the old
packaged-UI baseline of 1,298 `state_list` requests in 800 ms to one fixture
request with an honest unavailable error. A headless probe of the final package
made exactly one `state_list` request in 800 ms, showed unavailable rather than
a false empty state, and recovered on reload with review/version 1 retained.
A screenshot of that state view was visually inspected for correct margins.
Host all-target Clippy with warnings denied, formatting, and the diff check
passed. Whole-workspace Clippy remains
blocked by three pre-existing updater warnings tracked in `vault-4nv6c`.

Using isolated data at `/private/tmp/orchard-v02-probe`,
the final package ran against an old v0.1.1 fixture on port 64652 with
`PATH=/usr/bin:/bin`. The existing live chat, upload, and task smoke
passed. Six integration tests cover State same-session MCP, compare-and-swap,
detached reads, restart, and corrupt-data behavior. The packaged app
live-State smoke passed external HTTP draft-to-review, exact retry,
stale compare-and-swap rejection, retained reads while detached, rejection of detached writes, and
reattachment; the open viewer
updated without navigation or reload. The process was interrupted with SIGINT
and the same app was relaunched. A read-only restart probe of the final
package passed, reporting State review/history 2/attached true. This does not
establish native Quit or sleep/wake behavior. Default attachment behavior is
covered by the integration suite; the final live probe reused State after it
had already been attached during the initial attempt.

This v0.2.0 evidence is local preparation only: no tag, signing, notarization,
or release publication occurred. The existing public release remains v0.1.1.

## State workflow enrichment — 2026-10-01

The host added declarative State guidance, capability-filtered opportunities,
and bounded transition prerequisites. Guidance remains advisory. Advances can
require a closed qualified subject task or submitted, canonical same-workspace
`file`, `message`, or `task` evidence; file evidence is pinned to a full Git
SHA. State reports each transition as `ready`, `blocked`, or `needs_input`,
with reasons, and serializes exact request retries before fresh guard checks.

Formatting and host Clippy with warnings denied passed. The focused plugin suite
passed 7 tests; the full host result was 8 unit, 35 host, and 7 plugin tests
(50 total). The UI suite passed 30 tests in 43.7 seconds. A local debug-server
run used the bundled `br`, real API calls, and Playwright to verify an open task
blocked a transition, closing it changed the live State view to `needs_input`,
and pinned-file evidence advanced it to approved. Replaying the exact advance
after reopening the task did not append history. Opportunities excluded the
terminal marker and displayed one pending marker; the browser recorded no page
errors. The run log is
`/private/tmp/orchard-workflow-browser-root.log`, and the inspected screenshot
is `/private/tmp/orchard-workflow-opportunities.png`.

This is scripted local verification, not an independent agent-review or
provider-session run. The preview build was not signed, notarized, or released.

## Remaining integration evidence

Originally tracked in Vault epic `vault-1qnss`, release gate `vault-1qnss.7`:

1. Connect actual Claude Code and Codex sessions to the packaged server; exchange
   a task-linked request, response, acknowledgment, and handoff, then restart and
   reconnect. Local SDK clients prove transport behavior, not harness integration.
2. Exercise macOS sleep/wake with those clients connected.
3. If a clean-machine runtime-dependency claim is needed, verify it explicitly
   on a compatible Mac without development runtimes. The reported second-Mac
   installation and sanitized-PATH test do not establish that configuration.

These tests must not be silently replaced with provider calls from automated
tests. Communication backup/restore currently requires a stopped server and
restoring the same data-root path; attached repositories need separate backups.
Process-crash recovery is tested, not arbitrary power-loss durability.
