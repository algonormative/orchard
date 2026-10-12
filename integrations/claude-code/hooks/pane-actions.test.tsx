// The pane's quick actions: the pure pieces (addresses, action lines, queue order, snoozes) as
// tables, then each action end to end on the mock clock: remove, snooze, handle next, interrupt,
// the two-step question, the link presses and the hover structure.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  ACTION_ORIGIN,
  CONFIRM_MS,
  SNOOZE_MS,
  VERBS,
  actionHref,
  addHidden,
  addSnooze,
  clockTime,
  detailActions,
  hiddenKey,
  headerActions,
  nextDue,
  parseActionHref,
  parseHidden,
  parseSnoozes,
  revive,
  rowActions,
  snoozeKey,
  snoozedLine,
  splitDue,
} from './actions'
import type { RowState } from './actions'
import { renderPane } from './pane'
import { MAX_ITEMS_PER_DELIVERY, addToQueue, byQueueOrder, markNext, storeKey, takeBatch } from './alerts'
import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
import { act, begin, world } from './test-world'
import type { World } from './test-world'
import type { OrchardAlert, OrchardQueue } from '../types'

const INBOX = storeKey(ENDPOINT, ME)
const SNOOZED = snoozeKey(ENDPOINT, ME)
const HIDDEN = hiddenKey(ENDPOINT, ME)
const PANE_PROPS = { title: 'Orchard', isFocused: false } as never

const alert = (id: string, sequence: number, extra: Partial<OrchardAlert> = {}): OrchardAlert => ({
  id,
  sequence,
  senderId: 'claude-other',
  senderName: 'Other Claude',
  kind: 'message',
  reasons: ['direct'],
  body: `body of ${id}`,
  bodyCut: 0,
  threadId: null,
  where: 'direct',
  channelId: null,
  sentAt: '2026-10-10T09:00:00Z',
  arrivedAt: 1_000,
  ...extra,
})
const queueOf = (...items: OrchardAlert[]): OrchardQueue => ({ items, cursor: 9, lastWakeAt: null, scope: 's', dropped: 0 })
const ids = (items: readonly { id: string }[]) => items.map(i => i.id)

// ---- pure pieces ----

test('action addresses round-trip, and only ours parse', () => {
  for (const verb of VERBS) {
    const id = 'msg/with weird?chars#&é'
    expect(actionHref(verb, id).startsWith(`${ACTION_ORIGIN}/${verb}/`)).toBe(true)
    expect(parseActionHref(actionHref(verb, id))).toEqual({ verb, id })
  }
  expect(parseActionHref(actionHref('refresh'))).toEqual({ verb: 'refresh', id: '-' })
  for (const bad of [
    'https://example.com/remove/m1',
    'http://orchard.action/remove/m1',
    `${ACTION_ORIGIN}/remove`,
    `${ACTION_ORIGIN}/remove/`,
    `${ACTION_ORIGIN}/delete-everything/m1`,
    `${ACTION_ORIGIN}/remove/%E0%A4%A`,
    '',
  ]) {
    expect(parseActionHref(bad), bad).toBeUndefined()
  }
})

