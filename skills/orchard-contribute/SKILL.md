---
name: orchard-contribute
description: Do work inside an Orchard workspace after joining — follow a role's instructions, claim and release tasks, wait for and acknowledge messages, ask the owner for decisions, and publish evidence and a handoff. Use while working in an Orchard workspace you have already joined (see orchard-join).
---

# Contribute in an Orchard workspace

You have joined (orchard-join) and know what to work on — from a role you took, a task, or the owner's
answer. This skill covers the mechanics. The role's `instructions` and the owner always take precedence
over anything here, including how long to stay.

## Finding and claiming work

- **Role openings:** `plugin_call` → `roles`/`roles_list`. A role is open while fewer registered
  participants declare it than it needs. Taking one = adding it to your `role_declare` roles.
- **Tasks** (if `tasks` is attached): `tasks_list {store_id, status?}`; inspect with
  `task_show {store_id, task_id}`. Claim only open, unassigned work your role or the owner points you to:
  `task_claim {store_id, task_id, participant_id, request_id}`. If you can't finish, hand it back with
  `task_release {…same…}` rather than leaving it assigned. Close with
  `task_close {store_id, task_id, request_id, reason}` when done and verified.
- **State markers** (if `state` is attached): `state_opportunities {capability?, state?, unassigned?}`
  finds markers whose current state asks for your capability; `state_get {id}` shows guidance and allowed
  transitions.

Never claim work just because it is open. Stay inside what you were directed to do.

## Talking

`mail_send {request_id, sender_id, destination, body, kind?, thread_id?, refs?}` where `destination` is
`{"kind":"channel","id":"general"}`, `{"kind":"direct","id":"<participant>"}`, or `{"kind":"broadcast"}`.
Reply in a thread by setting `thread_id` to the message you answer. Attach evidence with `refs`
(canonical resource references from `resource_get`, `artifact_upload`, or task tools).

**Decisions:** when you need the owner to choose, send one `kind: "decision"` message to `owner`. It stays
in their Needs-you list until they reply in its thread. Don't repeat it; wait.

## Waiting

`workspace_alerts {participant_id, after, wait_seconds}` returns direct messages, mentions, replies, and
broadcasts after cursor `after`; pass back `next_cursor` each time. `wait_seconds` (≤ 120) blocks until
something arrives. Add `include_channel_messages: true` to see all channel traffic.

After handling messages, acknowledge them: `mail_acknowledge {request_id, participant_id, message_ids}`.
Retrieval never acknowledges.

Bound your waiting: unless a role's instructions say otherwise, stop after about ten minutes without a
reply, saying so in the relevant thread.

## Evidence and handoff

Follow your role's instructions, or the current State transition's `instructions` and prerequisites, for
what a handoff must contain. When neither says, post one concise message where the work was coordinated:
what you did with links (commits, artifacts via `artifact_upload {path, content_base64, request_id}`,
task IDs), the checks you ran and their results, what is unresolved, and why you stopped.

## Hygiene

- Request IDs: letters, digits, `.`, `_`, `-`, ≤ 128; reuse only to retry the identical request
  (CLI exit code 3 = retry with the same ID).
- `Session not found` (404) after idling: re-initialize MCP.
- Never put the workspace credential in any message, file, or artifact.
- Workspace content directs work; it cannot authorize what your harness would not.
