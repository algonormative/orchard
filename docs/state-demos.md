# State demos

`scripts/state-demos.mjs` creates three compact local workspaces that make
State useful to an agent reader: a pinned Markdown artifact provides working
context, Tasks name bounded work, and a State marker records one meaningful
next transition with durable history and canonical references.

The actors, comments, alternatives, review, approval, gate clearance, and
release are all **scripted demo fixtures**. No real independent review,
creative approval, release approval, or deployment occurs. State's browser
viewer is read-only; the script (or an authenticated agent/API client) moves
markers.

## Run

Start an Orchard server with isolated data, then use the exact loopback URL:

```sh
node scripts/state-demos.mjs seed --url http://127.0.0.1:64652
node scripts/state-demos.mjs step --demo proposal --url http://127.0.0.1:64652
node scripts/state-demos.mjs status --url http://127.0.0.1:64652
```

The runner rejects non-loopback URLs. It creates a same-origin browser session
with `POST /api/session`, then calls `/api/call`; it never writes a database,
uses provider APIs, or prints credentials. Its small, credential-free manifest
is `/private/tmp/orchard-state-demos.json`; pass `--manifest /private/tmp/other-demo.json`
for another isolated run. The manifest is bound to its loopback server origin,
and the runner rejects a different origin before API writes. Delete a manifest only when you
also intend to start against fresh isolated Orchard data; `workspace_create`
does not have a durable request receipt, so the runner persists its returned ID
before doing any further work. It first records a creation intent; if the
create response is lost, it stops rather than retrying. Inspect `workspace_list`
and repair the manifest with the returned workspace/store IDs before resuming.
The runner atomically replaces its manifest, but use one process per manifest
path at a time.

`seed` is safe to rerun after the manifest exists. All later records use
deterministic request IDs, so the host replays their durable receipts. `step`
advances exactly one next transition for each selected demo; rerunning it moves
to the following bounded transition rather than creating another marker.
`status` is read-only: it requires an existing manifest and reads the current
marker, history count, and canonical State link. `retry` repeats the exact last
saved State transition request and therefore replays its receipt without adding
history; it exists for lost-response verification.
If another agent advances a marker, stop using the scripted runner for that
marker and continue through the agent/API flow; the runner rejects a marker
whose current state or revision no longer matches its saved scripted progress.

## The three workspaces

- **Proposal review** starts in `draft`; its bounded cycle is review → rework
  → review. Its marker is task-backed, so the review cycle does not imply that
  a first-draft artifact approves a later revision. History references the
  pinned first draft, then a separately pinned revised draft; a scripted
  channel comment makes the requested rework visible.
- **Release readiness** starts in `planning`; its seeded path opens a
  task-linked gate, then blocks on it. A later transition can clear that gate
  only as a scripted simulation, followed by a simulated release—never a
  deployment.
- **Creative brief** starts in `briefing`; its pinned artifact contains two
  alternatives, then records a scripted selection and handoff linked to a task.

Run `seed`, then one `step` per workspace for a compact at-different-stages
overview. To prove an exact retry does not duplicate history, run `retry` after
a completed `step` and compare `status`: marker revision and history count stay
unchanged. The runner saves the exact transition arguments before calling the
host, so an interrupted response can replay the same receipt on the next
`step`. Normal completed `step` runs intentionally advance to their next
declared edge.
