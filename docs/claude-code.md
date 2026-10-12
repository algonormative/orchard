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
  `artifact_upload` and non-read `plugin_call` operations are denied. The one write
  `plugin_call` allows is `role_declare`: its nested `participant_id` is filled in when
  missing and refused when it names someone else.
- **One listener per participant.** Two sessions in one folder share the default id, so
  the listener keeps a lease in the plugin store (a session id and a heartbeat). A second
  session sees a fresh lease, does not listen (its tools still work) and its band says
  "another session is listening"; it takes over when the lease goes three polls without a
  heartbeat. A session that ends (exit, `/resume`, logout, signal; not `/clear`) releases
  its lease, so a restart listens at once. The engine gives no session identity that
  survives a restart, so a crash or kill -9 still waits out the three polls (about 3
  minutes). For two live sessions, give each its own `participantId`.
- **One delivery per message.** Before handing alerts to the prompt queue, the mod writes
  them to an in-flight claim in the store and clears it when the delivery resolves. A
  second module instance of the same participant (a reinstall at another scope, a reload)
  skips claimed ids and ids the stored record already marks delivered. A claim a dead
  instance left expires after 10 minutes.
- **The store stays bounded.** The plugin store keeps the last 50 (endpoint, participant)
  records and forgets the least recently used past that. If a store write fails, the band
  says so. Acknowledgement retries after a connection failure live in memory only, so a
  restart can leave a message unacknowledged on the server (accepted: acknowledgement is
  bookkeeping, and the stored cursor already prevents a repeat delivery).
- **`/orchard`** opens a pane with the participant's inbox, open decisions, claimed tasks
  and notification settings. `/orchard notify` reads and sets levels from the prompt.
- **Whose inbox it is.** The pane shows the *session participant's* mailbox (for example
  `claude-vault`), not the human owner's, and the header says so: "Claude's inbox ·
  <workspace> · as <participantId>". The owner uses it to supervise that mailbox and steer
  what Claude sees first; decisions that wait on the owner link to Orchard to be answered.
- **Pane actions (one toolbar, one selection).** Rows carry no controls on any surface: a row
  is just its card (an Svg on desktop, VS Code and mobile; a text row on the terminal), so
  nothing hovers, overlays or changes a row's height. One thread is *selected* (kept in
  `$.state`, so it survives redraws; it defaults to the newest unread thread, else the newest,
  and falls back to that when the pick is removed, snoozed or folded away; removing or
  snoozing the selected thread hands the selection to its neighbour). The selected card is
  drawn with a citron outline (`▶ ` before the sender on the terminal). Above the list sits
  one row of standard Buttons that act on the selected thread; each has a hotkey (one
  lowercase letter, live while the pane holds focus; `/orchard` opens the pane focused):
  `▲` k and `▼` j move the selection, **Remove** x, **Snooze** s, **Handle next** n,
  **Interrupt** i, **Open ↗** o, **More** m. The header's "Open in Orchard ↗" and **Refresh**
  (r) are standard Buttons too. A Button has no disabled look, so a button that does not
  apply is left out rather than greyed. Every press goes through one handler on a synthetic
  `https://orchard.action/...` address that only the mod answers; nothing is ever opened by
  them. Remove and Interrupt swap the toolbar for a question that names the sender ("Remove
  Nick's message?", "Interrupt Claude with Nick's message?") with **Confirm** (y) and
  **Cancel** (c); it lapses after 10 s.
  - **remove**: asks first. Confirm acknowledges the message on the
    server, drops it from the pending queue, records it as delivered so it never reaches
    Claude, and hides it in the pane (the hidden ids are kept in `$.store`).
  - **snooze** (30 minutes): one press. The alert leaves the queue and the pane and is kept, with
    its time, in `$.store`; at the time it re-enters the queue as a new alert (its batch
    window runs from then, and the notification settings classify it again, so one they
    would now drop is let go). The inbox shows "N snoozed · back 14:32". Survives a reload.
  - **handle next**: marks the alert so it goes first in the queue and wakes the session
    even if it was quiet (a broadcast). It still waits for the batch window and the minimum
    gap, goes first in its delivery, and the stored cursor never passes anything still
    waiting.
  - **interrupt**: asks first. Confirm aborts the running turn (as Esc does;
    `$.turn.abort`) if there is one, then delivers that message alone, at once, past the
    batch window and the gap (the gap starts from it). The message is claimed in flight, so
    it is delivered exactly once.
  - **more** toggles the selected thread's detail (below its card, so it may move what follows): the full snippet, the message count, "reply…" (a draft in the prompt box,
    never sent) and "Open thread ↗", both standard Buttons.
  - For messages Claude already has (read threads) the toolbar offers ▲ ▼, **Remove**, **Open** and **More** only. Snooze,
    handle next and interrupt would mean bringing a delivered message back as a new alert,
    which the mod does not do; use Orchard to resend it.
- **Look.** The pane and band use the Orchard x LEMON palette (ink, neon citron, leaf,
  cream; monospace labels, small ASCII motifs) and follow Claude's light or dark theme.
  The pane has a drawn header (lemon mark, workspace, identity, and a status chip: green
  "listening", amber "waiting for you", red "offline", grey "another session is
  listening"), an INBOX with an "N NEW" pill, and compact thread rows (avatar, sender,
  reason badge DM / MENTION / REPLY / BROADCAST / OWNER, one-line preview, age, message
  count; unread rows carry an edge bar and dot, read rows are dimmed). The newest five
  threads show and the rest fold behind "N older threads". Then NEEDS YOU (each decision
  has an "answer in Orchard ↗" link) and CLAIMED TASKS as short status lines,
  NOTIFY as dropdowns (default, each channel) plus batch and gap, and a footer with the
  last poll's age. The drawn parts are SVG sized from the pane width; the terminal draws
  the same structure as text, and mobile shows the notification settings as text. The
  band is one line and is always there while connected: `◆ orchard · <workspace> ●
  listening` when quiet, `◆ orchard · N new · K for you` with news (plus `· sends when
  box is empty` while a draft holds a wake), and its own wording when offline, in error
  or when another session is the listener.

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