test('the action line of a row, by state', () => {
  const base: RowState = { id: 'm1', isPending: true, isNext: false, isOpen: false, confirm: null }
  const labels = (state: RowState) => rowActions(state).text.match(/\[([^\]]+)\]/g)?.map(l => l.slice(1, -1))
  expect(labels(base)).toEqual(['remove', 'snooze 30m', 'handle next', 'interrupt', 'more ▾'])
  expect(labels({ ...base, isOpen: true })).toEqual(['remove', 'snooze 30m', 'handle next', 'interrupt', 'less ▴'])
  // already marked: shown as done, not as a link
  expect(rowActions({ ...base, isNext: true }).text).toContain(' next ✓ ')
  expect(labels({ ...base, isNext: true })).toEqual(['remove', 'snooze 30m', 'interrupt', 'more ▾'])
  // delivered: a message Claude already has can be removed, not brought back
  expect(labels({ ...base, isPending: false })).toEqual(['remove', 'more ▾'])
  // asking
  expect(rowActions({ ...base, confirm: 'remove' }).text).toBe(`remove? [✓](${actionHref('remove-yes', 'm1')}) [✗](${actionHref('cancel', 'm1')})`)
  expect(rowActions({ ...base, confirm: 'interrupt' }).text).toBe(`interrupt Claude? [✓](${actionHref('interrupt-yes', 'm1')}) [✗](${actionHref('cancel', 'm1')})`)
  // every link in the text is in the list, and nothing else is
  for (const state of [base, { ...base, isPending: false }, { ...base, confirm: 'remove' as const }, { ...base, isNext: true }]) {
    const line = rowActions(state)
    expect([...line.text.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1])).toEqual(line.links)
  }
  expect(headerActions(true).text).toBe(`[Open in Orchard ↗](${actionHref('open-workspace')}) · [Refresh](${actionHref('refresh')})`)
  expect(headerActions(false).links).toEqual([actionHref('refresh')])
  expect(detailActions('m1', false).links).toEqual([actionHref('reply', 'm1')])
})

test('handle next puts an alert first and keeps it there; the latest marked leads', () => {
  const q = queueOf(alert('a', 1), alert('b', 2), alert('c', 3))
  const one = markNext(q, 'c', 5_000)
  expect(ids(one.items)).toEqual(['c', 'a', 'b'])
  expect(one.items[0]?.nextAt).toBe(5_000)
  const two = markNext(one, 'b', 6_000)
  expect(ids(two.items)).toEqual(['b', 'c', 'a'])
  // an id that is not pending changes nothing
  expect(markNext(q, 'zzz', 1)).toBe(q)
  // a new page does not push it back into sequence order
  const added = addToQueue(two, [alert('d', 4), alert('0', 0)], 12, [], () => true)
  expect(ids(added.items)).toEqual(['b', 'c', '0', 'a', 'd'])
  expect([...added.items].sort(byQueueOrder)).toEqual(added.items)
})

test('takeBatch leads with a marked alert even when the batch is full, and a marked quiet alert is the one that is reserved', () => {
  const quiet = alert('q', 100, { reasons: ['broadcast'] })
  const many = Array.from({ length: MAX_ITEMS_PER_DELIVERY + 5 }, (_, i) => alert(`m${i}`, i + 1))
  const marked = markNext(queueOf(...many, quiet), 'q', 9_000)
  const isWake = (a: OrchardAlert) => a.nextAt !== undefined || a.reasons.includes('direct')
  const batch = takeBatch(marked, new Set(), isWake)
  expect(batch).toHaveLength(MAX_ITEMS_PER_DELIVERY)
  expect(batch[0]?.id).toBe('q')
  expect(ids(batch.slice(1, 4))).toEqual(['m0', 'm1', 'm2'])
  // unmarked: the quiet one is last in line and does not make the cut
  expect(ids(takeBatch(queueOf(...many, quiet), new Set(), isWake)).includes('q')).toBe(false)
  // a skipped (in flight) marked alert is not taken
  expect(ids(takeBatch(marked, new Set(['q']), isWake)).includes('q')).toBe(false)
})

