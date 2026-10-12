// The pane's actions as plain data: the synthetic addresses every press is routed through, the
// toolbar and selection model (which thread is selected, which buttons it gets), and the snooze and
// hidden records kept in `$.store`. No `$` here; register.tsx performs the actions.
//
// The addresses are `https://orchard.action/<verb>/<id>`. Buttons press them through `act`. Rows and "answer in Orchard" are plain Buttons whose press goes through `act` too. Nothing opens them.
import type { OrchardAlert, OrchardPaneThread } from '../types'

export const ACTION_ORIGIN = 'https://orchard.action'

/** How long a snooze lasts. */
export const SNOOZE_MS = 30 * 60_000
/** How long a question waits for an answer before it lapses. */
export const CONFIRM_MS = 10_000
/** The most snoozed alerts and hidden ids kept. */
export const MAX_SNOOZED = 50
export const MAX_HIDDEN = 200

export const VERBS = [
  'remove',
  'remove-yes',
  'snooze',
  'next',
  'interrupt',
  'interrupt-yes',
  'cancel',
  'more',
  'reply',
  'open-thread',
  'answer',
  'open-workspace',
  'refresh',
  'select-prev',
  'select-next',
  'select',
] as const
export type Verb = (typeof VERBS)[number]

export type Action = { verb: Verb; id: string }

/** The id of the verbs that act on nothing in particular. */
const NO_ID = '-'

export function actionHref(verb: Verb, id: string = NO_ID): string {
  return `${ACTION_ORIGIN}/${verb}/${encodeURIComponent(id)}`
}

/** The action an address stands for; undefined for anything that is not one of ours. */
export function parseActionHref(href: string): Action | undefined {
  if (!href.startsWith(`${ACTION_ORIGIN}/`)) return undefined
  const rest = href.slice(ACTION_ORIGIN.length + 1)
  const slash = rest.indexOf('/')
  if (slash < 1) return undefined
  const verb = rest.slice(0, slash)
  if (!(VERBS as readonly string[]).includes(verb)) return undefined
  let id: string
  try {
    id = decodeURIComponent(rest.slice(slash + 1))
  } catch {
    return undefined
  }
  return id === '' ? undefined : { verb: verb as Verb, id }
}

/** How many of the newest threads show before the rest fold away. */
export const VISIBLE_THREADS = 5

// ---- the toolbar and the selection ----

/** The pane facts the selection works from: the threads, what is out of the inbox, and the stored pick. */
type PaneLike = {
  threads: readonly OrchardPaneThread[]
  hidden?: readonly string[]
  snoozed?: readonly { id: string }[]
  isOlderShown?: boolean
  selected?: string | null
}

/** The threads the inbox lists: removed and snoozed ones left out, the older ones folded away. */
export function shownThreads(pane: PaneLike | null | undefined): OrchardPaneThread[] {
  if (pane === null || pane === undefined) return []
  const away = new Set([...(pane.hidden ?? []), ...(pane.snoozed ?? []).map(s => s.id)])
  const threads = pane.threads.filter(t => !away.has(t.replyToId))
  return pane.isOlderShown === true ? threads : threads.slice(0, VISIBLE_THREADS)
}

/**
 * The selected thread's id: the stored pick while it is still listed; otherwise (nothing picked, or the
 * pick was removed, snoozed or folded away) the newest unread thread, else the newest. Null with no threads.
 */
export function selectedId(shown: readonly OrchardPaneThread[], stored: string | null | undefined): string | null {
  if (stored !== null && stored !== undefined && shown.some(t => t.replyToId === stored)) return stored
  return (shown.find(t => t.isUnread) ?? shown[0])?.replyToId ?? null
}

/** The thread to select once `id` leaves the list: the one after it, else the one before it; null when it was the last. */
export function neighbourOf(shown: readonly OrchardPaneThread[], id: string): string | null {
  const at = shown.findIndex(t => t.replyToId === id)
  if (at < 0) return null
  return (shown[at + 1] ?? shown[at - 1])?.replyToId ?? null
}

export type ToolbarItem = { verb: Verb; label: string; hotkey: string }

export type ToolbarState = {
  /** An alert for the selected message is waiting in the queue (not delivered yet). */
  isPending: boolean
  /** It was marked "handle next". */
  isNext: boolean
  /** The thread has an address in Orchard's browser UI. */
  hasHref: boolean
}

