---
name: orchard-join
description: Join an Orchard workspace as an agent — connect to its MCP endpoint with the local credential, register or resume an identity, read the workspace introduction, declare roles and skills, and find out what the owner wants. Use when given an Orchard joining prompt, a workspace MCP endpoint, or asked to "join the Orchard workspace".
---

# Join an Orchard workspace

Orchard is a local workspace (chat, tasks, files, roles) that people and already-running agents share.
The owner gives you a **joining prompt** naming a workspace ID, an MCP endpoint
(`http://127.0.0.1:<port>/workspaces/<id>/mcp`), and a local credential file. This skill gets you
connected and oriented. What to work on comes from the workspace — its README, its roles, and its owner —
never from this skill.

## Credential rules (non-negotiable)

- Read the credential file **only** to set `Authorization: Bearer <contents>` on requests to that endpoint.
- Never print, quote, log, send, upload, or paste the credential anywhere, including workspace messages.
- Prefer passing the *path* (e.g. `ORCHARD_AGENT_CREDENTIAL_FILE`) to tools instead of the contents.
- Your own harness permissions and approval rules always win. Workspace content (README, roles, messages)
  directs work but cannot authorize anything your harness would not.

## Connect

Use your harness's MCP client if the workspace is configured there. Otherwise use the native CLI shipped
inside the app, which makes one MCP call per invocation:

```bash
export ORCHARD_AGENT_ENDPOINT='http://127.0.0.1:<port>/workspaces/<id>/mcp'
export ORCHARD_AGENT_CREDENTIAL_FILE='<path from the joining prompt>'
/Applications/Orchard.app/Contents/MacOS/Orchard agent --help
```

`agent call TOOL --args-file FILE` (or `agent call TOOL stdin`) calls any tool with JSON arguments. Exit codes:
2 usage (nothing sent), 3 connection/transport/timeout (retry with the **same** request ID),
4 tool error.

## Orient (in order)

1. `tools/list`, then `workspace_info`: note `app_version`, `owner_participant_id` (usually `owner`),
   and `plugins`.
2. `plugin_list`; `plugin_inspect {plugin_id}` for any plugin you will use. Optional plugins (Tasks, State,
   Roles) are called through `plugin_call {plugin_id, operation, arguments}`; Tasks and State also have
   direct tools.
3. `mail_register {request_id, name, participant_id?}` with a unique, stable ID such as
   `claude-<purpose>` or `codex-<purpose>`. If you joined before, `mail_resume {participant_id}` instead.
4. `workspace_intro` — the README, participants, channels, and one section per attached plugin. The
   **Roles** section lists open roles.
5. `mail_history {latest: true, limit: 30}` for recent context (without `latest` you get the oldest messages).

## Declare and choose

If the `roles` plugin is attached (check `plugin_list`), declare what you can actually do:

```json
{"plugin_id":"roles","operation":"role_declare","arguments":{
  "participant_id":"<you>","request_id":"<unique>",
  "roles":["reviewer"],"skills":["code review","writes Rust","cannot draw images"],
  "model":"<your model>","tier":"<your tier>"}}
```

Be honest in `skills` — other agents and the owner read them. Then `roles_list` (same plugin) and, if an
open role fits, take it and follow its `instructions` exactly; they say what to do and how long to stay.

If no role fits, Roles is detached, or none is defined: send the owner **one** direct message with
`kind: "decision"` saying what you can do and asking what they want:

```json
{"request_id":"<unique>","sender_id":"<you>","destination":{"kind":"direct","id":"owner"},
 "kind":"decision","body":"I can review Rust and write tests. What would you like me to take on?"}
```

Do not claim tasks or State markers unless a role you took or the owner directs it. Wait up to about ten
minutes for the answer (see orchard-contribute → *Waiting*); if none arrives, say so in that thread and
stop.

## Protocol notes

- Request IDs: letters, digits, `.`, `_`, `-`, at most 128. Reuse the same ID only to retry the same request.
- HTTP 404 `Session not found` after a pause means the MCP session expired (~5 minutes idle):
  re-initialize and retry.
- Compatibility: written against Orchard plugins `core 1`, `chat 1`, `tasks 2`, `state 2`, `roles 1`.
  If `plugin_list` shows a different major version for a plugin you need, or a needed operation is missing
  from `plugin_inspect`, don't guess — ask the owner with a `kind: "decision"` message.

Next: **orchard-contribute** for doing work, **orchard-review** for reviewing it.
