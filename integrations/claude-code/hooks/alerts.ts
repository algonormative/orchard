// The rules of the alert listener as plain functions: reading a `workspace_alerts` page,
// the queue of undelivered alerts, when a wake is due, and the per-participant record
// kept in `$.store`. No `$` here (see orchard-cli.ts for why); register.tsx supplies the
// clock, the state and every call.
//
// The page shape was read from `workspace_alerts` in orchard-workspace-host
// (resources.rs, alerts_once): { alerts: [{ reasons, message, channel, resource }],
// next_cursor, has_more }, a message being { id, sequence, sender_id, kind, body,
// thread_id, destination, sent_at, ... }.
import type { OrchardAlert, OrchardQueue } from '../types'
import type { Settings } from './classify'
import { plain } from './config'

/** The CLI waits up to this long on the server for a first alert (it allows up to 120). */
export const WAIT_SECONDS = 60
/**
 * The host-side timeout of a waiting call: the wait, the CLI's own connect/call/close
 * allowances (about 36 s) and some slack.
 */
export const ALERTS_TIMEOUT_MS = 120_000
/** An empty wait that came back sooner than this means the server's waiter cap is full. */
export const SHORT_WAIT_MS = (WAIT_SECONDS * 1000) / 2

/** How many delivered message ids the stored record remembers. */
export const DELIVERED_KEEP = 200
/** Bodies are cut here on the way in, and again (to the same size) when framed. */
export const MAX_BODY = 4_000
/** One delivery carries at most this many messages / characters; the rest wait for the next one. */
export const MAX_ITEMS_PER_DELIVERY = 50
export const MAX_CHARS_PER_DELIVERY = 60_000
/**
 * The most alerts held undelivered. Past it the oldest ones that would not wake a session are
 * let go (and counted, see `dropped`); a waking one never is, so a queue that is full of them
 * stops the listener asking for more until a delivery drains it (see `isQueueFull`).
 */
export const MAX_QUEUE_ITEMS = 500