test('snoozes: kept with their alert, due by time, parsed defensively', () => {
  const a = alert('a', 1, { nextAt: 5 })
  const b = alert('b', 2)
  let list = addSnooze([], a, 2_000)
  list = addSnooze(list, b, 1_000)
  expect(list.map(s => s.id)).toEqual(['a', 'b'])
  expect(list[0]?.alert.nextAt).toBeUndefined()
  // snoozing again moves the time, it does not duplicate
  expect(addSnooze(list, a, 9_000).map(s => [s.id, s.until])).toEqual([['b', 1_000], ['a', 9_000]])
  expect(nextDue(list)).toBe(1_000)
  expect(nextDue([])).toBeNull()
  expect(splitDue(list, 1_500)).toEqual({ due: [list[1]], rest: [list[0]] })
  expect(splitDue(list, 2_000).due).toHaveLength(2)
  expect(revive(list[1]!, 77).arrivedAt).toBe(77)
  expect(parseSnoozes(JSON.parse(JSON.stringify(list)))).toEqual(list)
  expect(parseSnoozes('nope')).toEqual([])
  expect(parseSnoozes([{ id: 'a', until: 'soon', alert: a }, { id: 'a', until: 1, alert: { id: 'other' } }, null, { id: 'a', until: 1, alert: a }]).map(s => s.id)).toEqual(['a'])
  expect(parseHidden(['x', 3, 'y'])).toEqual(['x', 'y'])
  expect(parseHidden(undefined)).toEqual([])
  expect(addHidden(['x', 'y'], 'x')).toEqual(['y', 'x'])
  expect(snoozedLine([])).toBeNull()
  const t = Date.UTC(2026, 9, 12, 12, 0)
  expect(snoozedLine([{ until: t + SNOOZE_MS }, { until: t + 3 * SNOOZE_MS }])).toBe(`2 snoozed · back ${clockTime(t + SNOOZE_MS)}`)
  expect(clockTime(t)).toMatch(/^\d\d:\d\d$/)
})

// ---- end to end ----

function stubTurns(on: Parameters<typeof world>[0]) {
  const aborted: string[] = []
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.abort', async (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined } as never
  })
  return aborted
}

const dm = (w: World, id: string, extra: Record<string, unknown> = {}) =>
  w.fake.push({ id, body: `body of ${id}`, sender_id: 'claude-other', sent_at: '2026-10-10T09:00:00Z', ...extra }, { reasons: ['direct'] })
const broadcast = (w: World, id: string) =>
  w.fake.push({ id, body: `body of ${id}`, sender_id: 'claude-other', destination: { kind: 'broadcast' }, recipient_ids: [ME, 'owner'], sent_at: '2026-10-10T09:00:00Z' }, { reasons: ['broadcast'] })

const queuedIds = (w: World) => ids((w.state.latest.queue as OrchardQueue).items)
const record = (w: World) => w.store.data.get(INBOX) as { cursor: number; delivered: string[] }

