// What the mod keeps of this session's life in Orchard: the activity feed (what its agents did and were
// told), the table of its agents, the workspace's activity around it and what the plugins hold for it;
// and Disconnect / Connect. All against the fake workspace and the mock clock.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CWD, ENDPOINT, ME, OPTIONS } from './fake-orchard'
import type { FakeMessage } from './fake-orchard'
import { bandText, begin, callTool, resumes, typed, world } from './test-world'
import type { World } from './test-world'
import type { OrchardActivityEntry, OrchardAgents, OrchardPlugins, OrchardWorkspaceActivity } from '../types'

const RUN = (args: string) => ({ command: 'orchard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
// what versions up to 0.5 kept in the store for snoozed and removed messages
const snoozeKeyFor = (endpoint: string, me: string) => `snoozed ${endpoint} ${me}`
const hiddenKeyFor = (endpoint: string, me: string) => `hidden ${endpoint} ${me}`
const ORIGIN = 'http://127.0.0.1:4312'
const BASE = `${ORIGIN}/w/ws_0123456789abcdef`

const feed = (w: World) => (w.state.latest.activity ?? []) as OrchardActivityEntry[]
const table = (w: World) => (w.state.latest.agents ?? {}) as OrchardAgents
const around = (w: World) => w.state.latest.workspaceActivity as OrchardWorkspaceActivity
const held = (w: World) => w.state.latest.plugins as OrchardPlugins
const calls = (w: World, tool: string) => w.fake.calls.filter(c => c.tool === tool)
const openReads = (w: World) => calls(w, 'tasks_list').filter(c => JSON.parse(c.stdin ?? '{}').status === 'open').length

const direct = (id: string, extra: Partial<FakeMessage> = {}): Partial<FakeMessage> & { id: string } => ({
  id,
  sender_id: 'claude-other',
  body: `body of ${id}`,
  destination: { kind: 'direct', id: ME },
  recipient_ids: [ME],
  sent_at: '2026-10-10T09:00:00Z',
  ...extra,
})
const receipt = (w: World, id: string) =>
  w.fake.push(
    { id, sender_id: 'orchard', kind: 'task_result', body: `Task receipt ${id}`, destination: { kind: 'channel', id: 'task-receipts' }, recipient_ids: [] },
    { reasons: ['channel'], channel: { id: 'task-receipts', name: 'Task receipts' } },
  )

/** An Agent call as the engine raises `agent.spawn` for it. */
const spawn = ($: Engine, description: string, subagentType = 'Explore') =>
  $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'do it',
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'sonnet',
    background: true,
    fork: false,
  } as never)

