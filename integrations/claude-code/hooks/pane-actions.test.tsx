// The pane's quick actions: the pure pieces (addresses, action lines, queue order, snoozes) as
// tables, then each action end to end on the mock clock: remove, snooze, handle next, interrupt,
// the two-step question, and the toolbar and selection model on every surface.
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
  hiddenKey,
  confirmQuestion,
  neighbourOf,
  selectedId,
  shownThreads,
  toolbarItems,
  VISIBLE_THREADS,
  nextDue,
  parseActionHref,
  parseHidden,
  parseSnoozes,
  revive,
  snoozeKey,
  snoozedLine,
  splitDue,
} from './actions'
import { rowLinkText, rowMarkSvg } from './svg'
import { renderPane } from './pane'
import { MAX_ITEMS_PER_DELIVERY, addToQueue, byQueueOrder, markNext, storeKey, takeBatch } from './alerts'
import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
import { act, begin, select, world } from './test-world'
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

test('the toolbar for a thread, by state; hotkeys are one lowercase letter each and never clash', () => {
  const base = { isPending: true, isNext: false, hasHref: true }
  const keys = (state: typeof base) => toolbarItems(state).map(i => `${i.hotkey}:${i.label}`)
  expect(keys(base)).toEqual(['k:▲', 'j:▼', 'x:Remove', 's:Snooze', 'n:Handle next', 'i:Interrupt', 'o:Open ↗', 'm:More'])
  // already marked: Handle next gives way (the pane says "next ✓")
  expect(keys({ ...base, isNext: true })).toEqual(['k:▲', 'j:▼', 'x:Remove', 's:Snooze', 'i:Interrupt', 'o:Open ↗', 'm:More'])
  // delivered: a message Claude already has can be removed, not brought back
  expect(keys({ ...base, isPending: false })).toEqual(['k:▲', 'j:▼', 'x:Remove', 'o:Open ↗', 'm:More'])
  // no address in Orchard: nothing to open
  expect(keys({ ...base, hasHref: false }).includes('o:Open ↗')).toBe(false)
  // the question names the sender; Confirm is y and Cancel c, apart from the toolbar's letters
  expect(confirmQuestion('remove', 'Nick')).toBe("Remove Nick's message?")
  expect(confirmQuestion('interrupt', 'Nick')).toBe("Interrupt Claude with Nick's message?")
  const letters = [...toolbarItems(base).map(i => i.hotkey), 'y', 'c', 'r']
  expect(new Set(letters).size).toBe(letters.length)
  for (const l of letters) expect(l).toMatch(/^[a-z]$/)
})

const thread = (id: string, isUnread: boolean) =>
  ({ replyToId: id, size: 1, href: null, reason: 'DM', isUnread, last: { id, senderName: 'Other', isOwner: false, isMine: false, snippet: id, sentAt: '2026-10-10T09:00:00Z' } }) as never

test('the selection: defaults to the newest unread, else the newest; a stale pick falls back; a leaver hands over to its neighbour', () => {
  const threads = [thread('a', false), thread('b', true), thread('c', true), thread('d', false)]
  const shown = shownThreads({ threads })
  expect(selectedId(shown, undefined)).toBe('b')
  expect(selectedId(shown, null)).toBe('b')
  expect(selectedId(shown, 'd')).toBe('d')
  // the pick is gone (removed or snoozed): the default again, never a dangling id
  expect(selectedId(shownThreads({ threads, hidden: ['d'] }), 'd')).toBe('b')
  expect(selectedId(shownThreads({ threads, snoozed: [{ id: 'b' }], hidden: ['c'] }), 'b')).toBe('a')
  expect(selectedId([], 'a')).toBeNull()
  expect(selectedId(shownThreads({ threads: [thread('a', false), thread('z', false)] }), 'nope')).toBe('a')
  // folded away counts as gone
  const many = Array.from({ length: VISIBLE_THREADS + 2 }, (_, i) => thread(`t${i}`, false))
  expect(shownThreads({ threads: many })).toHaveLength(VISIBLE_THREADS)
  expect(selectedId(shownThreads({ threads: many }), `t${VISIBLE_THREADS}`)).toBe('t0')
  expect(shownThreads({ threads: many, isOlderShown: true })).toHaveLength(VISIBLE_THREADS + 2)
  // neighbour: the next one down, else the one above, null when alone
  expect(neighbourOf(shown, 'b')).toBe('c')
  expect(neighbourOf(shown, 'd')).toBe('c')
  expect(neighbourOf([thread('a', false)] as never, 'a')).toBeNull()
})