async function openPane($: Engine, w: World, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal') {
  await $.command.run({ command: 'orchard', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
  await w.clock.settle()
  return $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
}

const lineOf = async (ui: Awaited<ReturnType<typeof openPane>>, id: string) => String((await ui.find({ type: 'Markdown', key: `actions-${id}` }))?.props.text)
const hasRow = async (ui: Awaited<ReturnType<typeof openPane>>, id: string) => (await ui.find({ type: 'Markdown', key: `actions-${id}` })) !== undefined

test('remove asks first: ✗ and the 10 s lapse change nothing, ✓ acknowledges, forgets and hides', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  broadcast(w, 'b1')
  await w.clock.settle()
  expect(queuedIds(w)).toEqual(['b1'])
  const ui = await openPane($, w)
  const asked = `remove? [✓](${actionHref('remove-yes', 'b1')}) [✗](${actionHref('cancel', 'b1')})`

  // a ✓ that answers no question is ignored
  await act(ui, 'remove-yes', 'b1')
  await w.clock.settle()
  expect(w.fake.acks).toEqual([])
  expect(queuedIds(w)).toEqual(['b1'])

  await act(ui, 'remove', 'b1')
  await w.clock.settle()
  expect(await lineOf(ui, 'b1')).toBe(asked)
  expect(w.fake.acks).toEqual([])

  // ✗ puts the row back as it was
  await act(ui, 'cancel', 'b1')
  await w.clock.settle()
  expect(await lineOf(ui, 'b1')).toContain('snooze 30m')
  expect(queuedIds(w)).toEqual(['b1'])

  // unanswered for 10 s: the question lapses, and a late ✓ is nothing
  await act(ui, 'remove', 'b1')
  await w.clock.settle()
  await w.clock.advance(CONFIRM_MS - 1)
  expect(await lineOf(ui, 'b1')).toBe(asked)
  await w.clock.advance(1)
  expect(await lineOf(ui, 'b1')).toContain('snooze 30m')
  await act(ui, 'remove-yes', 'b1')
  await w.clock.settle()
  expect(w.fake.acks).toEqual([])

  // ✓
  await act(ui, 'remove', 'b1')
  await act(ui, 'remove-yes', 'b1')
  await w.clock.settle()
  expect(w.fake.acks).toHaveLength(1)
  expect(w.fake.acks[0]?.ids).toEqual(['b1'])
  expect(w.fake.acks[0]?.requestId).toMatch(/^orchard-ack-/)
  expect(queuedIds(w)).toEqual([])
  expect(record(w).delivered).toContain('b1')
  expect(w.store.data.get(HIDDEN)).toEqual(['b1'])
  expect(w.state.latest.counts).toMatchObject({ unread: 0, forYou: 0 })
  expect(await hasRow(ui, 'b1')).toBe(false)

  // never delivered to Claude: not by a wake, not by the next prompt, not when the server offers it again
  await w.clock.advance(5 * 60_000)
  expect(w.submits).toEqual([])
  w.fake.push({ id: 'b1', sequence: 1, body: 'again', sender_id: 'claude-other', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
  await w.clock.advance(5 * 60_000)
  expect(w.submits).toEqual([])
  expect(queuedIds(w)).toEqual([])

  // and it stays hidden after the window is read again
  await act(ui, 'refresh')
  await w.clock.settle()
  expect(await hasRow(ui, 'b1')).toBe(false)
})

test('a message Claude already has can be removed (ack + hide); the other actions are not offered', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  const acksAfterDelivery = w.fake.acks.length
  const ui = await openPane($, w)

  const line = await lineOf(ui, 'd1')
  expect(line).toContain('[remove]')
  expect(line.includes('snooze')).toBe(false)
  expect(line.includes('handle next')).toBe(false)
  expect(line.includes('interrupt')).toBe(false)
  // pressing one anyway (a stale link) does nothing
  for (const verb of ['snooze', 'next', 'interrupt'] as const) await act(ui, verb, 'd1')
  await w.clock.settle()
  expect(await lineOf(ui, 'd1')).toBe(line)

  await act(ui, 'remove', 'd1')
  await act(ui, 'remove-yes', 'd1')
  await w.clock.settle()
  expect(w.fake.acks).toHaveLength(acksAfterDelivery + 1)
  expect(w.fake.acks.at(-1)?.ids).toEqual(['d1'])
  expect(await hasRow(ui, 'd1')).toBe(false)
  expect(w.submits).toHaveLength(1)
})

test('snooze takes it out for 30 minutes, keeps it in the store, and brings it back as a new alert', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()
  await w.clock.advance(2_000)
  const ui = await openPane($, w)
  const start = w.clock.now()

  await act(ui, 'snooze', 'd1')
  await w.clock.settle()
  expect(queuedIds(w)).toEqual([])
  const stored = w.store.data.get(SNOOZED) as { id: string; until: number; alert: OrchardAlert }[]
  expect(stored.map(s => [s.id, s.until])).toEqual([['d1', start + SNOOZE_MS]])
  expect(stored[0]?.alert.body).toBe('body of d1')
  expect(w.state.latest.counts).toMatchObject({ unread: 0, forYou: 0 })
  expect(await hasRow(ui, 'd1')).toBe(false)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain(`1 snoozed · back ${clockTime(start + SNOOZE_MS)}`)

  // not delivered while snoozed, and not acknowledged
  await w.clock.advance(SNOOZE_MS - 1_000)
  expect(w.submits).toEqual([])
  expect(queuedIds(w)).toEqual([])
  expect(w.fake.acks).toEqual([])

  // due: back in the queue as new, then it wakes by the ordinary rule (batch window from now)
  await w.clock.advance(1_000)
  expect(queuedIds(w)).toEqual(['d1'])
  expect(w.store.data.get(SNOOZED)).toEqual([])
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 1 })
  expect(w.submits).toEqual([])
  expect((w.state.latest.queue as OrchardQueue).items[0]?.arrivedAt).toBe(w.clock.now())
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]?.text).toContain('body of d1')
  expect(await hasRow(ui, 'd1')).toBe(true)
})

