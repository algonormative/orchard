// The alert listener's bookkeeping without `$`: the loop handle, the in-memory state one
// module instance keeps, and small pure helpers. The calls themselves (CLI, clock, state,
// store, prompt) are made in register.tsx; see orchard-cli.ts for why.
import type { OrchardAlert } from '../types'
import { DEFAULT_SETTINGS } from './classify'
import type { Settings } from './classify'
import { EMPTY_QUEUE, droppedNotice } from './alerts'
import type { StoreRecord } from './alerts'
import type { FrameMessage } from './frame'
import { createBook } from './handles'
import type { HandleBook } from './handles'

/** A pending timer from `$.clock.after`; anything with a `cancel()`. */
export type Cancelable = { cancel: () => void }

/**
 * Why a loop ended. `crashed` (an exception) and `stalled` (it did not move by its `expectedBy`)
 * are loops that died on their own: the session goes offline and reconnects, which starts a new one.
 */
export type StopReason = 'superseded' | 'offline' | 'error' | 'crashed' | 'stalled' | 'disconnected'

/**
 * One run of the alert loop, tied to one value of the `generation` atom. A loop whose
 * generation is no longer the current one stops without delivering, acking or advancing.
 */
export type Loop = {
  gen: number
  timer: Cancelable | undefined
  /** A CLI call of this loop is in flight. */
  isPolling: boolean
  isStopped: boolean
  /** The time by which the loop must have moved again; past it the liveness guard restarts it. */
  expectedBy: number
  stopReason: StopReason | undefined
}

/** A batch of delivered ids whose acknowledgement has to be retried after a connection failure. */
export type PendingAck = { ids: string[]; requestId: string }

/** Everything one module instance holds in memory. A hot reload starts it afresh. */
export type ListenerState = {
  /** start() ran in this module instance. */
  isStarted: boolean
  /** startListener() is in its setup. */
  isStarting: boolean
  loop: Loop | undefined
  settings: Settings
  /** The stored cursor and delivered ids. */
  record: StoreRecord
  /** What to ask `alerts --after` for next; runs ahead of the stored cursor while alerts are pending. */
  fetchCursor: number
  /** The last page said `has_more`: the next call drains without waiting. */
  hasMore: boolean
  /** Ids in threads this participant started or posted in. */
  participation: string[]
  participationSet: Set<string>
  /** Display names by participant id, from `mail_participants`. */
  names: Map<string, string>
  namesAt: number | undefined
  flushTimer: Cancelable | undefined
  /** The flush timer was asked for while a wake was under way: arm it again when that wake ends. */
  isRearmWanted: boolean
  /** Fires when the loop should have moved and has not, so an idle session restarts a dead one. */
  watchdog: Cancelable | undefined
  /** Loops that died on their own since one last ran a call to its end: it lengthens the wait to reconnect. */
  crashes: number
  /** A wake was blocked by a draft in the prompt box; the queue waits for the next prompt or for the box to empty. */
  isHeld: boolean
  /** While held: the timer that looks at the prompt box again. One at most. */
  holdTimer: Cancelable | undefined
  /** The status line pinned for the hold (undefined: none is). */
  heldStatus: string | undefined
  /** What this instance last pinned to the status line (null: it cleared it; undefined: it has pinned nothing yet, so its first line replaces one an earlier instance left). */
  statusShown: string | null | undefined
  /** Tells this module instance's claims on deliveries from another's (a reinstall or reload leaves both alive). */
  instanceId: string
  /** A waking delivery is in flight (a `$.prompt.submit` that has not resolved). */
  isDelivering: boolean
  /** Ids handed to a delivery that has not resolved; another delivery must not take them. */
  inFlight: Set<string>
  /** No wake attempt before this time (after a rejected delivery). */
  retryAfter: number
  unacked: PendingAck[]
  /** Request ids of mutations whose connection failed, by what the call was: a retry reuses the id, for a while. */
  retryIds: Map<string, { requestId: string; at: number }>
  /** The channels the participant can see, as `/orchard notify` last read them. */
  channels: { id: string; name: string }[]
  /** When the open decisions were last read, and whether a read is running. */
  decisionsAt: number | undefined
  isReadingDecisions: boolean
  isIdToastShown: boolean
  /** The short id in this session's handle, made once (undefined until the first start). */
  sid: string | undefined
  /** The last write to `$.store` failed. */
  isStoreFailing: boolean
  /**
   * Whether this connection's host has the `workspace_decisions` tool: unknown until first asked,
   * `missing` after a tool error (a host older than the tool) so it is not asked again.
   */
  decisionsTool: 'unknown' | 'available' | 'missing'
  /** This session is connected to Orchard: the person, the model, `autoConnect` or a remembered earlier connection of the same session said so. Until then the mod does nothing. */
  isOptedIn: boolean
  /** The person disconnected this session, or its participant signed off: nothing listens, nothing wakes. Memory only, never kept across sessions. */
  isDisconnected: boolean
  /** The /orchard pane is open: only then is the slow safety refresh armed and the poll clock mirrored. */
  isPaneOpen: boolean
  /** The person closed the pane this session: it is never opened unasked again. */
  isPaneDeclined: boolean
  /** The disconnect question lapses when this fires. */
  confirmTimer: Cancelable | undefined
  /** The one debounced read of the workspace's tasks and plugins a receipt (or this session's own write) asked for, and when it will run. */
  workTimer: Cancelable | undefined
  workDueAt: number | undefined
  /** When the workspace was last read for tasks and plugins (the 30 s floor between receipt-driven reads runs from here). */
  workReadAt: number | undefined
  /** The slow safety refresh, armed only while the pane is open. */
  safetyTimer: Cancelable | undefined
  isRefreshingWork: boolean
  /** Another refresh was asked for while one ran. */
  isWorkDirty: boolean
  /** Clock time the alert loop last heard back; the heartbeat atom mirrors it while the pane is open. */
  lastPollAt: number | null
  /** Ids of alerts already counted and logged, newest last, so an alert fetched twice is one entry and one count. */
  seenAlerts: string[]
  /** Arrival times of alerts from others within the last ten minutes, oldest first; the count in `workspaceActivity` follows it. */
  othersAt: number[]
  lastOtherAt: number | undefined
  /** Fires when the oldest of those leaves the window, so the count falls without any new alert. */
  decayTimer: Cancelable | undefined
  /** The one timer that looks at the session's agents again: every 2 s while one is live, else when a finished one is due to go. */
  agentTimer: Cancelable | undefined
  /** The participants this session's agents were seen acting as, and what Orchard says of each. */
  handles: HandleBook
}