test('the selected row\'s mark carries a citron outline and bar; the others do not', () => {
  for (const isUnread of [true, false]) {
    const t = thread('a', isUnread) as never
    expect(rowMarkSvg(t)).not.toContain('class="sel"')
    expect(rowMarkSvg(t, false)).not.toContain('class="sel"')
    const picked = rowMarkSvg(t, true)
    expect(picked.split('class="sel"').length - 1).toBe(1)
    expect(picked).toContain('class="bar"')
    // a colour token, not a hex literal, so it follows the light/dark theme
    expect(picked.replace(/<style>[\s\S]*<\/style>/, '')).not.toMatch(/(fill|stroke)="#/)
    expect(picked).toContain('.sel{fill:none;stroke:var(--dot)')
  }
})

test('a row\'s words are one link: sender, badge, age and preview, with markup in them kept as plain text', () => {
  const now = Date.parse('2026-10-10T10:00:00Z')
  const t = { ...thread('a', true), size: 3 } as never as ReturnType<typeof thread> & { last: { senderName: string; snippet: string; sentAt: string }; reason: string }
  t.last = { ...t.last, senderName: 'Test [peer]', snippet: 'run `rm *` (now) <b>', sentAt: '2026-10-10T09:58:00Z' }
  t.reason = 'DM'
  const text = rowLinkText(t as never, now, 'https://orchard.action/select/a', '▶ ')
  expect(text).toBe('[▶ **Test \\[peer\\]** · DM · 2m · 3 — run \\`rm \\*\\` \\(now\\) \\<b\\>](https://orchard.action/select/a)')
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

const toolbarKeys = async (ui: Awaited<ReturnType<typeof openPane>>) => (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('tb-'))
const hasRow = async (ui: Awaited<ReturnType<typeof openPane>>, id: string) => (await ui.find({ type: 'Box', key: `thread-${id}` })) !== undefined
const asking = async (ui: Awaited<ReturnType<typeof openPane>>) => (await ui.findAll({ type: 'Text' })).map(t => String(t.text)).find(t => /\?$/.test(t))

test('remove asks first: Cancel and the 10 s lapse change nothing, Confirm acknowledges, forgets and hides', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  broadcast(w, 'b1')
  await w.clock.settle()
  expect(queuedIds(w)).toEqual(['b1'])
  const ui = await openPane($, w)
  const asked = "Remove Other Claude's message?"

  // no question yet: no Confirm to press
  expect(await ui.find({ type: 'Button', key: 'tb-confirm' })).toBeUndefined()
  expect(await asking(ui)).toBeUndefined()

  await act(ui, w, 'remove', 'b1')
  await w.clock.settle()
  expect(await asking(ui)).toBe(asked)
  // the toolbar gives way to the question: Confirm (y) and Cancel (c) only
  expect(await toolbarKeys(ui)).toEqual(['tb-confirm', 'tb-cancel'])
  expect((await ui.find({ type: 'Button', key: 'tb-confirm' }))?.props).toMatchObject({ label: 'Confirm', hotkey: 'y', variant: 'primary' })
  expect((await ui.find({ type: 'Button', key: 'tb-cancel' }))?.props).toMatchObject({ label: 'Cancel', hotkey: 'c' })
  expect(w.fake.acks).toEqual([])

  // Cancel puts the toolbar back as it was
  await ui.press({ key: 'tb-cancel' })
  await w.clock.settle()
  expect(await asking(ui)).toBeUndefined()
  expect(await toolbarKeys(ui)).toContain('tb-snooze')
  expect(queuedIds(w)).toEqual(['b1'])

  // unanswered for 10 s: the question lapses, and a late ✓ is nothing
  await act(ui, w, 'remove', 'b1')
  await w.clock.settle()
  await w.clock.advance(CONFIRM_MS - 1)
  expect(await asking(ui)).toBe(asked)
  await w.clock.advance(1)
  expect(await asking(ui)).toBeUndefined()
  expect(await toolbarKeys(ui)).toContain('tb-snooze')
  expect(await ui.find({ type: 'Button', key: 'tb-confirm' })).toBeUndefined()
  expect(w.fake.acks).toEqual([])

  // Confirm
  await act(ui, w, 'remove', 'b1')
  await act(ui, w, 'remove-yes', 'b1')
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
  await act(ui, w, 'refresh')
  await w.clock.settle()
  expect(await hasRow(ui, 'b1')).toBe(false)
})

test('a message Claude already has can be removed (ack + hide); the other actions are not on its toolbar', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  const acksAfterDelivery = w.fake.acks.length
  const ui = await openPane($, w)

  expect(await toolbarKeys(ui)).toEqual(['tb-select-prev', 'tb-select-next', 'tb-remove', 'tb-open-thread', 'tb-more'])

  await act(ui, w, 'remove', 'd1')
  await act(ui, w, 'remove-yes', 'd1')
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

  await act(ui, w, 'snooze', 'd1')
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
  await select(ui, w, 'b1')
  expect(await toolbarKeys(ui)).toContain('tb-next')

  await act(ui, w, 'next', 'b1')
  await w.clock.settle()
  expect(queuedIds(w)).toEqual(['b1', 'd1'])
  expect(w.state.latest.counts).toMatchObject({ unread: 2, forYou: 2 })
  expect(await toolbarKeys(ui)).not.toContain('tb-next')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('next ✓')

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
  await act(ui, w, 'next', 'b1')
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
  await act(ui, w, 'next', `b${total}`)
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

test('interrupt asks first; Confirm aborts the running turn and delivers that message at once, once', { options: OPTIONS }, async ($, on) => {
  const aborted = stubTurns(on)
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: 'working', turnId: 'turn-1' })
  dm(w, 'd1')
  await w.clock.settle()
  const ui = await openPane($, w)

  await act(ui, w, 'interrupt', 'd1')
  await w.clock.settle()
  expect(await asking(ui)).toBe("Interrupt Claude with Other Claude's message?")
  expect(aborted).toEqual([])
  expect(w.submits).toEqual([])

  // Cancel changes nothing
  await ui.press({ key: 'tb-cancel' })
  await w.clock.settle()
  expect(aborted).toEqual([])
  expect(await toolbarKeys(ui)).toContain('tb-interrupt')

  // Confirm: abort, then deliver now, past the 10 s batch window
  await act(ui, w, 'interrupt', 'd1')
  await act(ui, w, 'interrupt-yes', 'd1')
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
  await act(ui, w, 'interrupt', 'd2')
  await act(ui, w, 'interrupt-yes', 'd2')
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

  await act(ui, w, 'interrupt', 'd1')
  await act(ui, w, 'interrupt-yes', 'd1')
  await w.clock.settle()
  expect(w.submits).toHaveLength(1)
  expect(aborted).toEqual([])
  release()
  await w.clock.settle()
  expect(w.submits).toHaveLength(1)
})

// ---- the toolbar and the selection ----

/** The body id of the row drawn selected: the one whose link starts with the "▶ " marker. */
async function selectedRow(ui: Awaited<ReturnType<typeof openPane>>) {
  const line = (await ui.findAll({ type: 'Markdown' })).find(m => String(m.key).startsWith('row-') && String(m.props.text).startsWith('[▶ '))
  return /body of (\w+)/.exec(String(line?.props.text))?.[1]
}

test('no surface has controls on a row: no overlay, no hover Box, no per-row Button, one link per row, no Button but the toolbar, folds, header and details', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  broadcast(w, 'b1')
  await w.clock.settle()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await openPane($, w, surface)
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(b => b.props.display === 'none' || b.props.position !== undefined), surface).toEqual([])
    // the only Markdown: a decision's "answer in Orchard", and each row's words, one link that answers a press by selecting
    const markdown = await ui.findAll({ type: 'Markdown' })
    expect(markdown.filter(m => !String(m.key).startsWith('answer-') && !String(m.key).startsWith('row-')), surface).toEqual([])
    for (const m of markdown.filter(m => String(m.key).startsWith('row-'))) {
      expect(m.props.pressableLinks, surface).toEqual([`${ACTION_ORIGIN}/select/${String(m.key).slice(4)}`])
      expect((String(m.props.text).match(/\]\(/g) ?? []).length, surface).toBe(1)
    }
    const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key))
    expect(keys.filter(k => k.startsWith('btn-') || k.startsWith('actions-')), surface).toEqual([])
    // every Button is a standard one
    for (const b of await ui.findAll({ type: 'Button' })) expect(b.props.plain, `${surface} ${b.key}`).toBeUndefined()
    // and it is one toolbar, once
    expect(keys.filter(k => k === 'tb-remove'), surface).toHaveLength(1)
    await ui.unmount()
  }
})

