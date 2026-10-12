// The pane's quick actions as plain data: the synthetic addresses a Markdown link carries, the
// action line of a row, and the snooze and hidden records kept in `$.store`. No `$` here;
// register.tsx performs the actions.
//
// The links are `https://orchard.action/<verb>/<id>`. They exist only so a Markdown draws them as
// links (it draws a link only for http, https or file): they are listed in `pressableLinks`,
// answered by `onLinkPress`, and never opened by anything.
import type { OrchardAlert } from '../types'

export const ACTION_ORIGIN = 'https://orchard.action'

/** How long a snooze lasts. */
export const SNOOZE_MS = 30 * 60_000
/** How long a "remove? ✓ ✗" waits for an answer before it lapses. */
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

export type ActionLine = {
  /** Markdown: links separated by a middle dot. */
  text: string
  /** Every address in `text`, for `pressableLinks`. */
  links: string[]
}

function line(parts: readonly (string | { label: string; href: string })[], separator = ' · '): ActionLine {
  const links: string[] = []
  const text = parts
    .map(part => {
      if (typeof part === 'string') return part
      links.push(part.href)
      return `[${part.label}](${part.href})`
    })
    .join(separator)
  return { text, links }
}

export type RowState = {
  /** The message the actions apply to: the thread's reply id. */
  id: string
  /** An alert for it is waiting in the queue (not delivered yet). */
  isPending: boolean
  /** It was marked "handle next". */
  isNext: boolean
  /** The row's detail is open. */
  isOpen: boolean
  /** The two-step question this row is asking, if any. */
  confirm: 'remove' | 'interrupt' | null
}

/**
 * The action line of a thread row.
 * - asking: `remove? ✓ ✗` or `interrupt Claude? ✓ ✗`, nothing else.
 * - a message not delivered yet: remove · snooze · handle next · interrupt · more.
 * - a message already delivered: remove · more. Snooze, handle next and interrupt would have to
 *   bring a delivered message back as a new alert, which this mod does not do.
 */
export function rowActions(state: RowState): ActionLine {
  const { id } = state
  if (state.confirm !== null) {
    const question = state.confirm === 'remove' ? 'remove?' : 'interrupt Claude?'
    const yes = actionHref(state.confirm === 'remove' ? 'remove-yes' : 'interrupt-yes', id)
    return line([question, { label: '✓', href: yes }, { label: '✗', href: actionHref('cancel', id) }], ' ')
  }
  const more = { label: state.isOpen ? 'less ▴' : 'more ▾', href: actionHref('more', id) }
  const remove = { label: 'remove', href: actionHref('remove', id) }
  if (!state.isPending) return line([remove, more])
  return line([
    remove,
    { label: 'snooze 30m', href: actionHref('snooze', id) },
    state.isNext ? 'next ✓' : { label: 'handle next', href: actionHref('next', id) },
    { label: 'interrupt', href: actionHref('interrupt', id) },
    more,
  ])
}

/** The second line of an open row: reply and open the thread. */
export function detailActions(id: string, hasHref: boolean): ActionLine {
  const reply = { label: 'reply…', href: actionHref('reply', id) }
  return hasHref ? line([reply, { label: 'open thread ↗', href: actionHref('open-thread', id) }]) : line([reply])
}

export function headerActions(hasWorkspace: boolean): ActionLine {
  const refresh = { label: 'Refresh', href: actionHref('refresh') }
  return hasWorkspace ? line([{ label: 'Open in Orchard ↗', href: actionHref('open-workspace') }, refresh]) : line([refresh])
}

/** "answer in Orchard ↗" for a decision waiting on the owner. */
export function answerLink(id: string): ActionLine {
  return line([{ label: 'answer in Orchard ↗', href: actionHref('answer', id) }])
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