test('a snooze survives a reload: the stored one comes back at its time', { options: OPTIONS }, async ($, on) => {
  const w = world(on, { store: { [SNOOZED]: [{ id: 'd9', until: 1_000_000 + 600_000, alert: alert('d9', 5, { arrivedAt: 1 }) }] } })
  await w.clock.advance(1_000_000)
  await begin($, w)
  expect(queuedIds(w)).toEqual([])
  await w.clock.advance(600_000)
  expect(queuedIds(w)).toEqual(['d9'])
})

test('handle next makes a quiet broadcast wake and puts it ahead of the rest of the delivery', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  broadcast(w, 'b1')
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 2, forYou: 1 })
  const ui = await openPane($, w)
  expect(await lineOf(ui, 'b1')).toContain('handle next')

  await act(ui, 'next', 'b1')
  await w.clock.settle()
  expect(queuedIds(w)).toEqual(['b1', 'd1'])
  expect(w.state.latest.counts).toMatchObject({ unread: 2, forYou: 2 })
  expect(await lineOf(ui, 'b1')).toContain('next ✓')
  expect(await lineOf(ui, 'b1')).not.toContain('[handle next]')

  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  const text = w.submits[0]?.text ?? ''
  expect(text.indexOf('body of b1')).toBeGreaterThan(-1)
  expect(text.indexOf('body of b1')).toBeLessThan(text.indexOf('body of d1'))
})

test('handle next alone wakes the session for a quiet message, respecting the minimum gap', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  const wokeAt = w.clock.now()

  broadcast(w, 'b1')
  await w.clock.settle()
  const ui = await openPane($, w)
  await w.clock.advance(20_000)
  expect(w.submits).toHaveLength(1)
  await act(ui, 'next', 'b1')
  await w.clock.settle()
  expect(w.submits).toHaveLength(1)
  await w.clock.advance(39_000)
  expect(w.submits).toHaveLength(1)
  await w.clock.advance(1_000)
  expect(w.submits).toHaveLength(2)
  expect(w.submits[1]?.text).toContain('body of b1')
  expect(w.clock.now() - wokeAt).toBeGreaterThanOrEqual(60_000)
})

test('handle next keeps the cursor behind anything still waiting', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const total = MAX_ITEMS_PER_DELIVERY + 1
  for (let i = 1; i <= total; i++) broadcast(w, `b${i}`)
  await w.clock.settle()
  const ui = await openPane($, w, 'terminal')
  // older threads fold away; the newest is the last broadcast
  await act(ui, 'next', `b${total}`)
  await w.clock.settle()
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  const text = w.submits[0]?.text ?? ''
  expect(text.indexOf(`body of b${total}\n`)).toBeGreaterThan(-1)
  expect(text.indexOf(`body of b${total}\n`)).toBeLessThan(text.indexOf('body of b1\n'))
  // one alert did not fit and is still pending; the stored cursor stops before it
  expect(queuedIds(w)).toEqual([`b${total - 1}`])
  const waiting = w.fake.messages.find(m => m.id === `b${total - 1}`)!.sequence
  expect(record(w).cursor).toBe(waiting - 1)
  expect(record(w).delivered).toContain(`b${total}`)
})

test('interrupt asks first; ✓ aborts the running turn and delivers that message at once, once', { options: OPTIONS }, async ($, on) => {
  const aborted = stubTurns(on)
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: 'working', turnId: 'turn-1' })
  dm(w, 'd1')
  await w.clock.settle()
  const ui = await openPane($, w)

  await act(ui, 'interrupt', 'd1')
  await w.clock.settle()
  expect(await lineOf(ui, 'd1')).toBe(`interrupt Claude? [✓](${actionHref('interrupt-yes', 'd1')}) [✗](${actionHref('cancel', 'd1')})`)
  expect(aborted).toEqual([])
  expect(w.submits).toEqual([])

  // ✗ changes nothing
  await act(ui, 'cancel', 'd1')
  await w.clock.settle()
  expect(aborted).toEqual([])
  expect(await lineOf(ui, 'd1')).toContain('interrupt]')

  // ✓: abort, then deliver now, past the 10 s batch window
  await act(ui, 'interrupt', 'd1')
  await act(ui, 'interrupt-yes', 'd1')
  await w.clock.settle()
  expect(aborted).toEqual(['turn-1'])
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: 'orchard' })
  expect(w.submits[0]?.text).toContain('body of d1')
  expect(queuedIds(w)).toEqual([])
  expect(w.fake.acks.map(a => a.ids)).toEqual([['d1']])
  expect(record(w).delivered).toContain('d1')

  // exactly once: the wake that was due does not send it again
  await w.clock.advance(5 * 60_000)
  expect(w.submits).toHaveLength(1)
})