test('selection: the newest unread is selected at first and drawn so on every surface; ▲ ▼ move it and stop at the ends', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  dm(w, 'd2')
  dm(w, 'd3')
  await w.clock.settle()

  // which row is drawn selected: a "▶ " in its link on every surface, and where there is a drawing, an outlined, "selected" mark
  const marked = async (ui: Awaited<ReturnType<typeof openPane>>, surface: string) => {
    const lines = (await ui.findAll({ type: 'Markdown' })).filter(m => String(m.key).startsWith('row-') && String(m.props.text).startsWith('[▶ '))
    if (surface !== 'terminal') {
      const marks = (await ui.findAll({ type: 'Svg' })).filter(v => /^Other Claude/.test(String(v.props.alt)))
      const outlined = marks.map(v => String(v.props.source).includes('class="sel"'))
      expect(outlined, surface).toEqual(marks.map(v => String(v.props.alt).includes(', selected')))
      expect(outlined.filter(Boolean).length, surface).toBe(lines.length)
    }
    return lines.length
  }
  const selectedKey = selectedRow

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await openPane($, w, surface)
    expect(await marked(ui, surface), surface).toBe(1)
    await ui.unmount()
  }

  const ui = await openPane($, w, 'desktop')
  // newest first: d3, d2, d1; all unread, so the newest is the default
  expect(await selectedKey(ui)).toBe('d3')
  await ui.press({ key: 'tb-select-next' })
  await w.clock.settle()
  expect(await selectedKey(ui)).toBe('d2')
  await ui.press({ key: 'tb-select-next' })
  await ui.press({ key: 'tb-select-next' })
  await w.clock.settle()
  expect(await selectedKey(ui)).toBe('d1')
  await ui.press({ key: 'tb-select-prev' })
  await w.clock.settle()
  expect(await selectedKey(ui)).toBe('d2')
  for (let i = 0; i < 4; i++) await ui.press({ key: 'tb-select-prev' })
  await w.clock.settle()
  expect(await selectedKey(ui)).toBe('d3')
  // a redraw keeps the pick
  await ui.press({ key: 'tb-select-next' })
  await act(ui, w, 'refresh')
  await w.clock.settle()
  expect(await selectedKey(ui)).toBe('d2')
  expect(w.fake.acks).toEqual([])
})

