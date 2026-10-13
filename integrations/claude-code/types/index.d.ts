// The $.state contract of the orchard mod. Everything here is plain data the band
// and the pane draw from. None of it holds the credential path, the endpoint or any
// request id; message ids and participant ids live in the queue because delivery
// needs them, and only the model-facing text built from it (never the band) shows them.
// One exception, for the person's eyes only: the feed (`activity`) and the plugins' items carry
// the address each opens at in Orchard's browser UI, which holds the loopback port and the
// workspace id. They are drawn for the person and never shown to the model.

/** Where the connection to the workspace stands. */
export type OrchardStatus =
  | { kind: 'connecting' }
  | {
      kind: 'connected'
      /** The last write to `$.store` failed (full, or refused): the cursor and settings are not being kept. */
      isStoreFailing?: boolean
    }
  /** Another session in this folder holds the lease for this participant: this one does not listen. */
  | { kind: 'shared' }
  /** `failures` counts consecutive failed attempts; the retry delay follows from it (5 s doubling to 5 min). */
  | { kind: 'offline'; failures: number }
  /** Stopped until the person fixes the cause (`/orchard reconnect`). `message` has request ids and paths stripped. */
  | { kind: 'error'; message: string }
  /** The person disconnected this session (`/orchard disconnect`): no listening, no lease, no wakes, until `/orchard connect`. Never kept across sessions. */
  | { kind: 'disconnected' }
  /** The session's own participant signed off (the main agent called `mail_leave`): out of the workspace, no listening, no lease, no wakes, until `/orchard connect` signs it on again. Never kept across sessions. */
  | { kind: 'signed-off' }

/** Cached from the workspace when the session connected. `name` is what the band shows. */
export type OrchardWorkspace = { name: string | null; ownerId: string | null }

/** Written by the alert listener. All zero until it runs. */
export type OrchardCounts = {
  /** Pending undelivered alerts, one per message id. */
  unread: number
  /** The pending ones whose reasons wake this participant. */
  forYou: number
  /** Open decisions this participant raised, as the workspace reports them. */
  needsYou: number
  /** The pending wake is held back by a draft in the prompt box (the band says it sends when the box is empty). */
  isHeld?: boolean
}

/** Clock time the alert loop last heard back from the workspace (the pane's footer shows its age). Kept apart from the counts: it moves every poll and the band must not redraw for it. */
export type OrchardHeartbeat = { lastPollAt: number | null }

/** What the band says, exactly: written only when the line itself changes, so the band redraws only then. */
export type OrchardBand = {
  text: string
  segments: { text: string; tone: 'mark' | 'plain' | 'dim' | 'ok' | 'warn' | 'err' }[]
  tone: 'quiet' | 'warning' | 'error'
}

/** One alert the listener fetched and has not yet delivered to the model. */
export type OrchardAlert = {
  /** The message id. The queue holds each id once, however many reasons it came with. */
  id: string
  sequence: number
  senderId: string
  /** The sender's display name when the directory knew it at arrival. */
  senderName: string | null
  /** `message`, `decision`, ... as the workspace labelled it. */
  kind: string
  /** Server-computed: direct, broadcast, mention, reply, channel. */
  reasons: string[]
  /** Cut to 4,000 characters on the way in; `bodyCut` is how many characters that left out. */
  body: string
  bodyCut: number
  threadId: string | null
  /** `direct`, `broadcast` or `channel <name>`. */
  where: string
  /** The channel's id; null for a direct message or a broadcast. */
  channelId: string | null
  sentAt: string
  /** Mock-able clock time the listener received it. The coalescing window runs from here. */
  arrivedAt: number
  /** Where the resource this alert is about opens, below the workspace (`/messages/<id>`), when the workspace gave one. */
  href?: string
}

/** Alerts waiting for a wake or for the person's next prompt. */
export type OrchardQueue = {
  items: OrchardAlert[]
  /** The fetch cursor that covers every item: what the stored cursor becomes once they are delivered. */
  cursor: number
  /** When the last waking delivery was submitted; the 60 s cap runs from here. */
  lastWakeAt: number | null
  /**
   * The (endpoint, participant) these items belong to. State outlives a reload, and a reload
   * can come back pointed at another workspace: a queue whose scope is not the current one
   * is not this connection's and is reset, never delivered or acknowledged.
   */
  scope: string | null
  /** Older quiet alerts discarded for room and not yet reported in a delivery. */
  dropped: number
}

/** How much of the workspace's traffic wakes the session. */
export type OrchardLevel = 'all' | 'participating' | 'mentions' | 'nothing'

/** The notification settings, kept in `$.store` per (endpoint, participant) and mirrored here. */
export type OrchardSettings = {
  /** The level for direct messages, broadcasts and every channel without an override. */
  defaultLevel: OrchardLevel
  /** Per-channel overrides, by channel id. */
  channels: Record<string, OrchardLevel>
  /** Seconds a burst is gathered before one wake carries it (0-120). */
  batchSeconds: number
  /** Seconds that must pass between one wake and the next (0-3600). */
  gapSeconds: number
}

