# Claude Code integration

`integrations/claude-code` is a Claude Code mod (a function-hook plugin) that keeps a
Claude Code session in an Orchard workspace as a resident participant. It runs inside
the agent's own harness: Claude Code listens for workspace messages and decides when to
start a turn. **Orchard itself still wakes no agent**: the server answers the same
`alerts --wait` long-poll any agent can make.

## Connecting a session

A session is in Orchard only when it was asked to be. Enabling the plugin for a project
does not connect its sessions: an unconnected session makes no call to Orchard and shows
nothing (no band, no status line, no pane opening by itself), and its Orchard tools answer
that the session isn't connected. A session is connected when:

1. the person runs `/orchard connect` in it (or presses Connect in the `/orchard` pane,
   which in an unconnected session shows only that prompt and the button);
2. the model calls the `orchard_connect` tool, which does the same;
3. this same session connected before and has not disconnected or signed off since, so a
   mod reload or a resumed conversation connects again by itself (remembered per
   endpoint and session id); or
4. the `autoConnect` option is on, which connects every session of the project at start.

`/orchard disconnect` and a sign-off through `mail_leave` forget the session, so its next
start stays out. The end of a session signs it off from the workspace but keeps it
remembered, so resuming the conversation connects again.

## What it does

- **Joins or resumes** the configured participant when a connected session starts, through the
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
  and `orchard_call`, plus `orchard_connect` to connect the session. Writes always act as this session's participant: a different
  `sender_id` or `participant_id` is refused, and `mail_register`, `artifact_upload` and
  non-read `plugin_call` operations are denied. The one write `plugin_call` allows is
  `role_declare`: its nested `participant_id` is filled in when missing and refused when it
  names someone else. `mail_leave` from the main agent signs the session's participant off
  and the mod stops listening, exactly as Disconnect does (state `signed-off`; `/orchard
  connect` signs it on again); from a subagent or for anyone else it is refused.
- **Subagents.** A subagent that uses the tools acts as the session's participant (the pane
  says "shares <participant>"). One that signs on to Orchard by itself through the Orchard CLI
  is shown with that handle; the mod registers nothing for it and tells you when it ended
  without signing off ("still signed on").
- **One handle per session.** The configured id (option `participantId`, `.orchard.json`, or
  `claude-<folder name>`) is only the *base*. Each connected session signs on as `<base>.<sid>`, where
  `<sid>` is the first six letters and digits of its session id, lowercase: `claude-vault.3f9a1c`,
  shown as `Claude (vault) · 3f9a1c`. Resuming the same conversation, or reloading the mod,
  gives the same handle, so the mod resumes it instead of joining again. Without a session id a
  random six-character id stands in for the life of the process. A long base is cut to keep the
  handle within 128 characters. Sessions of one folder are separate participants, so none waits
  on another and there is no "another session is listening" state. `/orchard notify` levels,
  the batch window and the gap are kept per *base* and shared by every session of the project;
  the cursor, thread participation and in-flight claims are per handle. A lease record
  an earlier version left for the base id is ignored and is evicted with its record.
- **Sign-off at session end.** When a session ends (exit, `/resume`, logout, signal; not
  `/clear`) the mod signs its handle off with `mail_leave`, best effort and short, so
  Orchard does not list a finished session as signed on. Disconnect only stops listening and
  leaves the handle signed on; the main agent can still sign off with `orchard_call mail_leave`,
  and `/orchard connect` after any sign-off joins again. A session that crashes or is killed
  cannot sign off: Orchard times a forgotten handle out.
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
- **A read-only view.** The mod shows what *this Claude session and its subagents* are doing in
  Orchard, as visual feedback. It is quiet when nothing happens and grows with activity. Its
  only controls are big actions (Open in Orchard, Disconnect / Connect) and, on an item, open
  and copy-link. Steering stays in the prompt box: there are no hotkeys, no selection and no
  per-message actions. `/orchard notify` (text only) still reads and sets the notification
  levels, `/orchard disconnect`, `/orchard connect` and `/orchard reconnect` do what they say.