export type AlertsPage = {
  alerts: OrchardAlert[]
  /** The cursor to ask for next; undefined when the page did not say. */
  nextCursor: number | undefined
  hasMore: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A non-negative whole number, or undefined. */
function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

/** `text` cut to `max` characters without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** Where a message was posted: its display form and, for a channel, the channel's id. */
function whereOf(message: Record<string, unknown>, channel: unknown): { where: string; channelId: string | null } {
  const destination = record(message.destination)
  const kind = str(destination?.kind)
  if (kind === 'channel') {
    const channelId = str(record(channel)?.id) ?? str(destination?.id) ?? null
    const name = str(record(channel)?.name) ?? str(destination?.id)
    return { where: name === undefined ? 'channel' : `channel ${plain(name, 60)}`, channelId }
  }
  return { where: kind ?? 'message', channelId: null }
}

/** One alert of a page; undefined when it lacks what delivery needs (an id and a sender). */
export function parseAlert(raw: unknown, arrivedAt: number, nameOf: (id: string) => string | null = () => null): OrchardAlert | undefined {
  const alert = record(raw)
  const message = record(alert?.message)
  if (alert === undefined || message === undefined) return undefined
  const id = str(message.id)
  const senderId = str(message.sender_id)
  if (id === undefined || senderId === undefined) return undefined
  const reasons = Array.isArray(alert.reasons) ? alert.reasons.filter((r): r is string => typeof r === 'string') : []
  const fullBody = typeof message.body === 'string' ? message.body : ''
  const body = clip(fullBody, MAX_BODY)
  const { where, channelId } = whereOf(message, alert.channel)
  return {
    id,
    sequence: whole(message.sequence) ?? 0,
    senderId,
    senderName: nameOf(senderId),
    kind: str(message.kind) ?? 'message',
    reasons: [...new Set(reasons)],
    body,
    bodyCut: fullBody.length - body.length,
    threadId: str(message.thread_id) ?? null,
    where,
    channelId,
    sentAt: str(message.sent_at) ?? '',
    arrivedAt,
  }
}

/** A page of `workspace_alerts`, or undefined when the JSON is not one. */
export function parseAlertsPage(json: unknown, arrivedAt: number, nameOf?: (id: string) => string | null): AlertsPage | undefined {
  const page = record(json)
  if (page === undefined || !Array.isArray(page.alerts)) return undefined
  const alerts: OrchardAlert[] = []
  for (const raw of page.alerts) {
    const alert = parseAlert(raw, arrivedAt, nameOf)
    if (alert !== undefined) alerts.push(alert)
  }
  return { alerts, nextCursor: whole(page.next_cursor), hasMore: page.has_more === true }
}

/** Says whether an alert wakes a session under the settings in force now (see classify.ts). */
export type IsWake = (alert: OrchardAlert) => boolean

export const EMPTY_QUEUE: OrchardQueue = { items: [], cursor: 0, lastWakeAt: null, scope: null, dropped: 0 }

/**
 * `queue` if it belongs to `scope` (the connection's `queueScope`), else an empty queue of that
 * scope. The queue is state the host keeps across reloads, a reload can come back pointed at
 * another workspace or participant, and one workspace's alerts must never be delivered or
 * acknowledged against another.
 */
export function scopedQueue(queue: OrchardQueue, scope: string): OrchardQueue {
  return queue.scope === scope ? queue : { ...EMPTY_QUEUE, scope }
}

/**
 * Adds a page's alerts. An id already pending only gains reasons (a message with two
 * reasons counts once); an id already delivered is dropped. `cursor` is the page's
 * `next_cursor`: the queue's cursor never goes backwards.
 */
export function addToQueue(
  queue: OrchardQueue,
  incoming: readonly OrchardAlert[],
  cursor: number,
  delivered: readonly string[],
  isWake: IsWake,
): OrchardQueue {
  const known = new Set(delivered)
  const items = queue.items.map(item => ({ ...item }))
  const byId = new Map(items.map(item => [item.id, item]))
  for (const alert of incoming) {
    if (known.has(alert.id)) continue
    const have = byId.get(alert.id)
    if (have !== undefined) {
      have.reasons = [...new Set([...have.reasons, ...alert.reasons])]
      continue
    }
    items.push(alert)
    byId.set(alert.id, alert)
  }
  items.sort((a, b) => a.sequence - b.sequence)
  const bounded = boundQueue(items, isWake)
  return {
    ...queue,
    items: bounded.items,
    cursor: Math.max(queue.cursor, cursor),
    dropped: (queue.dropped ?? 0) + bounded.discarded,
  }
}

/**
 * Past MAX_QUEUE_ITEMS the oldest alerts that would not wake a session go, and how many is
 * counted so the next delivery can say so; waking ones are kept, even if that leaves the queue
 * over the limit (by at most one page: see `isQueueFull`).
 */
function boundQueue(items: OrchardAlert[], isWake: IsWake): { items: OrchardAlert[]; discarded: number } {
  let excess = items.length - MAX_QUEUE_ITEMS
  if (excess <= 0) return { items, discarded: 0 }
  let discarded = 0
  const kept = items.filter(item => {
    if (excess > 0 && !isWake(item)) {
      excess -= 1
      discarded += 1
      return false
    }
    return true
  })
  return { items: kept, discarded }
}

/**
 * Whether the listener must stop asking for alerts: the queue is at its limit and none of it
 * can be let go, because every pending alert wakes a session. Quiet alerts do not hold the
 * listener back (the oldest are discarded, and the next delivery says so): a queue clogged with
 * them would otherwise keep a direct message waiting on the server behind them.
 */
export function isQueueFull(queue: OrchardQueue, isWake: IsWake): boolean {
  return queue.items.length >= MAX_QUEUE_ITEMS && queue.items.every(isWake)
}

/**
 * The queue without `ids` (delivered), and without the `reported` discards a delivery just told
 * the model about (a discard that happened while it was being delivered stays to be told).
 */
export function removeFromQueue(queue: OrchardQueue, ids: Iterable<string>, reported = 0): OrchardQueue {
  const gone = new Set(ids)
  return { ...queue, items: queue.items.filter(item => !gone.has(item.id)), dropped: Math.max(0, (queue.dropped ?? 0) - reported) }
}

/** The queue keeping only the alerts `keep` says yes to (a settings change took some out). */
export function retainInQueue(queue: OrchardQueue, keep: (alert: OrchardAlert) => boolean): OrchardQueue {
  const items = queue.items.filter(keep)
  return items.length === queue.items.length ? queue : { ...queue, items }
}

/** The line that tells the model quiet alerts were let go for room; empty when none were. */
export function droppedNotice(dropped: number): string {
  if (!(dropped > 0)) return ''
  return dropped === 1
    ? '1 older quiet message was not shown — use orchard_history'
    : `${dropped} older quiet messages were not shown — use orchard_history`
}

/** When the earliest still-pending waking alert arrived, or null if none is pending. */
export function wakeSince(queue: OrchardQueue, isWake: IsWake): number | null {
  let since: number | null = null
  for (const item of queue.items) {
    if (isWake(item) && (since === null || item.arrivedAt < since)) since = item.arrivedAt
  }
  return since
}

/**
 * The earliest time a wake may fire: the batch window after the first pending waking
 * alert, and not before the minimum gap has passed since the last wake. null when no
 * pending alert wakes.
 */
export function wakeDueAt(queue: OrchardQueue, settings: Pick<Settings, 'batchSeconds' | 'gapSeconds'>, isWake: IsWake): number | null {
  const since = wakeSince(queue, isWake)
  if (since === null) return null
  const windowEnds = since + settings.batchSeconds * 1000
  return queue.lastWakeAt === null ? windowEnds : Math.max(windowEnds, queue.lastWakeAt + settings.gapSeconds * 1000)
}

export function countsOf(queue: OrchardQueue, isWake: IsWake): { unread: number; forYou: number } {
  return { unread: queue.items.length, forYou: queue.items.filter(isWake).length }
}

const costOf = (item: OrchardAlert) => Math.min(item.body.length, MAX_BODY) + 400

/**
 * What one delivery carries, oldest first, within the message and character limits. The oldest
 * waking alert is reserved a place first (it is why a wake fires: a bounded batch of older quiet
 * ones must not push it out); the rest of the room goes to the others in order. The record's
 * cursor still stops before the oldest alert left pending (see finishDelivery), so taking a
 * later alert ahead of an earlier one never moves it past anything undelivered.
 */
export function takeBatch(queue: OrchardQueue, skip: ReadonlySet<string> = new Set(), isWake?: IsWake): OrchardAlert[] {
  const candidates = queue.items.filter(item => !skip.has(item.id))
  const reserved = isWake === undefined ? undefined : candidates.find(isWake)
  const chosen = new Set<string>()
  let chars = 0
  if (reserved !== undefined) {
    chosen.add(reserved.id)
    chars += costOf(reserved)
  }
  for (const item of candidates) {
    if (chosen.has(item.id)) continue
    const cost = costOf(item)
    if (chosen.size > 0 && (chosen.size >= MAX_ITEMS_PER_DELIVERY || chars + cost > MAX_CHARS_PER_DELIVERY)) break
    chosen.add(item.id)
    chars += cost
  }
  return candidates.filter(item => chosen.has(item.id))
}

// ---- the per-(endpoint, participant) record in $.store ----

export type StoreRecord = { cursor: number; delivered: string[] }

export function storeKey(endpoint: string, participantId: string): string {
  return `inbox ${endpoint} ${participantId}`
}

/**
 * What a queue is stamped with: a digest of this connection's `storeKey`, not the key itself.
 * The queue lives in `$.state`, which holds no endpoint, credential path or id of the connection.
 * A 53-bit string hash (cyrb53): it tells connections apart, it does not hide anything.
 */
export function queueScope(endpoint: string, participantId: string): string {
  const text = storeKey(endpoint, participantId)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `q${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`
}

export function parseStoreRecord(value: unknown): StoreRecord | undefined {
  const rec = record(value)
  const cursor = whole(rec?.cursor)
  if (rec === undefined || cursor === undefined || !Array.isArray(rec.delivered)) return undefined
  return { cursor, delivered: rec.delivered.filter((id): id is string => typeof id === 'string').slice(-DELIVERED_KEEP) }
}

/** The record after delivering `ids` with `cursor` covering them: both move in one write. */
export function recordDelivery(rec: StoreRecord, ids: readonly string[], cursor: number): StoreRecord {
  const seen = new Set<string>()
  const delivered: string[] = []
  for (const id of [...rec.delivered, ...ids].reverse()) {
    if (seen.has(id)) continue
    seen.add(id)
    delivered.push(id)
  }
  return { cursor: Math.max(rec.cursor, cursor), delivered: delivered.slice(0, DELIVERED_KEEP).reverse() }
}
