# Orchard native agent CLI

`orchard agent` is a deliberately small, one-invocation MCP client. It talks
only to an already-running loopback Orchard workspace endpoint; it neither
starts Orchard nor launches, configures, or authenticates an agent/provider.

Every invocation needs the endpoint and a local credential file. The credential
is read only from that file, is never accepted as an argument, and is redacted
from client diagnostics.

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

Alert retrieval never acknowledges anything. Acknowledge deliberately with the
generic call and its own request ID. Sending and uploads also require one:

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
credential-free `http` loopback endpoints (`localhost`, `127.0.0.1`, or
`::1`); the rmcp Streamable HTTP transport is configured not to follow redirects
so credentials are not replayed elsewhere. The CLI has no saved configuration,
no watches or wakeups, no auto-claiming, and no automatic retry of mutations.
