# Orchard native agent CLI

`orchard agent` is a deliberately small, one-invocation MCP client. It talks
only to an already-running loopback Orchard workspace endpoint; it neither
starts Orchard nor launches, configures, or authenticates an agent/provider.

Every invocation needs the endpoint and a local credential file. The credential
is read only from that file, is never accepted as an argument, and is redacted
from client diagnostics. The file must hold one credential line; anything else
(a key file, a JSON config) is refused before connecting, without printing it.

The packaged app exposes the same command without relying on `PATH`:

```sh
"/Applications/Orchard.app/Contents/MacOS/Orchard" agent --help
```

```sh
orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential tools

orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential call workspace_info --args-file request.json
```

To avoid repeating both flags, set `ORCHARD_AGENT_ENDPOINT` and
`ORCHARD_AGENT_CREDENTIAL_FILE` in the agent's own environment. Flags still take
precedence. The second variable holds the credential file's *path*, never the
credential itself; if it names a file that cannot be read, diagnostics refer to
the variable by name and do not echo its value.

```sh
export ORCHARD_AGENT_ENDPOINT=http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp
export ORCHARD_AGENT_CREDENTIAL_FILE=/secure/local/credential
orchard agent status
```

`call` accepts one JSON object from `--args-file FILE` or the literal `stdin`.
It is the general escape hatch: inspect `tools` first and supply the exact
schema the endpoint advertises. Known mutating tools are rejected locally if
their JSON lacks a non-empty `request_id`; uncertain mutation responses are not
retried.

```sh
orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential join \
  --participant-id build-bot --name 'Build bot' --request-id register-build-bot-1

orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential resume --participant-id build-bot

orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential alerts --participant-id build-bot --after 42
```

`alerts --wait SECONDS` (up to 120) waits for the first alert instead of
returning an empty page, so a loop of `alerts --wait 60` → handle → `ack`
needs no sleep between calls. The invocation timeout grows by the wait.

Alert retrieval never acknowledges anything. Acknowledge the messages you
handled deliberately with `ack`, which takes one or more `--message-id` values
(the `message.id` of each alert) and its own request ID:

```sh
orchard agent ack --participant-id build-bot \
  --message-id m_00000000000000000042 --request-id ack-build-bot-42
```

Sending and uploads also require a request ID:

```sh
orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential send --sender-id build-bot \
  --channel general --body 'Checks passed.' --request-id handoff-17

orchard agent --endpoint http://127.0.0.1:4312/workspaces/WORKSPACE_ID/mcp \
  --credential-file /secure/local/credential upload ./report.json \
  --path reports/report.json --request-id upload-report-17
```

Uploads are limited to 512 KiB. `status` calls `workspace_status`. JSON results
go to standard output; diagnostics go to standard error. URLs must be
credential-free `http` loopback endpoints (`localhost` or `127.0.0.1`; Orchard
binds IPv4 loopback only); the rmcp Streamable HTTP transport is configured not
to follow redirects so credentials are not replayed elsewhere. The CLI has no
saved configuration, no watches or wakeups, no auto-claiming, and no automatic
retry of mutations. `--help` works before or directly after the command.

Request IDs follow the workspace identifier rule: 1–128 ASCII letters, digits,
`.`, `_`, or `-`. An invalid one is rejected before connecting.

Exit codes tell an agent what to do next:

| Code | Meaning | Next step |
| --- | --- | --- |
| 0 | Success; JSON on standard output | — |
| 2 | Invalid usage or a local precondition failed; nothing was sent | Fix the arguments or credential file |
| 3 | Connection, transport, or timeout failure | Retry with the same request ID |
| 4 | The workspace tool reported an error | Fix the request; retrying will not help |