test('selection with a delivered newest thread defaults to the newest unread; the pick hands over to a neighbour when it leaves', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.advance(10_000)
  expect(w.submits).toHaveLength(1)
  // d1 is delivered (read); d2 is waiting (unread) and the newer
  dm(w, 'd2', { sent_at: '2026-10-10T09:30:00Z' })
  await w.clock.settle()
  const ui = await openPane($, w, 'desktop')
  const selectedKey = () => selectedRow(ui)
  expect(await selectedKey()).toBe('d2')
  await select(ui, w, 'd1')
  expect(await selectedKey()).toBe('d1')

  // removing the selected, last thread selects the one above (it clamps, it does not vanish)
  await ui.press({ key: 'tb-remove' })
  await ui.press({ key: 'tb-confirm' })
  await w.clock.settle()
  expect(await hasRow(ui, 'd1')).toBe(false)
  expect(await selectedKey()).toBe('d2')

  // snoozing the only one left leaves nothing selected and no toolbar
  await ui.press({ key: 'tb-snooze' })
  await w.clock.settle()
  expect(await selectedKey()).toBeUndefined()
  expect(await toolbarKeys(ui)).toEqual([])
})

test('every toolbar button and hotkey acts on the selected thread', { options: OPTIONS }, async ($, on) => {
  const aborted = stubTurns(on)
  const w = world(on)
  await begin($, w)
  await $.turn.start({ text: 'working', turnId: 'turn-1' })
  dm(w, 'd1')
  broadcast(w, 'b1')
  dm(w, 'd2')
  await w.clock.settle()
  const ui = await openPane($, w, 'terminal')

  // the hotkeys: one lowercase letter each, as promised
  const hotkeys: Record<string, string> = {}
  for (const b of await ui.findAll({ type: 'Button' })) if (String(b.key).startsWith('tb-')) hotkeys[String(b.key)] = String(b.props.hotkey)
  expect(hotkeys).toEqual({ 'tb-select-prev': 'k', 'tb-select-next': 'j', 'tb-remove': 'x', 'tb-snooze': 's', 'tb-next': 'n', 'tb-interrupt': 'i', 'tb-open-thread': 'o', 'tb-more': 'm' })
  expect((await ui.find({ type: 'Button', key: 'tb-remove' }))?.props.label).toBe('Remove')
  expect((await ui.find({ type: 'Button', key: 'tb-snooze' }))?.props.label).toBe('Snooze')
  expect((await ui.find({ type: 'Button', key: 'tb-next' }))?.props.label).toBe('Handle next')
  expect((await ui.find({ type: 'Button', key: 'tb-interrupt' }))?.props.label).toBe('Interrupt')
  expect((await ui.find({ type: 'Button', key: 'tb-open-thread' }))?.props.label).toBe('Open ↗')
  expect((await ui.find({ type: 'Button', key: 'tb-more' }))?.props.label).toBe('More')
  expect((await ui.find({ type: 'Button', key: 'tb-select-prev' }))?.props.label).toBe('▲')
  expect((await ui.find({ type: 'Button', key: 'tb-select-next' }))?.props.label).toBe('▼')

  // Open ↗: the selected thread's page, on the loopback address
  await select(ui, w, 'b1')
  await ui.press({ key: 'tb-open-thread' })
  await w.clock.settle()
  expect(w.fake.opened).toHaveLength(1)
  expect(w.fake.opened[0]).toContain('/messages/b1')

  // More: the detail opens below the selected card, and only that one
  await ui.press({ key: 'tb-more' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Button', key: 'detail-reply-b1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'detail-reply-d1' })).toBeUndefined()
  await ui.press({ key: 'tb-more' })

  // Handle next: b1 first in the queue
  await ui.press({ key: 'tb-next' })
  await w.clock.settle()
  expect(queuedIds(w)[0]).toBe('b1')

  // Snooze: d2 only
  await select(ui, w, 'd2')
  await ui.press({ key: 'tb-snooze' })
  await w.clock.settle()
  expect(queuedIds(w).sort()).toEqual(['b1', 'd1'])
  expect((w.store.data.get(SNOOZED) as { id: string }[]).map(s => s.id)).toEqual(['d2'])

  // Remove: d1 only, after Confirm
  await select(ui, w, 'd1')
  await ui.press({ key: 'tb-remove' })
  await ui.press({ key: 'tb-confirm' })
  await w.clock.settle()
  expect(w.fake.acks.map(a => a.ids)).toEqual([['d1']])
  expect(queuedIds(w)).toEqual(['b1'])

  // Interrupt: b1 only, after Confirm
  await select(ui, w, 'b1')
  await ui.press({ key: 'tb-interrupt' })
  expect(aborted).toEqual([])
  await ui.press({ key: 'tb-confirm' })
  await w.clock.settle()
  expect(aborted).toEqual(['turn-1'])
  expect(w.submits).toHaveLength(1)
  expect(w.submits[0]?.text).toContain('body of b1')
  expect(queuedIds(w)).toEqual([])
})

test('the header says whose inbox it is', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const terminal = await openPane($, w, 'terminal')
  const texts = (await terminal.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain("◆ Claude's view of Orchard")
  expect(texts).toContain(`this session · as ${ME} · Fruit Stand`)
  await terminal.unmount()
  const desktop = await openPane($, w, 'desktop')
  const header = (await desktop.findAll({ type: 'Svg' }))[0]
  expect(String(header?.props.source)).toContain("Claude&#39;s view of Orchard")
  expect(String(header?.props.source)).toContain(`this session · as ${ME} · Fruit Stand`)
})