const turnEnds = ($: Engine, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn', ...extra } as never)

// ---- outbound: what the agents did ----

test('a successful Orchard tool call is an outbound entry in words, with no ids: send, reply, ack, task, role, state', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.tasks = [{ id: 't1', title: 'Fix the awning', assignee: null }]
  await begin($, w)
  w.fake.push(direct('m1', { body: 'Question about the awning' }))

  const sent = await callTool($, 'orchard_send', { body: 'Awning is fixed\nsecond line', direct: 'claude-other' })
  expect(sent.result).toContain('Sent')
  await callTool($, 'orchard_send', { body: 'Hello all', channel: 'releases' })
  await callTool($, 'orchard_send', { body: 'Standup now', broadcast: true })
  await callTool($, 'orchard_reply', { message_id: 'm1', body: 'On it' })
  await callTool($, 'orchard_ack', { message_ids: ['m1', 'm2'] })
  await callTool($, 'orchard_call', { name: 'task_claim', arguments: { store_id: 'store1', task_id: 't1' } })
  await callTool($, 'orchard_call', { name: 'plugin_call', arguments: { plugin_id: 'roles', operation: 'role_declare', arguments: { roles: ['builder', 'code_review'], skills: [] } } })
  await callTool($, 'orchard_call', { name: 'state_create', arguments: { id: 's1', title: 'Ship the awning', definition_id: 'flow', definition_version: 1, subject: { kind: 'task', store_id: 'store1', task_id: 't1' } } })
  await callTool($, 'orchard_call', { name: 'state_advance', arguments: { id: 's1', expected_revision: 1, to: 'in_review' } })
  await w.clock.settle()

  const out = feed(w).filter(e => e.direction === 'out')
  expect(out.map(e => [e.kind, e.text])).toEqual([
    ['send', 'Sent to Other Claude: Awning is fixed'],
    ['send', 'Posted in #releases: Hello all'],
    ['send', 'Broadcast: Standup now'],
    ['reply', 'Replied to Other Claude: On it'],
    ['ack', 'Acknowledged 2 messages'],
    ['task', 'Claimed task “Fix the awning”'],
    ['role', 'Declared roles: builder, code review'],
    ['state', 'Created state marker “Ship the awning”'],
    ['state', 'Moved “Ship the awning” to in review'],
  ])
  for (const entry of out) {
    expect(entry).toMatchObject({ agentId: 'main', handle: ME, direction: 'out' })
    expect(entry.at).toBeLessThanOrEqual(w.clock.now())
  }
  // each opens where it belongs: the message that was sent, the task, the marker
  expect(out[0]?.href).toBe(`${BASE}/messages/m_sent_1`)
  expect(out[3]?.href).toBe(`${BASE}/messages/m_sent_4`)
  expect(out[5]?.href).toBe(`${BASE}/tasks/store1/t1`)
  expect(out[7]?.href).toBe(`${BASE}/states/s1`)
  expect(out[4]?.href).toBeUndefined()
  // no raw id in a sentence where a name or a title was available
  for (const entry of out) for (const id of ['claude-other', 'm_sent', 'm1', 'store1', 't1', 's1', 'code_review', 'in_review']) expect(entry.text.includes(id), `${entry.text} ${id}`).toBe(false)
  // and the main loop's last action is the last of them
  expect(table(w).main?.lastAction).toBe('Moved “Ship the awning” to in review')
})

test('an outbound entry belongs to the agent that made the call: main without an agent id, the subagent with one, and it is that subagent\'s last action', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const { agentId } = await spawn($, 'Write the notes')
  expect(agentId).toBeDefined()

  await callTool($, 'orchard_send', { body: 'from main', direct: 'owner' })
  await callTool($, 'orchard_send', { body: 'from the subagent', direct: 'owner', agentId })
  await callTool($, 'orchard_ack', { message_ids: ['m9'], agentId: 'agent-unknown' })
  await w.clock.settle()

  expect(feed(w).map(e => [e.agentId, e.text])).toEqual([
    ['main', 'Sent to Nick: from main'],
    [agentId, 'Sent to Nick: from the subagent'],
    ['agent-unknown', 'Acknowledged 1 message'],
  ])
  expect(table(w).main?.lastAction).toBe('Sent to Nick: from main')
  expect(table(w)[agentId as string]?.lastAction).toBe('Sent to Nick: from the subagent')
  // an agent the table has never heard of still has its entry; nothing is invented for it
  expect(table(w)['agent-unknown']).toBeUndefined()
})

test('reads, refused calls and failed calls leave no entry', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.fake.script = call => (call.tool === 'mail_send' && call.stdin?.includes('fail me') ? { exitCode: 4, stderr: 'Orchard agent: nope\n' } : undefined)

  await callTool($, 'orchard_history', {})
  await callTool($, 'orchard_call', { name: 'tasks_list', arguments: { store_id: 'store1' } })
  await callTool($, 'orchard_call', { name: 'plugin_call', arguments: { plugin_id: 'roles', operation: 'roles_list', arguments: {} } })
  await callTool($, 'orchard_call', { name: 'artifact_upload', arguments: {} })
  await callTool($, 'orchard_call', { name: 'mail_send', arguments: { sender_id: 'owner', destination: { kind: 'broadcast' }, body: 'impostor' } })
  await callTool($, 'orchard_send', { body: 'fail me', direct: 'owner' })
  await callTool($, 'orchard_send', { body: 'no destination' })
  await w.clock.settle()
  expect(feed(w)).toEqual([])
  expect(table(w).main?.lastAction).toBeUndefined()
})

// ---- inbound: what the agents were told ----