export function createListenerState(): ListenerState {
  return {
    isStarted: false,
    isStarting: false,
    loop: undefined,
    settings: DEFAULT_SETTINGS,
    record: { cursor: 0, delivered: [] },
    fetchCursor: 0,
    hasMore: false,
    participation: [],
    participationSet: new Set(),
    names: new Map(),
    namesAt: undefined,
    flushTimer: undefined,
    isRearmWanted: false,
    watchdog: undefined,
    crashes: 0,
    isHeld: false,
    holdTimer: undefined,
    heldStatus: undefined,
    statusShown: undefined,
    instanceId: crypto.randomUUID(),
    isDelivering: false,
    inFlight: new Set(),
    retryAfter: 0,
    unacked: [],
    retryIds: new Map(),
    channels: [],
    decisionsAt: undefined,
    isReadingDecisions: false,
    isIdToastShown: false,
    sid: undefined,
    isStoreFailing: false,
    decisionsTool: 'unknown',
    isOptedIn: false,
    isDisconnected: false,
    isPaneOpen: false,
    isPaneDeclined: false,
    confirmTimer: undefined,
    workTimer: undefined,
    workDueAt: undefined,
    workReadAt: undefined,
    safetyTimer: undefined,
    isRefreshingWork: false,
    isWorkDirty: false,
    lastPollAt: null,
    seenAlerts: [],
    othersAt: [],
    lastOtherAt: undefined,
    decayTimer: undefined,
    agentTimer: undefined,
    handles: createBook(),
  }
}

export function stopLoop(ls: ListenerState, reason: StopReason): void {
  const loop = ls.loop
  if (loop === undefined) return
  loop.isStopped = true
  loop.stopReason ??= reason
  loop.timer?.cancel()
  loop.timer = undefined
}

export { EMPTY_QUEUE }

export function toFrameMessage(alert: OrchardAlert): FrameMessage {
  return {
    id: alert.id,
    senderId: alert.senderId,
    senderName: alert.senderName,
    body: alert.body,
    bodyCut: alert.bodyCut,
    reasons: alert.reasons,
    where: alert.where,
    threadId: alert.threadId,
    kind: alert.kind,
  }
}

/**
 * What a delivery tells the model about answering. The tools wait behind tool search, so they are
 * named. The plugin acknowledges after the delivery has gone through, not before, so this does not
 * say they already are.
 */
export const DELIVERY_NOTE =
  'The plugin acknowledges these messages itself once they are delivered; you do not need orchard_ack for them. ' +
  'To answer one, use the orchard_reply tool with its message_id ' +
  '(orchard_send for a new message, orchard_history to read more).'

/** The note of a delivery, with the line about quiet messages let go for room when there were any. */
export function deliveryNote(dropped: number): string {
  const lost = droppedNotice(dropped)
  return lost === '' ? DELIVERY_NOTE : `${DELIVERY_NOTE}\n${lost}`
}

/** How long a request id is kept for a retry of a mutation whose connection failed. */
export const RETRY_ID_TTL_MS = 10 * 60_000

/**
 * The line a held wake shows as a native notification, and as a toast where there is no terminal
 * to notify. No ids, no names, no bodies.
 */
export function heldNotice(unread: number, forYou: number): string {
  const total = `${unread} new Orchard message${unread === 1 ? '' : 's'}`
  const you = forYou > 0 ? ` (${forYou} for you)` : ''
  return `${total}${you} waiting. They will be sent when the prompt box is empty, or come with your next prompt.`
}

/** The status line pinned under the prompt for as long as a wake is held. */
export function heldStatusLine(waiting: number): string {
  return `orchard · ${waiting} waiting for you — sends when the prompt box is empty`
}
