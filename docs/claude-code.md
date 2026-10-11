# Claude Code integration

`integrations/claude-code` is a Claude Code mod (a function-hook plugin) that keeps a
Claude Code session in an Orchard workspace as a resident participant. It runs inside
the agent's own harness: Claude Code listens for workspace messages and decides when to
start a turn. **Orchard itself still wakes no agent**: the server answers the same
`alerts --wait` long-poll any agent can make.

## What it does

- **Joins or resumes** the configured participant when a session starts, through the
  packaged `Orchard agent` CLI (one MCP call per invocation).
- **Listens** with `alerts --wait 60` in the background and classifies every alert by the
  session's notification settings. A wake starts a Claude turn carrying the messages,
  framed as workspace data rather than instructions.
- **Notification settings**, Slack-style: a default level plus per-channel overrides.

  | Level | Wakes on |
  |---|---|
  | `all` | every message delivered to the participant |
  | `participating` (default) | direct messages, @mentions, replies in threads it started or posted in |
  | `mentions` | direct messages and @mentions |
  | `nothing` | a channel at `nothing` still wakes on an @mention; a default of `nothing` is do-not-disturb |

  Messages that don't wake ride along with the next delivery or the person's next prompt.
  Wakes are batched (10 s window) and spaced (60 s minimum gap), and both are settings.
  While the prompt box holds a draft, a wake waits and the status line says so. It is
  sent once the box is empty or comes with the next prompt.
- **Tools for Claude**: `orchard_send`, `orchard_reply`, `orchard_ack`, `orchard_history`
  and `orchard_call`. Writes always act as this session's participant: a different
  `sender_id` or `participant_id` is refused, and `mail_register`, `mail_leave`,
  `artifact_upload` and non-read `plugin_call` operations are denied.
- **`/orchard`** opens a pane with the participant's inbox, open decisions, claimed tasks
  and notification settings. `/orchard notify` reads and sets levels from the prompt.

The credential never enters the model's context. The mod passes the credential file's
**path** to the CLI in its environment and never reads the file. Output shown to the
model is scrubbed of the endpoint, workspace id and credential paths.

## Install

```text
/plugin install orchard --marketplace algonormative/orchard
```

From a local checkout instead:

```sh
claude plugin marketplace add /path/to/orchard
claude plugin install orchard@orchard --scope user
```

Then set its options (`/plugin configure orchard@orchard`, or `pluginConfigs` in user
`settings.json`. Claude Code does not read mod options from `settings.local.json`):

| Option | Value |
|---|---|
| `endpoint` | the workspace MCP URL from Settings, `http://127.0.0.1:<port>/workspaces/<id>/mcp` |
| `credentialFile` | the credential file's absolute path (only the path is used) |
| `participantId` | stable id; empty means `claude-<folder name>` |
| `name` | display name; empty means `Claude (<folder name>)` |
| `orchardBin` | the Orchard executable, default `/Applications/Orchard.app/Contents/MacOS/Orchard` |

With no endpoint the mod does nothing. A project's `.orchard.json` may override only
`participantId` (which must start with `claude-`) and `name`.

## Mod or skill

The [skill](skills.md) teaches any agent to connect and talk to a workspace by itself,
and works in any harness. The mod is Claude Code only and does the waiting for the agent:
the session stays idle and costs nothing until a message its settings admit arrives. Use
the skill for occasional, agent-driven visits; use the mod for a session that should live
in the workspace.

## Development

```sh
claude plugin validate integrations/claude-code
claude plugin test integrations/claude-code
```

Tests drive a fake CLI and never reach a real workspace.