export type OrchardPaneDecision = { id: string; snippet: string; sentAt: string; href: string | null }
export type OrchardPaneTask = { id: string; title: string; status: string; href: string | null }

/**
 * One thing this session (or one of its subagents) did in Orchard, or was told. Newest last; the
 * list holds about 60. `text` is a short sentence for a person: names and titles, no ids.
 */
export type OrchardActivityEntry = {
  /** Clock ms. */
  at: number
  /** `main` for the session's own loop, else the subagent's id (`$.agent.list()`). */
  agentId: string
  /** The participant id the entry belongs to: who acted (out) or who was written to (in). */
  handle: string
  direction: 'in' | 'out'
  /** `send`, `reply`, `ack`, `task`, `role`, `state`, `call` for what the agent did; the alert's own kind (`message`, `decision`, ...) for what it was told. */
  kind: string
  text: string
  /** Where it opens in the browser UI. */
  href?: string
}

/** The agents of this session, by agent id: `main` always, and every subagent until about two minutes after it ended. */
export type OrchardAgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' | 'lost'
export type OrchardAgent = {
  agentId: string
  description: string
  /** `main`, or the agent type it was spawned as (`general-purpose`, `Explore`, ...). */
  type: string
  /** `lost`: it left `$.agent.list()` without ever being seen to end. */
  status: OrchardAgentStatus
  startedAt: number
  endedAt?: number
  /**
   * The participant it was seen acting as in Orchard. The main loop's is the session's; a subagent has one
   * once it signed on through the Orchard CLI (`observed`) or used the mod's tools (`sharesBase`), and
   * keeps showing it after it ends. None: the mod has not seen it use Orchard.
   */
  handle?: string
  /** The handle is a participant the agent signed on as itself, through the Orchard CLI. The mod registered nothing for it and its tool calls do not act as it. */
  observed?: true
  /** The agent used the mod's tools, which act as the session's own participant: its handle is the session's. */
  sharesBase?: true
  /**
   * Whether Orchard says the handle is signed on, as of the last read of the participant list (a
   * refresh of the workspace, or just after an agent ended). Undefined: not known, or the agent has no handle.
   */
  signedOn?: boolean
  /** When Orchard last heard from the handle (clock ms), as of the same read. */
  lastContactAt?: number
  /** What it last did in Orchard, as the activity feed words it. */
  lastAction?: string
}
export type OrchardAgents = Record<string, OrchardAgent>

/** What happens in the workspace outside this session. */
export type OrchardWorkspaceActivity = {
  /** Alerts from anyone but this session's handles (task receipts aside) in the last ten minutes. */
  recentFromOthers: number
  /** When the latest of them arrived. */
  lastAt?: number
  /** Open tasks across the attached task stores; null while unknown (no task store, or the workspace could not say). */
  openTasks: number | null
}

/** What the optional plugins of the workspace hold for this session's handles. Only attached plugins have content. */
export type OrchardPlugins = {
  /** Ids of the plugins attached to the workspace (`chat`, `tasks`, `state`, `roles`, ...). */
  attached: string[]
  /** Roles this session's handles declared. */
  roles: { participantId: string; roles: string[] }[]
  /** State markers its handles created, or that sit on a task one of them claimed. */
  states: { id: string; title: string; state: string; href: string | null }[]
  /** Decisions it asked that the owner has not answered. */
  decisions: OrchardPaneDecision[]
  /** Tasks claimed by one of its handles. */
  tasks: OrchardPaneTask[]
}

/**
 * The message(s) this session's main loop is handling this turn: set when a batch is delivered to it,
 * cleared when its turn completes. `items` holds up to three; `total` is how many came in the batch.
 */
export type OrchardNow = {
  /** Clock ms of the delivery. */
  at: number
  total: number
  items: { sender: string; /** How it reached the session: `DM`, `mention`, `reply`, `broadcast`, `#channel`. */ how: string; snippet: string; href?: string }[]
}

/** What the person has toggled in the pane. Memory of the session only: nothing in it is kept across sessions. */
export type OrchardView = {
  /** The activity list also shows the subagents' entries. */
  showSubagents: boolean
  /** Disconnect was pressed and the pane asks again before it acts. */
  isConfirming: boolean
}

declare module 'claude-code' {
  interface PluginState {
    orchard: {
      /** null until the session has started with an endpoint configured: no band at all. */
      status: OrchardStatus | null
      workspace: OrchardWorkspace | null
      counts: OrchardCounts
      /** Bumped every time a listener starts; a loop whose generation is not the current one stops. */
      generation: number
      queue: OrchardQueue
      settings: OrchardSettings
      /** The band's line, derived by the mod from status, workspace and counts. null: no band. */
      band: OrchardBand | null
      heartbeat: OrchardHeartbeat
      /** A ring of what this session's agents did in Orchard and were told, newest last. */
      activity: OrchardActivityEntry[]
      agents: OrchardAgents
      workspaceActivity: OrchardWorkspaceActivity
      plugins: OrchardPlugins
      /** The messages the main loop is handling this turn; null between turns. */
      now: OrchardNow | null
      view: OrchardView
    }
  }
}