- **The pane (`/orchard`).** Quiet: "Claude is connected to <workspace>", the participant and
  two buttons, **Open in Orchard ↗** and **Disconnect** (red). Disconnect asks first: the whole
  header turns red ("Stop Claude listening to <workspace>?", "this session only · <handle>
  stays signed on", "/orchard connect brings it back") with **Yes, disconnect** and
  **Cancel**; the question lapses after 10 s. Disconnect stops listening for this
  session only; the next session connects as usual. Sections appear only when
  they have content, in this order:
  - **NOW**: the message(s) the main loop is handling this turn (sender, how it reached the
    session, the first line), cleared when its turn ends; and "N more queued · sends when the
    prompt box is empty" for what waits behind it.
  - **TASKS**: tasks claimed by any of the session's participants.
  - **AGENTS**: main and each subagent as a tree: description, participant (or "not on
    Orchard", or "shares <participant>"), and its state: `● signed on`, `● running`,
    `✓ done · signed off`, `⚠ done · still signed on`; the last Orchard action under a running
    one; a stable dot colour per agent. Ended agents leave about 2 minutes after they end.
  - **PLUGINS**: only attached plugins with content for the session's participants: ROLES
    (with the handle's short label, `garden` for `claude-vault.garden`), STATE markers with
    their transition, and ASKED (decisions raised that the owner has not answered).
  - **ACTIVITY**: the last 15 minutes in and out, newest first. When any subagent has
    activity a two-state toggle, **this agent** / **+ subagents**, filters it (the choice is
    this session's, not kept).
  Everything fades: with nothing shown and nothing in flight the pane returns to the quiet
  view. Every item row is a plain Button that opens the item in Orchard's browser UI, with a
  small `⧉` button beside it that copies its link (rows without an address are plain text).
- **It opens itself.** On the first activity (a delivery, a claimed task, a subagent or a
  participant a subagent signed on as) the pane opens unasked, if the window has room. If
  you close it, it stays closed for the session; `/orchard` opens it again.
- **The band** is one line above the prompt and stacks with other mods' bands (it draws
  its line and then whatever sits beneath it, such as beads-band). Quiet: `◆ Claude is
  connected to <workspace>`. Busy: `◆ Claude in <workspace> · handling DM from Ada · 1
  queued`, with subagents `· 3 subagents · 1 running · 1 still signed on`, and `· sends when
  box is empty` while a draft holds a wake. `◇ Claude is disconnected from <workspace> ·
  /orchard connect` (or "signed off from"); offline and error have their own wording. It yields to a survey. Its line is held in one atom
  that is written only when the text changes.
- **The status line** (always on while connected) shows the workspace around this session:
  `orchard · <workspace> · ● 4 in 10m · 12 open tasks` (`quiet` with no alerts from others
  in ten minutes; the task count is left out while unknown), `orchard · disconnected` /
  `orchard · signed off`, and while a wake is held `orchard · N waiting for you — sends
  when the prompt box is empty`, which takes precedence. It is written only when its text
  changes and cleared when the session ends.
- **Live.** The alert listener already long-polls `alerts --channels --wait 60`, which
  returns the moment mail arrives, so everything is fed from it. Orchard posts task intents
  and outcomes to the `task-receipts` channel; a receipt, a decision or an owner's reply
  schedules ONE debounced (1 s) refresh of claimed tasks, open decisions, roles and state
  markers (the workspace's open-task count is read at connect and again after a receipt, at
  most every 30 s). While the pane is open it also refreshes every 60 s; while it is closed
  nothing runs. Idle polls change nothing: a state value is written only when it differs from
  what is there.
- **Look.** The Orchard x LEMON palette (ink, neon citron, leaf, cream; monospace labels)
  following Claude's light or dark theme. The header, the section labels and the footer are
  Svg sized from the pane width; the terminal draws the same structure as text, and mobile
  draws no inputs. The red of Disconnect is the theme's `error` colour on its label; the red
  header is the theme's `diffRemovedDimmed` background, so both follow the person's theme.

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
| `participantId` | base id; each session signs on as `<base>.<sid>`; empty means `claude-<folder name>` |
| `name` | display name, shown as `<name> · <sid>`; empty means `Claude (<folder name>)` |
| `orchardBin` | the Orchard executable, default `/Applications/Orchard.app/Contents/MacOS/Orchard` |
| `autoConnect` | `true` connects every session of the project at start; default `false`, a session connects only when asked (see Connecting a session) |

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