test('an alert that reaches the session is an inbound entry: who, how it came, the start of it, where it opens; a receipt, an own message and an alert fetched twice are not', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)

  w.fake.push(direct('d1', { body: 'Can you check the build?\nplease' }), { reasons: ['direct'] })
  w.fake.push({ id: 'g1', sender_id: 'claude-other', body: 'Hey @you', destination: { kind: 'channel', id: 'general' }, recipient_ids: ['owner'] }, { reasons: ['mention', 'channel'], channel: { id: 'general', name: 'general' } })
  w.fake.push({ id: 'b1', sender_id: 'owner', body: 'Standup', destination: { kind: 'broadcast' }, recipient_ids: [ME] }, { reasons: ['broadcast'] })
  receipt(w, 'r1')
  w.fake.push({ id: 'mine', sender_id: ME, body: 'my own post', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })
  await w.clock.settle()

  const inbound = feed(w).filter(e => e.direction === 'in')
  expect(inbound.map(e => [e.text, e.kind, e.href])).toEqual([
    ['Other Claude (DM): Can you check the build?', 'message', `${BASE}/messages/d1`],
    ['Other Claude (mention): Hey @you', 'message', `${BASE}/messages/g1`],
    ['Nick (broadcast): Standup', 'message', `${BASE}/messages/b1`],
  ])
  for (const entry of inbound) expect(entry).toMatchObject({ agentId: 'main', handle: ME, direction: 'in' })
  // an alert the listener is handed again (a lagging cursor) is not logged or counted twice
  const again = w.fake.alerts.get('d1')
  const page = JSON.stringify({ alerts: [{ reasons: ['direct'], message: again?.message, channel: null, resource: { href: `/w/ws_0123456789abcdef/messages/d1` } }], next_cursor: 99, has_more: false })
  const alerts = calls(w, 'alerts').length
  w.fake.script = call => (call.cmd === 'alerts' && calls(w, 'alerts').length > alerts ? { exitCode: 0, stdout: page } : undefined)
  await w.clock.advance(70_000)
  expect(feed(w).filter(e => e.direction === 'in')).toHaveLength(3)
  expect(around(w).recentFromOthers).toBe(3)
})

test('workspace activity counts alerts from others in the last ten minutes, task receipts and own messages aside, and falls as they leave the window', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(around(w) ?? { recentFromOthers: 0 }).toMatchObject({ recentFromOthers: 0 })

  // a plain channel post is not for this session (it is dropped, and not logged) but it is the workspace being busy
  w.fake.push({ id: 'c1', sender_id: 'claude-other', body: 'noise', destination: { kind: 'channel', id: 'general' }, recipient_ids: ['owner'] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })
  receipt(w, 'r1')
  w.fake.push({ id: 'mine', sender_id: ME, body: 'my own post', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })
  await w.clock.settle()
  expect(around(w)).toMatchObject({ recentFromOthers: 1 })
  expect(feed(w).filter(e => e.direction === 'in')).toEqual([])
  const first = w.clock.now()
  expect(around(w).lastAt).toBe(first)

  await w.clock.advance(5 * 60_000)
  w.fake.push(direct('d2'), { reasons: ['direct'] })
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(2)

  // the first leaves at ten minutes, the second at fifteen: the count falls with nobody saying anything
  await w.clock.advance(5 * 60_000 + 1_000)
  expect(around(w).recentFromOthers).toBe(1)
  await w.clock.advance(5 * 60_000)
  expect(around(w).recentFromOthers).toBe(0)
  expect(around(w).lastAt).toBeGreaterThan(first)
})

// ---- agents ----

test('the main loop is in the table from the start, running while its turn runs', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(table(w).main).toMatchObject({ agentId: 'main', type: 'main', status: 'idle', handle: ME, startedAt: 0 })

  await $.turn.start({ text: 'hello', turnId: 't1' })
  await w.clock.settle()
  expect(table(w).main?.status).toBe('running')
  await turnEnds($)
  await w.clock.settle()
  expect(table(w).main?.status).toBe('idle')
})