test('interrupt on an idle session aborts nothing; it delivers past the batch window and the gap, and starts a new gap', { options: OPTIONS }, async ($, on) => {
  const aborted = stubTurns(on)
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)

  dm(w, 'd2')
  await w.clock.settle()
  const ui = await openPane($, w)
  await act(ui, 'interrupt', 'd2')
  await act(ui, 'interrupt-yes', 'd2')
  await w.clock.settle()
  // only 0 s into a 60 s gap, yet it went
  expect(aborted).toEqual([])
  expect(w.submits).toHaveLength(2)
  expect(w.submits[1]?.text).toContain('body of d2')
  expect(w.submits[1]?.text.includes('body of d1')).toBe(false)
  expect((w.state.latest.queue as OrchardQueue).lastWakeAt).toBe(w.clock.now())

  // the gap now runs from the interruption
  dm(w, 'd3')
  await w.clock.advance(30_000)
  expect(w.submits).toHaveLength(2)
  await w.clock.advance(30_000)
  expect(w.submits).toHaveLength(3)
})

test('interrupt does not take a message a wake already has in flight', { options: OPTIONS }, async ($, on) => {
  const aborted = stubTurns(on)
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()
  const ui = await openPane($, w)
  // the wake's prompt waits behind a running turn
  let release!: () => void
  w.submit.hold = new Promise<void>(resolve => (release = resolve))
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)

  await act(ui, 'interrupt', 'd1')
  await act(ui, 'interrupt-yes', 'd1')
  await w.clock.settle()
  expect(w.submits).toHaveLength(1)
  expect(aborted).toEqual([])
  release()
  await w.clock.settle()
  expect(w.submits).toHaveLength(1)
})

// ---- links and hover ----

test('every action link is ours, listed, and pressing one opens nothing; unknown links do nothing', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  broadcast(w, 'b1')
  await w.clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await openPane($, w, surface)
    const all = await ui.findAll({ type: 'Markdown' })
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (const m of all) {
      const written = [...String(m.props.text).matchAll(/\]\(([^)]+)\)/g)].map(x => x[1])
      expect(written.length).toBeGreaterThan(0)
      expect(m.props.pressableLinks).toEqual(written)
      for (const href of written) expect(href!.startsWith(`${ACTION_ORIGIN}/`)).toBe(true)
    }
    // a link that is not one of ours, or names no action, is nothing
    await ui.press({ key: 'actions-d1', link: { href: 'https://example.com/remove/d1' } })
    await ui.press({ key: 'actions-d1', link: { href: `${ACTION_ORIGIN}/format-disk/d1` } })
    await w.clock.settle()
    expect(queuedIds(w).sort(), surface).toEqual(['b1', 'd1'])
    expect(w.fake.acks).toEqual([])
    await ui.unmount()
  }

  // the row verbs open no browser, whatever they do
  const ui = await openPane($, w, 'terminal')
  for (const [verb, id] of [['remove', 'b1'], ['cancel', 'b1'], ['next', 'b1'], ['snooze', 'd1']] as const) {
    await act(ui, verb, id)
    await w.clock.settle()
  }
  expect(w.fake.opened).toEqual([])
  expect(w.fake.calls.some(c => c.argv[0] === 'open')).toBe(false)
})

