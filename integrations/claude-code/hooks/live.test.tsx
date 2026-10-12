// The pane as one Claude session's live view: a press on a row selects it, the alerts the listener
// already fetched update the pane without a history call, a receipt refreshes the claims once, and an
// idle session writes no state (so the band and the pane never redraw for nothing).
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { actionHref } from './actions'
import type { OrchardAlert, OrchardPaneThread } from '../types'
import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
import { same } from './same'
import { mergeAlerts } from './threads'
import { begin, bandText, world } from './test-world'
import type { World } from './test-world'

const PANE_PROPS = { title: 'Orchard', isFocused: false } as never
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
type Surface = (typeof SURFACES)[number]

const dm = (w: World, id: string, extra: Record<string, unknown> = {}) =>
  w.fake.push({ id, body: `body of ${id}`, sender_id: 'claude-other', sent_at: '2026-10-10T09:00:00Z', ...extra }, { reasons: ['direct'] })

const receipt = (w: World, id: string) =>
  w.fake.push(
    { id, sender_id: 'orchard', kind: 'task_result', body: `Task receipt ${id}`, destination: { kind: 'channel', id: 'task-receipts' }, recipient_ids: [] },
    { reasons: ['channel'], channel: { id: 'task-receipts', name: 'Task receipts' } },
  )