test('a spawned subagent is in the table at once with its description; the table follows $.agent.list() every 2 s while one is live, and only then', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const { agentId, model } = await spawn($, 'Read the README')
  expect(model).toBe('sonnet') // the hook only watches: the spawn is answered as the engine answered it
  expect(table(w)[agentId as string]).toMatchObject({ agentId, description: 'Read the README', type: 'Explore', status: 'running', startedAt: w.clock.now() })
  expect(table(w)[agentId as string]?.endedAt).toBeUndefined()
  expect(w.agents.lists).toBe(0)

  await w.clock.advance(2_000)
  expect(w.agents.lists).toBe(1)
  await w.clock.advance(4_000)
  expect(w.agents.lists).toBe(3)

  w.agents.list[0] = { ...(w.agents.list[0] as (typeof w.agents.list)[number]), status: 'completed' }
  await w.clock.advance(2_000)
  const endedAt = w.clock.now()
  expect(table(w)[agentId as string]).toMatchObject({ status: 'completed', endedAt })
  // nothing is live now: the engine is not asked again
  const lists = w.agents.lists
  await w.clock.advance(60_000)
  expect(w.agents.lists).toBe(lists)

  // it stays two minutes after it ended, then goes; the main loop never does
  await w.clock.advance(60_000 - 1)
  expect(table(w)[agentId as string]?.status).toBe('completed')
  await w.clock.advance(1)
  expect(table(w)[agentId as string]).toBeUndefined()
  expect(table(w).main).toBeDefined()
  expect(w.agents.lists).toBe(lists) // dropping it asked the engine nothing
})

test('an agent that leaves $.agent.list() unseen is lost; one the table never saw spawn is added by the list; a refused spawn adds nothing', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const { agentId } = await spawn($, 'Vanishing')
  w.agents.list.length = 0
  await w.clock.advance(2_000)
  expect(table(w)[agentId as string]).toMatchObject({ status: 'lost', endedAt: w.clock.now() })

  // a forked skill: in the list, never through the hook; its turn ending is the cue to look
  w.agents.list.push({ id: 'fork-1', description: 'A forked skill', type: 'fork', status: 'running' })
  await turnEnds($, { agentId: 'fork-1' })
  await w.clock.settle()
  expect(table(w)['fork-1']).toMatchObject({ description: 'A forked skill', type: 'fork', status: 'running' })

  w.agents.deny = 'no more agents'
  const refused = await spawn($, 'Refused')
  expect(refused).toEqual({ deny: 'no more agents' })
  expect(Object.keys(table(w)).sort()).toEqual([agentId, 'fork-1', 'main'].sort())
})

test('a subagent\'s turn ending looks at the list at once, even when nothing is live (an idle agent finishing)', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const { agentId } = await spawn($, 'Waits for mail')
  w.agents.list[0] = { ...(w.agents.list[0] as (typeof w.agents.list)[number]), status: 'idle' }
  await w.clock.advance(2_000)
  expect(table(w)[agentId as string]?.status).toBe('idle')
  const lists = w.agents.lists
  await w.clock.advance(30_000)
  expect(w.agents.lists).toBe(lists) // idle waits for a message: no polling

  w.agents.list[0] = { ...(w.agents.list[0] as (typeof w.agents.list)[number]), status: 'completed' }
  await turnEnds($, { agentId })
  await w.clock.settle()
  expect(table(w)[agentId as string]?.status).toBe('completed')
  // the main loop's own turn ending does not ask the engine for the list
  const before = w.agents.lists
  await turnEnds($)
  await w.clock.settle()
  expect(w.agents.lists).toBe(before)
})

test('the pane lists the agents with what each last did, and the activity feed, newest first', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const { agentId } = await spawn($, 'Write the notes')
  await callTool($, 'orchard_send', { body: 'notes are up', direct: 'owner', agentId })
  // (the message the tool sent woke the waiting poll, which came back empty and early: the loop sleeps out its minute)
  await w.clock.advance(61_000)
  w.fake.push(direct('d1', { body: 'Thanks, one more thing' }), { reasons: ['direct'] })
  await w.clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: { title: 'Orchard', isFocused: false } as never })
    const drawn = async () => [...(await ui.findAll({ type: 'Text' })).map(t => String(t.text)), ...(await ui.findAll({ type: 'Svg' })).map(v => String(v.props.alt))].join('\n')
    const rows = async () => (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => /^activity-\d+-open$/.test(k))
    const all = await drawn()
    expect(all, surface).toContain('AGENTS')
    expect(all, surface).toContain('Write the notes')
    // the subagent used the mod's tools, which act as the session's participant (the pane draws what the agents table holds)
    expect(all, surface).toContain(`shares ${ME}`)
    expect(all, surface).toContain('● running')
    expect(all, surface).toContain('Sent to Nick: notes are up') // its last action, under its row
    expect(all, surface).toContain('ACTIVITY')
    // "this agent" lists the main loop's entries only; "+ subagents" adds the subagent's, newest first
    expect(all, surface).toContain('Other Claude (DM): Thanks, one more thing')
    expect(await rows(), surface).toEqual(['activity-0-open'])
    await ui.press({ key: 'scope-all' })
    expect(await rows(), surface).toEqual(['activity-0-open', 'activity-1-open'])
    const both = await drawn()
    expect(both.indexOf('Other Claude (DM)'), surface).toBeLessThan(both.lastIndexOf('Sent to Nick: notes are up'))
    await ui.press({ key: 'scope-this' })
    expect(await rows(), surface).toEqual(['activity-0-open'])
    await ui.unmount()
  }
})