test('on a surface with a pointer the action line is revealed by hovering the row; elsewhere it is simply there', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()

  const hidden = async (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') => {
    const ui = await openPane($, w, surface)
    const boxes = await ui.findAll({ type: 'Box' })
    const reveal = boxes.filter(b => b.props.display === 'none')
    const dim = (await ui.find({ type: 'Markdown', key: 'actions-d1' }))?.props.dimColor
    const result = { reveal, dim, keyed: reveal.some(b => b.key !== undefined && b.key !== '') }
    await ui.unmount()
    return result
  }

  for (const surface of ['desktop', 'vscode'] as const) {
    const r = await hidden(surface)
    expect(r.reveal, surface).toHaveLength(1)
    // the revealed Box is not keyed (a keyed Box is its own scope, and one that is not drawn cannot be hovered)
    expect(r.keyed).toBe(false)
  }
  // the terminal has no hover: the line is always there, dimmed
  const terminal = await hidden('terminal')
  expect(terminal.reveal).toEqual([])
  expect(terminal.dim).toBe(true)
  // so has a phone no hover: always there
  expect((await hidden('mobile')).reveal).toEqual([])
})

test('while a question is on a row the line is not hover-only, so it cannot vanish with the pointer', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()
  const ui = await openPane($, w, 'desktop')
  const reveals = async () => (await ui.findAll({ type: 'Box' })).filter(b => b.props.display === 'none').length
  expect(await reveals()).toBe(1)
  await act(ui, 'remove', 'd1')
  await w.clock.settle()
  expect(await reveals()).toBe(0)
  await act(ui, 'cancel', 'd1')
  await w.clock.settle()
  expect(await reveals()).toBe(1)
})

test('the header says whose inbox it is', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const terminal = await openPane($, w, 'terminal')
  const texts = (await terminal.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain("◆ Claude's inbox · Fruit Stand")
  expect(texts).toContain(` · as ${ME}`)
  await terminal.unmount()
  const desktop = await openPane($, w, 'desktop')
  const header = (await desktop.findAll({ type: 'Svg' }))[0]
  expect(String(header?.props.source)).toContain("Claude&#39;s inbox · Fruit Stand")
  expect(String(header?.props.source)).toContain(`as ${ME}`)
})

test('the revealed Box carries `hover: { display: "flex" }` and no key (read off the pane as drawn, since a mount does not report hover)', () => {
  type Node = { type: unknown; props: Record<string, unknown>; hover?: unknown; children?: unknown }
  const Box = 'Box'
  const plain = (name: string) => name as never
  const table = { Box: Box as never, Text: plain('Text'), Button: plain('Button'), Markdown: plain('Markdown') }
  const view = {
    participantId: ME,
    workspaceName: 'Fruit Stand',
    workspaceHref: null,
    settings: { defaultLevel: 'participating', channels: {}, batchSeconds: 10, gapSeconds: 60 } as never,
    status: { kind: 'connected' } as never,
    counts: null,
    nowMs: Date.parse('2026-10-10T10:00:00Z'),
    pendingIds: new Set(['d1']),
    pane: {
      state: 'ready',
      error: null,
      decisions: [],
      tasks: [],
      channels: [],
      threads: [{ replyToId: 'd1', size: 1, href: null, reason: 'DM', isUnread: true, last: { id: 'd1', senderName: 'Other', isOwner: false, isMine: false, snippet: 'hi', sentAt: '2026-10-10T09:00:00Z' } }],
    } as never,
  }
  const handlers = { act: () => undefined, open: () => undefined, setLevel: () => undefined, setRate: () => undefined, toggleOlder: () => undefined }
  const found = (surface: 'desktop' | 'terminal') => {
    const out: Node[] = []
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (node === null || typeof node !== 'object') return
      const n = node as Node
      if (n.type === Box && n.props?.display === 'none') out.push(n)
      walk(n.children)
    }
    walk(renderPane(table, { ...view, surface }, handlers))
    return out
  }
  const reveal = found('desktop')
  expect(reveal).toHaveLength(1)
  expect(reveal[0]?.hover).toEqual({ display: 'flex' })
  expect(reveal[0]?.props.key).toBeUndefined()
  expect(found('terminal')).toEqual([])
})