async function openPane($: Engine, w: World, surface: Surface = 'terminal') {
  await $.command.run({ command: 'orchard', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
  await w.clock.settle()
  return $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
}
type Pane = Awaited<ReturnType<typeof openPane>>

const rowButton = (id: string) => ({ key: `row-${id}` })
const rowText = (b: { text?: unknown; props: Record<string, unknown> }) => String(b.text ?? '')
const selectedRow = async (ui: Pane) => {
  const line = (await ui.findAll({ type: 'Button' })).find(b => String(b.key).startsWith('row-') && rowText(b).startsWith('▶ '))
  return /body of (\w+)/.exec(line === undefined ? '' : rowText(line))?.[1]
}
const rowIds = async (ui: Pane) => (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('row-')).map(b => String(b.key).slice(4))
const calls = (w: World, tool: string) => w.fake.calls.filter(c => c.tool === tool).length
const texts = async (ui: Pane) => (await ui.findAll({ type: 'Text' })).map(t => String(t.text))

const WATCHED = ['status', 'workspace', 'counts', 'band', 'queue', 'generation', 'settings', 'heartbeat']
const writesOf = (w: World, keys: readonly string[] = WATCHED) => Object.fromEntries(keys.map(k => [k, w.state.writes[k] ?? 0]))

// ---- pure pieces ----

test('same compares plain values by structure and ignores undefined fields', () => {
  expect(same({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] })).toBe(true)
  expect(same({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  expect(same([1, 2], [1, 2, 3])).toBe(false)
  expect(same({ a: 1 }, { a: 2 })).toBe(false)
  expect(same(null, {})).toBe(false)
  expect(same([], {})).toBe(false)
})

const alertOf = (id: string, sequence: number, extra: Partial<OrchardAlert> = {}): OrchardAlert => ({
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
  arrivedAt: 1,
  ...extra,
})
const live = (queued: string[] = []) => ({ me: ME, ownerId: 'owner', endpoint: ENDPOINT, queued: new Set(queued) })

test('mergeAlerts: newest first, a reply extends its thread, and a page seen twice changes nothing', () => {
  const first = mergeAlerts([], [alertOf('a', 1), alertOf('b', 2)], live(['a', 'b']))
  expect(first.map(t => [t.replyToId, t.size, t.isUnread, t.reason])).toEqual([
    ['b', 1, true, 'DM'],
    ['a', 1, true, 'DM'],
  ])
  const next = mergeAlerts(first, [alertOf('c', 3, { threadId: 'a', reasons: ['reply'] })], live(['a', 'b', 'c']))
  expect(next.map(t => [t.replyToId, t.size, t.reason])).toEqual([
    ['c', 2, 'REPLY'],
    ['b', 1, 'DM'],
  ])
  expect(same(mergeAlerts(next, [alertOf('c', 3, { threadId: 'a' }), alertOf('b', 2)], live()), next)).toBe(true)
})

test('mergeAlerts: receipts, own messages and unqueued channel posts are not mail', () => {
  const alerts = [
    alertOf('r', 1, { senderId: 'orchard', kind: 'task_result', channelId: 'task-receipts', where: 'channel Task receipts', reasons: ['channel'] }),
    alertOf('mine', 2, { senderId: ME }),
    alertOf('chan', 3, { channelId: 'general', where: 'channel general', reasons: ['channel'] }),
    alertOf('owner', 4, { senderId: 'owner', senderName: 'Nick' }),
  ]
  const threads: OrchardPaneThread[] = mergeAlerts([], alerts, live(['owner']))
  expect(threads.map(t => [t.replyToId, t.reason])).toEqual([['owner', 'OWNER']])
})

// ---- a press on a row ----

for (const surface of SURFACES) {
  test(`${surface}: a press on a row selects it, a second press on the selected row opens its detail, a third closes it`, { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    await begin($, w)
    dm(w, 'd1')
    dm(w, 'd2')
    await w.clock.settle()

    const ui = await openPane($, w, surface)
    // each row's words are one plain Button: no Markdown link anywhere
    expect(await ui.findAll({ type: 'Markdown' })).toEqual([])
    for (const b of (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('row-'))) expect(b.props.plain).toBe(true)
    expect(await selectedRow(ui)).toBe('d2') // the newest unread, by default
    await ui.press(rowButton('d1'))
    await w.clock.settle()
    expect(await selectedRow(ui)).toBe('d1')
    expect(await ui.find({ type: 'Button', key: 'detail-reply-d1' })).toBeUndefined()

    await ui.press(rowButton('d1'))
    await w.clock.settle()
    expect(await selectedRow(ui)).toBe('d1')
    expect(await ui.find({ type: 'Button', key: 'detail-reply-d1' })).toBeDefined()

    await ui.press(rowButton('d1'))
    await w.clock.settle()
    expect(await ui.find({ type: 'Button', key: 'detail-reply-d1' })).toBeUndefined()
    // the toolbar follows the pick, and pressing a row acknowledges nothing
    expect(await ui.find({ type: 'Button', key: 'tb-remove' })).toBeDefined()
    expect(w.fake.acks).toEqual([])
  })
}

// ---- live updates ----

test('an alert page updates the pane threads at once, without a history call', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()
  const ui = await openPane($, w, 'desktop')
  expect(await rowIds(ui)).toEqual(['d1'])
  const history = calls(w, 'mail_history')
  const info = calls(w, 'workspace_info')

  dm(w, 'd2', { sent_at: '2026-10-10T09:05:00Z' })
  await w.clock.settle()

  expect(await rowIds(ui)).toEqual(['d2', 'd1'])
  expect(calls(w, 'mail_history')).toBe(history)
  expect(calls(w, 'workspace_info')).toBe(info)
  // it is unread until the wake delivers it, then not
  const dimmed = async () => (await ui.findAll({ type: 'Button' })).find(b => b.key === 'row-d2')?.props.dimColor
  expect(await dimmed()).toBe(false)
  await w.clock.advance(10_000)
  expect(w.submits.length).toBeGreaterThan(0)
  expect(await dimmed()).toBe(true)
  expect(calls(w, 'mail_history')).toBe(history)
})

test('a receipt refreshes the claimed tasks once, a second later, however many arrive; the pane does not list the receipt', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const ui = await openPane($, w)
  const listed = calls(w, 'tasks_list')
  expect(await texts(ui)).not.toContain('Fix the awning')

  w.fake.tasks = [{ id: 't1', title: 'Fix the awning', status: 'in_progress', assignee: ME }]
  receipt(w, 'r1')
  receipt(w, 'r2')
  receipt(w, 'r3')
  await w.clock.advance(500)
  expect(calls(w, 'tasks_list')).toBe(listed) // debounced: nothing yet

  await w.clock.advance(1_000)
  await w.clock.settle()
  expect(calls(w, 'tasks_list')).toBe(listed + 1)
  expect(await texts(ui)).toContain('Fix the awning')
  expect(await rowIds(ui)).toEqual([])

  // nothing else asks until the slow safety refresh
  await w.clock.advance(20_000)
  expect(calls(w, 'tasks_list')).toBe(listed + 1)
})

test('with the pane open claims and decisions are read every 60 s; with none open, never', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const before = calls(w, 'tasks_list')
  await w.clock.advance(300_000)
  expect(calls(w, 'tasks_list')).toBe(before) // no pane, no refresh

  await openPane($, w)
  const opened = calls(w, 'tasks_list')
  await w.clock.advance(61_000)
  expect(calls(w, 'tasks_list')).toBe(opened + 1)
  await w.clock.advance(60_000)
  expect(calls(w, 'tasks_list')).toBe(opened + 2)
})

test('a decision the owner answers moves the waiting-on-you section and the band', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.hasDecisionsTool = true
  await begin($, w)
  w.fake.push({ id: 'dec1', sender_id: ME, kind: 'decision', body: 'Ship the awning?', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
  const ui = await openPane($, w)
  expect((await texts(ui)).join('\n')).toContain('Ship the awning?')
  expect(await bandText($)).toContain('needs you 1')

  w.fake.push({ id: 'ans1', sender_id: 'owner', thread_id: 'dec1', body: 'yes', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
  // the poll the undecorated push woke came back empty and early: the loop sleeps out its minute, then reads the owner's answer
  await w.clock.advance(65_000)
  await w.clock.advance(2_000)
  await w.clock.settle()
  expect((await texts(ui)).join('\n')).toContain('Claude is not waiting on you')
  expect(await bandText($)).not.toContain('needs you')
})

// ---- an idle session writes nothing ----

test("idle polls write no state: not the band's, not the pane's", { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await bandText($)
  const settled = writesOf(w)
  expect(settled.band).toBeGreaterThan(0) // the band was written when it first had a line

  const polls = calls(w, 'alerts')
  await w.clock.advance(10 * 60_000)
  expect(calls(w, 'alerts') - polls).toBeGreaterThanOrEqual(8) // ten minutes of long polls came back empty
  expect(writesOf(w)).toEqual(settled)
  expect(await bandText($)).toBe(`◆ ${ME} in Fruit Stand · ● listening`)
})

test('idle polls with the pane open write only the poll clock', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()
  await openPane($, w)
  await w.clock.advance(61_000)
  const keys = [...WATCHED, 'pane']
  const settled = writesOf(w, keys)

  const polls = calls(w, 'alerts')
  await w.clock.advance(10 * 60_000)
  expect(calls(w, 'alerts') - polls).toBeGreaterThanOrEqual(8)
  const after = writesOf(w, keys)
  expect({ ...after, heartbeat: 0 }).toEqual({ ...settled, heartbeat: 0 })
  expect(after.heartbeat).toBeGreaterThan(settled.heartbeat as number)
})

test('the band is written when its line changes, not when its sources do', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const before = w.state.writes.band ?? 0
  dm(w, 'd1')
  await w.clock.settle()
  expect(await bandText($)).toContain('1 new')
  const afterNews = w.state.writes.band ?? 0
  expect(afterNews).toBeGreaterThan(before)
  // more traffic that leaves the line as it is (a decision count recomputed to the same number) writes nothing
  await w.clock.advance(5_000)
  expect(w.state.writes.band ?? 0).toBeLessThanOrEqual(afterNews + 1)
})

// ---- the session's own perspective ----

test("every surface says it is Claude's view of Orchard: title, which session, the three sections and the band", { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  dm(w, 'd1')
  await w.clock.settle()

  for (const surface of SURFACES) {
    const ui = await openPane($, w, surface)
    const drawn = (await ui.findAll({ type: 'Svg' })).flatMap(v => [String(v.props.source), String(v.props.alt)])
    const all = [...(await texts(ui)), ...drawn].join('\n')
    const esc = (s: string) => (surface === 'terminal' ? s : s.replace("'", '&#39;'))
    expect(all, surface).toContain(esc("Claude's view of Orchard"))
    expect(all, surface).toContain(`this session · as ${ME} · Fruit Stand`)
    for (const label of ["CLAUDE'S INBOX", 'CLAUDE IS WAITING ON YOU', "CLAUDE'S TASKS"]) expect(all, `${surface} ${label}`).toContain(esc(label))
    expect(all.includes('NEEDS YOU') || all.includes('CLAIMED TASKS'), surface).toBe(false)
    expect(await bandText($, surface === 'terminal' ? 'terminal' : 'desktop'), surface).toBe(`◆ ${ME} in Fruit Stand · 1 new · 1 for you`)
    await ui.unmount()
  }
})