// ---- tasks and plugins ----

test('open tasks are counted at connect and again after a receipt, at most once every 30 s', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.tasks = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two', status: 'open' }, { id: 't3', title: 'Three', status: 'in_progress', assignee: 'claude-other' }]
  await begin($, w)
  expect(around(w).openTasks).toBe(2)
  expect(openReads(w)).toBe(1)

  w.fake.tasks.push({ id: 't4', title: 'Four' })
  receipt(w, 'r1')
  receipt(w, 'r2')
  receipt(w, 'r3')
  await w.clock.advance(10_000)
  expect(openReads(w)).toBe(1) // a read ran 30 s ago at the latest: the receipts wait for the floor
  expect(around(w).openTasks).toBe(2)

  await w.clock.advance(21_000)
  expect(openReads(w)).toBe(2) // three receipts, one read
  expect(around(w).openTasks).toBe(3)

  receipt(w, 'r4')
  w.fake.tasks.push({ id: 't5', title: 'Five' })
  await w.clock.advance(25_000)
  expect(openReads(w)).toBe(2) // 25 s after the last read: not yet
  await w.clock.advance(6_000)
  expect(openReads(w)).toBe(3)
  expect(around(w).openTasks).toBe(4)

  // after a quiet minute a receipt is read a second later, not thirty
  await w.clock.advance(120_000)
  w.fake.tasks.push({ id: 't6', title: 'Six' })
  receipt(w, 'r5')
  await w.clock.advance(1_500)
  expect(around(w).openTasks).toBe(5)
  expect(openReads(w)).toBe(4)
})

test('open tasks stay null with no task store', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.taskStores = []
  await begin($, w)
  expect(around(w)?.openTasks ?? null).toBeNull() // (null is what it starts as: nothing was written)
  expect(calls(w, 'tasks_list')).toHaveLength(0)
})

test('open tasks keep their last value when the workspace cannot say', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.tasks = [{ id: 't1', title: 'One' }]
  await begin($, w)
  expect(around(w).openTasks).toBe(1)
  w.fake.script = call => (call.tool === 'tasks_list' ? { exitCode: 4, stderr: 'Orchard agent: tasks are down\n' } : undefined)
  receipt(w, 'r1')
  await w.clock.advance(35_000)
  expect(openReads(w)).toBe(2)
  expect(around(w).openTasks).toBe(1)
})