/**
 * The toolbar's buttons for the selected thread, in order, each with its hotkey.
 * - a message not delivered yet: all of them.
 * - a message already delivered: ▲ ▼ Remove Open More. Snooze, Handle next and Interrupt would have to bring a
 *   delivered message back as a new alert, which this mod does not do (a Button has no disabled look, so they are left out).
 * - already marked "handle next": that button is left out (the pane says "next ✓" in its place).
 */
export function toolbarItems(state: ToolbarState): ToolbarItem[] {
  const all: (ToolbarItem | null)[] = [
    { verb: 'select-prev', label: '▲', hotkey: 'k' },
    { verb: 'select-next', label: '▼', hotkey: 'j' },
    { verb: 'remove', label: 'Remove', hotkey: 'x' },
    state.isPending ? { verb: 'snooze', label: 'Snooze', hotkey: 's' } : null,
    state.isPending && !state.isNext ? { verb: 'next', label: 'Handle next', hotkey: 'n' } : null,
    state.isPending ? { verb: 'interrupt', label: 'Interrupt', hotkey: 'i' } : null,
    state.hasHref ? { verb: 'open-thread', label: 'Open ↗', hotkey: 'o' } : null,
    { verb: 'more', label: 'More', hotkey: 'm' },
  ]
  return all.filter((item): item is ToolbarItem => item !== null)
}

/** The question the toolbar asks in place of its buttons; it names the message so it cannot be mistaken. */
export function confirmQuestion(verb: 'remove' | 'interrupt', sender: string): string {
  return verb === 'remove' ? `Remove ${sender}'s message?` : `Interrupt Claude with ${sender}'s message?`
}

// ---- snoozed alerts ----

/** An alert set aside until `until` (clock ms). The alert itself is kept, since the queue no longer has it. */
export type Snooze = { id: string; until: number; alert: OrchardAlert }

export const snoozeKey = (endpoint: string, participantId: string) => `snoozed ${endpoint} ${participantId}`
export const hiddenKey = (endpoint: string, participantId: string) => `hidden ${endpoint} ${participantId}`

function isAlert(value: unknown): value is OrchardAlert {
  if (value === null || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  return typeof a.id === 'string' && typeof a.senderId === 'string' && typeof a.body === 'string' && typeof a.sequence === 'number' && Array.isArray(a.reasons)
}

/** The stored snoozes; entries that are not one are left out. */
export function parseSnoozes(value: unknown): Snooze[] {
  if (!Array.isArray(value)) return []
  const out: Snooze[] = []
  for (const raw of value) {
    const entry = raw as { id?: unknown; until?: unknown; alert?: unknown } | null
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || typeof entry.until !== 'number' || !Number.isFinite(entry.until) || !isAlert(entry.alert) || entry.alert.id !== entry.id) continue
    out.push({ id: entry.id, until: entry.until, alert: entry.alert })
  }
  return out.slice(-MAX_SNOOZED)
}

/** The list with `alert` snoozed until `until`; the same id snoozed again only moves its time. */
export function addSnooze(list: readonly Snooze[], alert: OrchardAlert, until: number): Snooze[] {
  const { nextAt: _dropped, ...plain } = alert
  return [...list.filter(s => s.id !== alert.id), { id: alert.id, until, alert: plain }].slice(-MAX_SNOOZED)
}

/** The snoozes whose time has come, and the rest. */
export function splitDue(list: readonly Snooze[], now: number): { due: Snooze[]; rest: Snooze[] } {
  return { due: list.filter(s => s.until <= now), rest: list.filter(s => s.until > now) }
}

/** When the earliest snooze ends; null with none. */
export function nextDue(list: readonly Snooze[]): number | null {
  return list.length === 0 ? null : Math.min(...list.map(s => s.until))
}

/** A snoozed alert coming back: new to the queue, so its batch window runs from `now`. */
export function revive(snooze: Snooze, now: number): OrchardAlert {
  return { ...snooze.alert, arrivedAt: now }
}

export function parseHidden(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-MAX_HIDDEN) : []
}

export function addHidden(list: readonly string[], id: string): string[] {
  return [...list.filter(x => x !== id), id].slice(-MAX_HIDDEN)
}

/** `14:32`, in the person's own time zone. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "2 snoozed · back 14:32" (the earliest); null with none. */
export function snoozedLine(snoozed: readonly { until: number }[]): string | null {
  if (snoozed.length === 0) return null
  return `${snoozed.length} snoozed · back ${clockTime(Math.min(...snoozed.map(s => s.until)))}`
}
