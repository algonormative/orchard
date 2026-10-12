// The $.state contract of the orchard mod. Everything here is plain data the band
// and the pane draw from. None of it holds the credential path, the endpoint or any
// request id; message ids and participant ids live in the queue because delivery
// needs them, and only the model-facing text built from it (never the band) shows them.

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
  /** Clock time the person marked it "handle next" in the pane: it wakes the session and leads the next delivery. */
  nextAt?: number
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

/** The notification settings, kept in `$.store` per (endpoint, participant) and mirrored here for the pane. */
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

/** One message of a thread, as the pane lists it. */
export type OrchardPaneMessage = {
  id: string
  senderName: string
  isOwner: boolean
  isMine: boolean
  /** One line, cut short. */
  snippet: string
  sentAt: string
}

export type OrchardPaneThread = {
  /** The message a reply answers: the newest one in the thread that this participant did not send. */
  replyToId: string
  last: OrchardPaneMessage
  /** How many messages of the thread the window holds. */
  size: number
  /** Where to open it in the browser UI. */
  href: string | null
  /** Why it is in the inbox, as the badge says it. */
  reason: OrchardPaneReason
  /** An alert for it is still waiting to be delivered. */
  isUnread: boolean
}

export type OrchardPaneReason = 'DM' | 'MENTION' | 'REPLY' | 'BROADCAST' | 'OWNER' | 'CHANNEL'

export type OrchardPaneDecision = { id: string; snippet: string; sentAt: string; href: string | null }
export type OrchardPaneTask = { id: string; title: string; status: string; href: string | null }

/** What `/orchard` draws. `null` until the pane is first opened. */
export type OrchardPane = {
  /** `loading` while the CLI calls run, `failed` with `error` if they could not. */
  state: 'loading' | 'ready' | 'failed'
  error: string | null
  threads: OrchardPaneThread[]
  decisions: OrchardPaneDecision[]
  tasks: OrchardPaneTask[]
  /** The channels the participant can see, for the per-channel notification levels. */
  channels: { id: string; name: string }[]
  /** The "older threads" fold is open. */
  isOlderShown?: boolean
  /** Replies of the threads (by reply id) whose detail is open. */
  expanded?: string[]
  /** Message ids the person removed: hidden from the inbox (kept in `$.store` too). */
  hidden?: string[]
  /** Message ids snoozed until a time (clock ms): hidden until then. The alerts themselves are kept in `$.store`. */
  snoozed?: { id: string; until: number }[]
  /** A two-step action waiting for the person's yes or no (it lapses after 10 s). */
  confirm?: { verb: 'remove' | 'interrupt'; id: string } | null
  /** The thread (by reply id) the toolbar acts on. Absent or no longer listed: the newest unread, else the newest. */
  selected?: string | null
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
      pane: OrchardPane | null
      /** The band's line, derived by the mod from status, workspace and counts. null: no band. */
      band: OrchardBand | null
      heartbeat: OrchardHeartbeat
    }
  }
}