test('the plugins atom lists what the attached plugins hold for this session\'s handle; a plugin that is not attached is not asked', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.tasks = [{ id: 't1', title: 'Fix the awning', status: 'in_progress', assignee: ME }, { id: 't2', title: 'Paint', status: 'in_progress', assignee: 'claude-other' }]
  w.fake.hasDecisionsTool = true
  w.fake.push({ id: 'dec1', sender_id: ME, kind: 'decision', body: 'Ship the awning?', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
  await begin($, w)
  // Tasks is attached and Roles and State are not: neither is asked, and the atom says what is attached
  expect(calls(w, 'plugin_call')).toHaveLength(0)
  expect(calls(w, 'state_list')).toHaveLength(0)
  expect(held(w)).toMatchObject({
    attached: ['core', 'chat', 'tasks'],
    roles: [],
    states: [],
    decisions: [{ id: 'dec1', snippet: 'Ship the awning?', href: `${BASE}/messages/dec1` }],
    tasks: [{ id: 't1', title: 'Fix the awning', status: 'in progress', href: `${BASE}/tasks/store1/t1` }],
  })

  w.fake.plugins = w.fake.plugins.map(p => ({ ...p, attached: true }))
  w.fake.declarations = [{ participant_id: ME, roles: ['builder'] }, { participant_id: 'claude-other', roles: ['qa'] }]
  w.fake.markers = [
    { id: 's1', title: 'Ship the awning', state: 'in_review', created_by: ME, subject: { kind: 'file', root_id: 'r' } },
    { id: 's2', title: 'Paint the stand', state: 'todo', created_by: 'claude-other', subject: { kind: 'task', task_id: 't1' } },
    { id: 's3', title: 'Not mine', state: 'todo', created_by: 'claude-other', subject: { kind: 'task', task_id: 'zz' } },
  ]
  await $.command.run(RUN('reconnect'))
  await w.clock.settle()
  expect(calls(w, 'plugin_call').map(c => JSON.parse(c.stdin ?? '{}'))).toEqual([{ plugin_id: 'roles', operation: 'roles_list', arguments: {} }])
  expect(calls(w, 'state_list').length).toBeGreaterThan(0)
  expect(held(w).attached).toEqual(['core', 'chat', 'tasks', 'state', 'roles'])
  expect(held(w).roles).toEqual([{ participantId: ME, roles: ['builder'] }])
  expect(held(w).states).toEqual([
    { id: 's1', title: 'Ship the awning', state: 'in review', href: `${BASE}/states/s1` },
    { id: 's2', title: 'Paint the stand', state: 'todo', href: `${BASE}/states/s2` },
  ])
})

test('this session\'s own role, state and task calls refresh the plugins a second later, past the 30 s floor', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.plugins = w.fake.plugins.map(p => ({ ...p, attached: true }))
  w.fake.tasks = [{ id: 't1', title: 'Fix the awning' }]
  await begin($, w)
  expect(held(w)).toMatchObject({ roles: [], states: [], tasks: [] })
  await w.clock.advance(1_000) // the read at connect is done; the floor now runs from it

  await callTool($, 'orchard_call', { name: 'plugin_call', arguments: { plugin_id: 'roles', operation: 'role_declare', arguments: { roles: ['builder'], skills: [] } } })
  await w.clock.advance(1_100)
  expect(held(w).roles).toEqual([{ participantId: ME, roles: ['builder'] }])

  await callTool($, 'orchard_call', { name: 'task_claim', arguments: { store_id: 'store1', task_id: 't1' } })
  await callTool($, 'orchard_call', { name: 'state_create', arguments: { id: 's1', title: 'Ship it', definition_id: 'flow', definition_version: 1, subject: { kind: 'task', task_id: 't1' } } })
  await w.clock.advance(1_100)
  expect(held(w).tasks.map(t => t.title)).toEqual(['Fix the awning'])
  expect(held(w).states.map(s => s.id)).toEqual(['s1'])
  expect(around(w).openTasks).toBe(0)
})

// ---- Disconnect / Connect ----

test('/orchard disconnect stops the loop and the timers, and wakes for nothing; /orchard connect starts again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)

  // an alert is pending, inside its batch window
  w.fake.push(direct('d1'), { reasons: ['direct'] })
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 1 })

  const out = await $.command.run(RUN('disconnect'))
  expect(out.text).toContain('Disconnected from Orchard')
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })
  expect((await $.command.run(RUN('disconnect'))).text).toContain('already disconnected')

  await w.clock.advance(61_000) // the call in flight when it happened comes back and is dropped
  const alerts = calls(w, 'alerts').length
  const everything = w.fake.calls.length
  w.fake.push(direct('d2'), { reasons: ['direct'] })
  await w.clock.advance(10 * 60_000)
  expect(calls(w, 'alerts').length).toBe(alerts)
  expect(w.fake.calls.length).toBe(everything) // not one call to the workspace: no poll, no retry, no refresh
  expect(w.submits).toEqual([])
  expect(w.fake.acks).toEqual([])
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })

  // the person's prompt carries nothing, the model's tools say so, a turn ending restarts nothing
  await $.prompt.submit(typed('hello'))
  await turnEnds($)
  await w.clock.settle()
  expect(w.submits.at(-1)?.context).toBeUndefined()
  expect(String((await callTool($, 'orchard_send', { body: 'hi', direct: 'owner' })).deny)).toContain('disconnected')
  expect(calls(w, 'mail_send')).toHaveLength(0)
  expect(w.fake.calls.length).toBe(everything)
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })

  // Connect: listening again, and what was pending is delivered
  expect((await $.command.run(RUN('connect'))).text).toBe('Connecting to Orchard…')
  await w.clock.advance(15_000)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(calls(w, 'alerts').length).toBeGreaterThan(alerts)
  expect(w.submits.some(s => s.origin !== undefined && JSON.stringify(s).includes('body of d1'))).toBe(true)
  expect((await $.command.run(RUN('connect'))).text).toContain('already connected')
})

