// The pane as one Claude session's live view: a receipt refreshes the claimed tasks once, the slow
// refresh runs only while the pane is open, and an idle session writes no state (so the band and
// the pane never redraw for nothing).
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ME, OPTIONS } from './fake-orchard'
import { same } from './same'
import { begin, bandText, world } from './test-world'
import type { World } from './test-world'

const PANE_PROPS = { title: 'Orchard', isFocused: false } as never

const receipt = (w: World, id: string) =>
  w.fake.push(
    { id, sender_id: 'orchard', kind: 'task_result', body: `Task receipt ${id}`, destination: { kind: 'channel', id: 'task-receipts' }, recipient_ids: [] },
    { reasons: ['channel'], channel: { id: 'task-receipts', name: 'Task receipts' } },
  )

async function openPane($: Engine, w: World) {
  await $.command.run({ command: 'orchard', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
  await w.clock.settle()
  return $.ui.mount({ plugin: 'orchard', surface: 'terminal', component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
}
type Pane = Awaited<ReturnType<typeof openPane>>

/** How many times the workspace's tasks were listed (two reads of every store a refresh makes: open and in progress). */
const calls = (w: World, tool: string) => w.fake.calls.filter(c => c.tool === tool).length
const texts = async (ui: Pane) => (await ui.findAll({ type: 'Text' })).map(t => String(t.text))

const WATCHED = ['status', 'workspace', 'counts', 'band', 'queue', 'generation', 'settings', 'heartbeat', 'activity', 'agents', 'workspaceActivity', 'plugins']
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

// ---- live updates ----

test('a receipt reads the claimed tasks once, a second later, however many arrive; the pane lists the new claim', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const ui = await openPane($, w)
  await w.clock.advance(31_000) // past the read the pane's opening asked for
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
  expect(calls(w, 'tasks_list')).toBe(listed + 2) // one read of the one store: open tasks, and the claimed ones
  expect((await texts(ui)).join('\n')).toContain('Fix the awning')

  // nothing else asks until the slow safety refresh
  await w.clock.advance(20_000)
  expect(calls(w, 'tasks_list')).toBe(listed + 2)
})

test('with the pane open the workspace is read every 60 s; with none open, never', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const before = calls(w, 'tasks_list')
  await w.clock.advance(300_000)
  expect(calls(w, 'tasks_list')).toBe(before) // no pane, no refresh

  await openPane($, w)
  await w.clock.advance(5_000) // the read the pane's opening asked for
  const opened = calls(w, 'tasks_list')
  expect(opened).toBeGreaterThan(before)
  await w.clock.advance(61_000)
  expect(calls(w, 'tasks_list')).toBe(opened + 2)
  await w.clock.advance(60_000)
  expect(calls(w, 'tasks_list')).toBe(opened + 4)
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
  expect((await texts(ui)).join('\n')).not.toContain('Ship the awning?')
  expect(await bandText($)).not.toContain('needs you')
})

// ---- an idle session writes nothing ----

test("idle polls write no state: not the band's, not the feed's", { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await bandText($)
  const settled = writesOf(w)
  expect(settled.band).toBeGreaterThan(0) // the band was written when it first had a line

  const polls = calls(w, 'alerts')
  await w.clock.advance(10 * 60_000)
  expect(calls(w, 'alerts') - polls).toBeGreaterThanOrEqual(8) // ten minutes of long polls came back empty
  expect(writesOf(w)).toEqual(settled)
  expect(await bandText($)).toBe('◆ Claude is connected to Fruit Stand')
})

test('idle polls with the pane open write only the poll clock', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.fake.push({ id: 'd1', sender_id: 'claude-other', body: 'hi', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
  await w.clock.settle()
  await openPane($, w)
  await w.clock.advance(61_000)
  const settled = writesOf(w)

  const polls = calls(w, 'alerts')
  await w.clock.advance(10 * 60_000)
  expect(calls(w, 'alerts') - polls).toBeGreaterThanOrEqual(8)
  const after = writesOf(w)
  // the alert from another leaves the ten-minute window once, and the count falls: that is the one write
  expect({ ...after, heartbeat: 0, workspaceActivity: 0 }).toEqual({ ...settled, heartbeat: 0, workspaceActivity: 0 })
  expect(after.workspaceActivity).toBe((settled.workspaceActivity as number) + 1)
  expect(after.heartbeat).toBeGreaterThan(settled.heartbeat as number)
})

test('the band is written when its line changes, not when its sources do', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const before = w.state.writes.band ?? 0
  w.fake.push({ id: 'd1', sender_id: 'claude-other', body: 'hi', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
  await w.clock.settle()
  expect(await bandText($)).toContain('1 queued')
  const afterNews = w.state.writes.band ?? 0
  expect(afterNews).toBeGreaterThan(before)
  // more traffic that leaves the line as it is (a decision count recomputed to the same number) writes nothing
  await w.clock.advance(5_000)
  expect(w.state.writes.band ?? 0).toBeLessThanOrEqual(afterNews + 1)
})