test('a disconnected session does not retry an offline workspace', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.script = () => 'reject'
  await begin($, w)
  expect(w.state.latest.status).toMatchObject({ kind: 'offline' })
  await $.command.run(RUN('disconnect'))
  const resumed = resumes(w).length
  await w.clock.advance(20 * 60_000)
  expect(resumes(w).length).toBe(resumed)
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })
})

test('disconnecting lets go of a held wake: the status line is unpinned and nothing is notified again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.box.text = 'a draft I am typing'
  w.fake.push(direct('d1'), { reasons: ['direct'] })
  await w.clock.advance(11_000)
  expect(w.sinks.events.filter(e => e.name === 'ui.status').at(-1)?.text).toContain('orchard · 1 waiting for you')
  await $.command.run(RUN('disconnect'))
  expect(w.sinks.events.filter(e => e.name === 'ui.status').at(-1)?.text).toBe('orchard · disconnected') // the held notice is gone, the line says why
  const notified = w.sinks.events.filter(e => e.name === 'ui.notify').length
  w.box.text = ''
  await w.clock.advance(5 * 60_000)
  expect(w.sinks.events.filter(e => e.name === 'ui.notify')).toHaveLength(notified)
  expect(w.submits).toEqual([])
})

test('a disconnect is the session\'s own: a new session connects as usual, and the workspace counts start again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.fake.push(direct('d1'), { reasons: ['direct'] })
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(1)
  await $.command.run(RUN('disconnect'))
  expect(around(w)).toEqual({ recentFromOthers: 0, openTasks: null })

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
})

// ---- the session's participant signs off ----

test('the main agent signing off with mail_leave stops the session as a Disconnect does, as "signed off"; /orchard connect signs it on again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(table(w).main?.signedOn).toBe(true)

  // an alert is pending, inside its batch window
  w.fake.push(direct('d1'), { reasons: ['direct'] })
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 1 })

  const left = await callTool($, 'orchard_call', { name: 'mail_leave', arguments: {} })
  expect(left.deny).toBeUndefined()
  // it went out as the session's participant, with a request id of its own
  const leaves = calls(w, 'mail_leave').map(c => JSON.parse(c.stdin ?? '{}') as Record<string, unknown>)
  expect(leaves).toHaveLength(1)
  expect(leaves[0]).toMatchObject({ participant_id: ME })
  expect(String(leaves[0]?.request_id)).toMatch(/^orchard-mail-leave-/)
  expect(w.fake.isKnown).toBe(false)

  // the session is out of the workspace, with a status of its own; Orchard has it signed off
  expect(w.state.latest.status).toEqual({ kind: 'signed-off' })
  expect(await bandText($)).toBe('◇ Claude is signed off from Fruit Stand · /orchard connect')
  expect(table(w).main).toMatchObject({ handle: ME, signedOn: false })

  // nothing listens, retries, refreshes or wakes
  await w.clock.advance(61_000) // the call in flight when it happened comes back and is dropped
  const alerts = calls(w, 'alerts').length
  const everything = w.fake.calls.length
  w.fake.push(direct('d2'), { reasons: ['direct'] })
  await w.clock.advance(10 * 60_000)
  expect(calls(w, 'alerts').length).toBe(alerts)
  expect(w.fake.calls.length).toBe(everything)
  expect(w.submits).toEqual([])
  expect(w.fake.acks).toEqual([])
  expect(w.state.latest.status).toEqual({ kind: 'signed-off' })

  // the model's tools say so and make no call; a turn ending restarts nothing
  const denied = await callTool($, 'orchard_send', { body: 'hi', direct: 'owner' })
  expect(String(denied.deny)).toContain('signed off from Orchard')
  expect(String(denied.deny)).toContain('/orchard connect')
  await turnEnds($)
  await w.clock.settle()
  expect(w.fake.calls.length).toBe(everything)
  expect(w.state.latest.status).toEqual({ kind: 'signed-off' })

  // Connect signs the participant on again (it is not registered: resume fails, join follows) and listens
  const joins = w.fake.calls.filter(c => c.cmd === 'join').length
  expect((await $.command.run(RUN('connect'))).text).toBe('Connecting to Orchard…')
  await w.clock.advance(15_000)
  expect(w.fake.calls.filter(c => c.cmd === 'join').length).toBe(joins + 1)
  expect(w.fake.isKnown).toBe(true)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(table(w).main?.signedOn).toBe(true)
  expect(calls(w, 'alerts').length).toBeGreaterThan(alerts)
  expect(w.submits.some(x => x.origin !== undefined && JSON.stringify(x).includes('body of d1'))).toBe(true)
  expect(calls(w, 'mail_send')).toHaveLength(0)
})

test('mail_leave through orchard_call is the session participant\'s alone: another participant, a subagent and a refused call leave the session connected', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const { agentId } = await spawn($, 'Helper')

  const other = await callTool($, 'orchard_call', { name: 'mail_leave', arguments: { participant_id: 'claude-other' } })
  expect(other.deny).toContain("participant_id must be this session's own participant")
  const sub = await callTool($, 'orchard_call', { name: 'mail_leave', arguments: {}, agentId })
  expect(sub.deny).toContain('only the main agent may call it')
  expect(calls(w, 'mail_leave')).toHaveLength(0)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })

  // the workspace refuses it (the participant is not registered): the session stays as it was
  w.fake.script = call => (call.tool === 'mail_leave' ? { exitCode: 4, stderr: 'Orchard agent: tool error\n' } : undefined)
  const refused = await callTool($, 'orchard_call', { name: 'mail_leave', arguments: {} })
  expect(refused.deny).toContain('Orchard:')
  expect(calls(w, 'mail_leave')).toHaveLength(1)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(table(w).main?.signedOn).toBe(true)
  // and it still works as the session's participant
  expect((await callTool($, 'orchard_send', { body: 'still here', direct: 'owner' })).deny).toBeUndefined()
})

// ---- old data ----

test('records an earlier version kept in the store for snoozed and removed messages are ignored, left as they were, and never crash the listener', { options: OPTIONS }, async ($, on) => {
  const alert = {
    id: 'old1',
    sequence: 1,
    senderId: 'claude-other',
    senderName: 'Other Claude',
    kind: 'message',
    reasons: ['direct'],
    body: 'body of old1',
    bodyCut: 0,
    threadId: null,
    where: 'direct',
    channelId: null,
    sentAt: '2026-10-10T09:00:00Z',
    arrivedAt: 0,
  }
  const w = world(on, {
    store: {
      [snoozeKeyFor(ENDPOINT, ME)]: [{ id: 'old1', until: 5_000, alert }, { nonsense: true }, 'junk'],
      [hiddenKeyFor(ENDPOINT, ME)]: ['x', 7, null],
    },
  })
  await begin($, w)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })

  // the snoozed alert's time comes and goes: it is not brought back; a new alert is delivered as ever
  await w.clock.advance(60_000)
  expect(w.submits).toEqual([])
  w.fake.push(direct('d1'), { reasons: ['direct'] })
  await w.clock.advance(15_000)
  expect(w.submits.filter(s => JSON.stringify(s).includes('body of d1'))).toHaveLength(1)
  expect(w.fake.acks.flatMap(a => a.ids)).toEqual(['d1'])
  expect(w.store.data.get(snoozeKeyFor(ENDPOINT, ME))).toEqual([{ id: 'old1', until: 5_000, alert }, { nonsense: true }, 'junk'])
  expect(w.store.data.get(hiddenKeyFor(ENDPOINT, ME))).toEqual(['x', 7, null])
})
