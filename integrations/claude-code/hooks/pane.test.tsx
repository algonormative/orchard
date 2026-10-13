// The /orchard pane (a read-only view of what this session and its subagents do in Orchard: quiet when
// nothing happens, a section per kind of activity when something does) on every surface; the disconnect
// question; the pane opening by itself; the band and the status line; the /orchard notify command.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { OrchardActivityEntry, OrchardAgent } from '../types'
import { storeKey } from './alerts'
import { settingsKey } from './classify'
import { BASE, ENDPOINT, ME, OPTIONS } from './fake-orchard'
import { chipOf, widthOf } from './svg'
import { begin, bandText, callTool, expectNoSecrets, typed, visible, world, BAND_PROPS } from './test-world'
import type { World } from './test-world'

const SETTINGS = settingsKey(ENDPOINT, BASE)
const PANE_PROPS = { title: 'Orchard', isFocused: false } as never
const RUN = (args: string) => ({ command: 'orchard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
// Orchard's browser UI answers any Host but the exact loopback address with a 403, `localhost` included.
const ORIGIN = 'http://127.0.0.1:4312'
const WORKSPACE_ID = 'ws_0123456789abcdef'
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never

function furnish(w: World) {
  const f = w.fake
  f.push({ id: 'd1', sender_id: ME, kind: 'decision', body: 'Ship the awning?', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'], sent_at: '2026-10-10T11:00:00Z' })
  f.push({ id: 'd2', sender_id: ME, kind: 'decision', body: 'Old question', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
  f.push({ id: 'o2', sender_id: 'owner', body: 'yes', thread_id: 'd2', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] })
  f.tasks = [
    { id: 't1', title: 'Fix the awning', status: 'in_progress', assignee: ME },
    { id: 't2', title: 'Paint the stand', status: 'in_progress', assignee: 'claude-other' },
  ]
}

async function openPane($: Engine, w: World) {
  const out = await $.command.run(RUN(''))
  await w.clock.settle()
  return out
}

function mountPane<S extends (typeof SURFACES)[number]>($: Engine, surface: S) {
  return $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
}
type Pane = { findAll: (query: any) => Promise<any[]> }

/** Every string a pane draws: its Texts, and the markup and alt of its Svgs. */
async function drawnText(ui: { findAll: (query: any) => Promise<any[]> }) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  const svgs = (await ui.findAll({ type: 'Svg' })).flatMap(v => [String(v.props.source), String(v.props.alt)])
  return [...texts, ...svgs]
}
const keysOf = async (ui: Pane) => (await ui.findAll({ type: 'Button' })).map(b => String(b.key))
/** The header's and the activity toggle's buttons (the rows of items are not among them). */
const controlsOf = async (ui: Pane) => (await keysOf(ui)).filter(k => !/^(task|now|agent-row|activity|state|decision)-/.test(k))
const SECTIONS = ['NOW', 'TASKS', 'AGENTS', 'PLUGINS', 'ACTIVITY']
/** Which sections a pane draws: the label is a Text on the terminal, an Svg's alt elsewhere. */
async function sectionsOf(ui: Pane) {
  const labels = (await ui.findAll({ type: 'Text' })).map(t => String(t.text)).concat((await ui.findAll({ type: 'Svg' })).map(v => String(v.props.alt)))
  return SECTIONS.filter(name => labels.includes(name))
}

const wake = (w: World, id = 'm1', body = 'did the check pass?') =>
  w.fake.push({ id, sender_id: 'claude-other', body, destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })

const agent = (agentId: string, status: OrchardAgent['status'], extra: Partial<OrchardAgent> = {}): OrchardAgent => ({ agentId, description: agentId, type: 'general-purpose', status, startedAt: 1, ...extra })
const entry = (at: number, agentId: string, text: string, extra: Partial<OrchardActivityEntry> = {}): OrchardActivityEntry => ({ at, agentId, handle: ME, direction: 'out', kind: 'send', text, ...extra })

// ---- the quiet view, and growing ----

test('quiet: one sentence, the handle, two buttons and no sections, on every surface', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const all = (await drawnText(ui)).join('\n')
    expect(all, surface).toContain('Claude is connected to Fruit Stand')
    expect(all, surface).toContain(`as ${ME} · nothing in flight · steer from the prompt box`)
    expect(await sectionsOf(ui), surface).toEqual([])
    expect(await keysOf(ui), surface).toEqual(['open-workspace', 'disconnect'])
    expect((await ui.find({ type: 'Button', key: 'open-workspace' }))?.props.label).toBe('Open in Orchard ↗')
    expect((await ui.find({ type: 'Button', key: 'disconnect' }))?.props.label).toBe('Disconnect')
    // read-only: nothing to select, type or snooze
    for (const type of ['Select', 'Input', 'Markdown', 'Link']) expect(await ui.findAll({ type }), `${surface} ${type}`).toEqual([])
    for (const gone of ['INBOX', 'NOTIFY', 'Handle next', 'Snooze', 'Interrupt', 'Refresh']) expect(all.includes(gone), `${surface} ${gone}`).toBe(false)
    await ui.unmount()
  }
})

test('sections appear only when they have something, in order, and go when it does', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const all = (await drawnText(ui)).join('\n')
    // the claimed task and the decision it asked, nothing of anyone else's or an answered one
    expect(await sectionsOf(ui), surface).toEqual(['TASKS', 'PLUGINS'])
    expect(all, surface).toContain('Fix the awning')
    expect(all, surface).toContain('in progress')
    expect(all.includes('in_progress'), surface).toBe(false)
    expect(all.includes('Paint the stand'), surface).toBe(false)
    expect(all, surface).toContain('ASKED')
    expect(all, surface).toContain('Ship the awning?')
    expect(all.includes('Old question'), surface).toBe(false)
    // furnish() leaves one open decision, so the chip says the session is waiting on the owner
    expect(all, surface).toContain('waiting for you')
    expect(all.includes('Claude is connected to'), surface).toBe(false)
    // message ids never show
    for (const id of ['d1', 'd2', 'o2', 't1']) expect((await ui.findAll({ type: 'Text' })).some(t => String(t.text).includes(id)), `${surface} ${id}`).toBe(false)
    await ui.unmount()
  }

  // everything gone: the quiet view returns
  w.state.override.plugins = { attached: [], roles: [], states: [], decisions: [], tasks: [] }
  w.state.override.counts = { unread: 0, forYou: 0, needsYou: 0 }
  const ui = await mountPane($, 'terminal')
  expect(await sectionsOf(ui)).toEqual([])
  expect((await drawnText(ui)).join('\n')).toContain('Claude is connected to Fruit Stand')
  await ui.unmount()
})

test('NOW names the message the main loop handles from its delivery to the end of its turn; what waits behind it is counted', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.place.isPlaced = false // a pane waiting for room hides nothing: the band shows
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')
  expect(w.state.latest.now ?? null).toBeNull()

  wake(w, 'm1', 'did the check pass?\nsecond line')
  await w.clock.advance(11_000)
  expect(w.submits).toHaveLength(1)
  expect(w.state.latest.now).toMatchObject({ total: 1, items: [{ sender: 'Other Claude', how: 'DM', snippet: 'did the check pass?' }] })
  let all = (await drawnText(ui)).join('\n')
  expect(await sectionsOf(ui)).toContain('NOW')
  expect(all).toContain('Other Claude')
  expect(all).toContain(' · DM')
  expect(all).toContain('handling now')
  expect(all).toContain('“did the check pass?”')
  expect(await bandText($)).toBe('◆ Claude in Fruit Stand · handling DM from Other Claude')

  // a quiet broadcast behind it waits for the next prompt: counted, never sent by itself
  w.fake.push({ id: 'b1', sender_id: 'claude-other', body: 'standup', destination: { kind: 'broadcast' } }, { reasons: ['broadcast'] })
  await w.clock.settle()
  all = (await drawnText(ui)).join('\n')
  expect(all).toContain('1 more queued · waiting to be sent')
  expect(await bandText($)).toBe('◆ Claude in Fruit Stand · handling DM from Other Claude · 1 queued')

  // a subagent's turn ending is not the main loop's
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'end_turn', agentId: 'agent-9' } as never)
  await w.clock.settle()
  expect(w.state.latest.now).not.toBeNull()

  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(w.state.latest.now).toBeNull()
  all = (await drawnText(ui)).join('\n')
  expect(all.includes('handling now')).toBe(false)
  expect(all).toContain('1 queued · waiting to be sent')
  expect(await bandText($)).toBe('◆ Claude in Fruit Stand · 1 queued')
  await ui.unmount()
})

test('a held wake says it sends when the prompt box is empty', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  w.box.text = 'a draft'
  wake(w)
  await w.clock.advance(11_000)
  const ui = await mountPane($, 'terminal')
  expect((await drawnText(ui)).join('\n')).toContain('1 queued · sends when the prompt box is empty')
  await ui.unmount()
})

test('agents: main and each subagent as a tree, with the state Orchard and the engine report', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  w.state.override.agents = {
    main: agent('main', 'idle', { description: 'Claude', type: 'main', handle: ME, signedOn: true }),
    a1: agent('a1', 'running', { description: 'Phase Garden re-check', handle: `${ME}.garden`, observed: true, signedOn: true, lastAction: 'Sent to Ada: started' }),
    a2: agent('a2', 'completed', { description: 'Tarot paper audit', handle: `${ME}.tarot`, observed: true, signedOn: false, endedAt: 1 }),
    a3: agent('a3', 'completed', { description: 'Card VII proof', handle: `${ME}.vii`, observed: true, signedOn: true, endedAt: 1 }),
    a4: agent('a4', 'running', { description: 'Read the config' }),
    a5: agent('a5', 'running', { description: 'Write the notes', handle: ME, sharesBase: true }),
  }
  w.state.override.plugins = { attached: ['roles'], roles: [{ participantId: `${ME}.garden`, roles: ['plotter check'] }], states: [], decisions: [], tasks: [] }
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const all = (await drawnText(ui)).join('\n')
    expect(await sectionsOf(ui), surface).toEqual(['AGENTS', 'PLUGINS'])
    for (const text of ['main', 'Phase Garden re-check', `${ME}.garden`, '● signed on', '● running', '✓ done · signed off', '⚠ done · still signed on', 'not on Orchard', `shares ${ME}`, 'Sent to Ada: started']) {
      expect(all, `${surface} ${text}`).toContain(text)
    }
    // every agent row carries its state: three run, one signed on, one done and off, one done and still on, in that column
    const lines = all.split('\n')
    expect(lines.filter(l => l === '● running'), surface).toHaveLength(3)
    for (const state of ['● signed on', '✓ done · signed off', '⚠ done · still signed on']) expect(lines.filter(l => l === state), `${surface} ${state}`).toHaveLength(1)
    // the handle and the last action sit on the second line, dim, under the description
    expect(all, surface).toContain(`${ME}.garden · Sent to Ada: started`)
    // the roles row uses the short label of the handle
    expect(all, surface).toContain('plotter check')
    expect(all.split('\n'), surface).toContain('garden')
    expect(all.includes(`${ME}.garden plotter`), surface).toBe(false)
    await ui.unmount()
  }
})

// ---- activity ----

test('activity: the last 15 minutes, newest first; the toggle shows only when a subagent has entries and filters by agent', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  const t0 = w.clock.now()
  w.state.override.activity = [entry(t0, 'main', 'Replied to Ada'), entry(t0 + 1_000, 'agent-1', 'Sent to Bram: hi', { handle: `${ME}.garden` })]
  w.state.override.agents = { main: agent('main', 'idle', { handle: ME }), 'agent-1': agent('agent-1', 'running', { description: 'garden' }) }
  await w.clock.advance(5_000)

  const ui = await mountPane($, 'terminal')
  const texts = async () => (await drawnText(ui)).join('\n')
  expect(await controlsOf(ui)).toEqual(['open-workspace', 'disconnect', 'scope-this', 'scope-all'])
  expect(await texts()).toContain('replied to Ada')
  expect((await texts()).includes('sent to Bram')).toBe(false)

  await ui.press({ key: 'scope-all' })
  expect(w.state.latest.view).toEqual({ showSubagents: true, isConfirming: false })
  const both = await texts()
  expect(both).toContain('sent to Bram: hi')
  expect(both.indexOf('sent to Bram'), 'newest first').toBeLessThan(both.indexOf('replied to Ada'))
  await ui.press({ key: 'scope-this' })
  expect((await texts()).includes('sent to Bram')).toBe(false)

  // the verb reads after its arrow, lowercase, with the age at the right
  expect(await texts()).toContain('→ ')

  // with no subagent entries there is no toggle
  await ui.unmount()
  w.state.override.activity = [entry(w.clock.now(), 'main', 'Replied to Ada')]
  const plain = await mountPane($, 'terminal')
  expect(await controlsOf(plain)).toEqual(['open-workspace', 'disconnect'])
  await plain.unmount()
})

test('activity fades after 15 minutes and the pane returns to the quiet view', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  w.state.override.activity = [entry(w.clock.now(), 'main', 'Replied to Ada')]
  const ui = await mountPane($, 'terminal')
  expect(await sectionsOf(ui)).toEqual(['ACTIVITY'])
  await w.clock.advance(14 * 60_000)
  await ui.unmount()
  const mid = await mountPane($, 'terminal')
  expect(await sectionsOf(mid)).toEqual(['ACTIVITY'])
  await mid.unmount()
  await w.clock.advance(2 * 60_000)
  const late = await mountPane($, 'terminal')
  expect(await sectionsOf(late)).toEqual([])
  expect((await drawnText(late)).join('\n')).toContain('Claude is connected to Fruit Stand')
  await late.unmount()
})

// ---- rows open and copy ----

test('a row is a plain Button that opens its item in Orchard, and a small button copies the link', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)
  w.state.override.activity = [entry(w.clock.now(), 'main', 'Replied to Ada', { href: `${ORIGIN}/w/${WORKSPACE_ID}/messages/m9` }), entry(w.clock.now(), 'main', 'Changed something in the workspace')]
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const row = await ui.find({ type: 'Button', key: 'task-t1-open' })
    expect(row, surface).toBeDefined()
    expect(row?.props.plain, surface).toBe(true)
    const href = `${ORIGIN}/w/${WORKSPACE_ID}/tasks/store1/t1`
    w.fake.opened.length = 0
    w.copied.length = 0
    await ui.press({ key: 'task-t1-open' })
    await w.clock.settle()
    expect(w.fake.opened, surface).toEqual([href])
    expect(w.copied, surface).toEqual([])
    await ui.press({ key: 'task-t1-copy' })
    await w.clock.settle()
    expect(w.copied, surface).toEqual([{ text: href, surface }])
    expect(w.fake.opened, surface).toEqual([href])

    // an activity row with an address opens and copies; one without is plain Text
    expect(await keysOf(ui), surface).toContain('activity-1-open')
    expect(await keysOf(ui), surface).toContain('activity-1-copy')
    expect(await keysOf(ui), surface).not.toContain('activity-0-open')
    await ui.unmount()
  }
})

test('Open in Orchard runs `open` on the exact loopback address, the endpoint\'s port and the right page, on every surface', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    w.fake.opened.length = 0
    await ui.press({ key: 'open-workspace' })
    await w.clock.settle()
    expect(w.fake.opened, surface).toEqual([`${ORIGIN}/w/${WORKSPACE_ID}/channels/general`])
    await ui.unmount()
  }
  // the Orchard CLI was not used for it, and no address but the loopback one was ever opened
  expect(w.fake.calls.some(c => c.argv[0] === 'open')).toBe(false)
  expect(JSON.stringify(w.fake.opened).includes('localhost')).toBe(false)
})

// ---- disconnect asks first ----

test('Disconnect asks first: the header turns red, says what happens, and Cancel puts it back', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'disconnect' })
    await w.clock.settle()
    expect(w.state.latest.view, surface).toEqual({ showSubagents: false, isConfirming: true })
    expect(w.state.latest.status, surface).toEqual({ kind: 'connected' }) // asking is not doing
    const all = (await drawnText(ui)).join('\n')
    expect(all, surface).toContain('Stop Claude listening to Fruit Stand?')
    expect(all, surface).toContain(`this session only · ${ME} stays signed on`)
    expect(all, surface).toContain('/orchard connect brings it back')
    expect(all, surface).toContain(surface === 'terminal' ? 'ORCHARD // DISCONNECT?' : 'DISCONNECT?')
    expect(await keysOf(ui), surface).toEqual(['confirm-disconnect', 'cancel-disconnect'])
    // the whole header container is red: a themed red background, the sleepy red mascot on the surfaces that draw one
    expect(JSON.stringify(await ui.drawn()), surface).toContain('"backgroundColor":"diffRemovedDimmed"')
    if (surface !== 'terminal') expect(all, surface).toContain('class="red"')

    await ui.press({ key: 'cancel-disconnect' })
    await w.clock.settle()
    expect(w.state.latest.view, surface).toEqual({ showSubagents: false, isConfirming: false })
    expect(await keysOf(ui), surface).toEqual(['open-workspace', 'disconnect'])
    expect(JSON.stringify(await ui.drawn()), surface).not.toContain('diffRemovedDimmed')
    await ui.unmount()
  }
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
})

test('the question lapses after 10 s, and Yes disconnects the session and turns the pane into Connect, which connects it again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.place.isPlaced = false // a pane waiting for room hides nothing: the band shows
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'disconnect' })
  await w.clock.advance(9_000)
  expect(w.state.latest.view).toMatchObject({ isConfirming: true })
  await w.clock.advance(1_500)
  expect(w.state.latest.view).toMatchObject({ isConfirming: false })
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(await keysOf(ui)).toEqual(['open-workspace', 'disconnect'])

  await ui.press({ key: 'disconnect' })
  await ui.press({ key: 'confirm-disconnect' })
  await w.clock.settle()
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })
  expect(w.state.latest.view).toMatchObject({ isConfirming: false })
  expect(await keysOf(ui)).toEqual(['open-workspace', 'connect'])
  const all = (await drawnText(ui)).join('\n')
  expect(all).toContain('Claude is disconnected from Fruit Stand')
  expect(all).toContain('● disconnected')
  expect(await bandText($)).toBe('◇ Claude is disconnected from Fruit Stand · /orchard connect')

  await ui.press({ key: 'connect' })
  await w.clock.settle()
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(await keysOf(ui)).toEqual(['open-workspace', 'disconnect'])
  await ui.unmount()
})

test('a pane over a session whose participant signed off says so and offers Connect', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.place.isPlaced = false // a pane waiting for room hides nothing: the band shows
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')

  expect((await callTool($, 'orchard_call', { name: 'mail_leave', arguments: {} })).deny).toBeUndefined()
  await w.clock.settle()
  expect(w.state.latest.status).toEqual({ kind: 'signed-off' })
  expect(await keysOf(ui)).toEqual(['open-workspace', 'connect'])
  const all = (await drawnText(ui)).join('\n')
  expect(all).toContain('● signed off')
  expect(all).toContain('Claude has signed off from Fruit Stand')
  expect(await bandText($)).toBe('◇ Claude is signed off from Fruit Stand · /orchard connect')

  await ui.press({ key: 'connect' })
  await w.clock.advance(15_000)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(await keysOf(ui)).toEqual(['open-workspace', 'disconnect'])
  await ui.unmount()
})

// ---- the pane opens by itself ----

test('the pane opens on first activity, once, unasked; not again while it is up', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(w.opened).toEqual([]) // a quiet session opens nothing
  wake(w, 'm1')
  await w.clock.advance(11_000)
  expect(w.opened).toEqual([{ id: 'orchard', title: 'Orchard', focus: undefined }])
  wake(w, 'm2')
  await w.clock.advance(70_000)
  expect(w.opened).toHaveLength(1)
})

test('every first-activity trigger opens it: a delivery, a claimed task, a subagent', { options: OPTIONS }, async ($, on) => {
  const spawn = () =>
    $.agent.spawn({ tool_use_id: 'tu1', prompt: 'x', description: 'Check', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'sonnet', background: true, fork: false } as never)
  const a = world(on)
  a.fake.tasks = [{ id: 't1', title: 'Fix the awning', status: 'in_progress', assignee: ME }]
  await begin($, a)
  expect(a.opened.map(o => o.id)).toEqual(['orchard']) // the claimed task
  a.panes.length = 0
  a.opened.length = 0
  await spawn()
  await a.clock.settle()
  expect(a.opened.map(o => o.id)).toEqual(['orchard']) // the subagent
})

test('a window with no room leaves the pane waiting, quietly: no toast, no second try', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.place.isPlaced = false
  await begin($, w)
  wake(w, 'm1')
  await w.clock.advance(11_000)
  expect(w.opened).toHaveLength(1)
  expect(w.sinks.events.filter(e => e.name === 'ui.toast')).toEqual([])
  wake(w, 'm2')
  await w.clock.advance(70_000)
  expect(w.opened).toHaveLength(1) // it is listed by $.ui.panes() as waiting, so it is not asked for again
})

// ---- the band ----

test('the band stacks with the bands beneath it: it calls next(e) and keeps their content', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.below.band = '▤ beads · 14 ready'
  await begin($, w)
  for (const surface of ['terminal', 'desktop'] as const) {
    const text = (await bandText($, surface)) ?? ''
    expect(text, surface).toContain('◆ Claude is connected to Fruit Stand')
    expect(text, surface).toContain('▤ beads · 14 ready')
    expect(text.indexOf('◆ Claude'), surface).toBeLessThan(text.indexOf('▤ beads'))
  }
  // yielding to a survey leaves the engine's own
  expect(await bandText($, 'terminal', { ...(BAND_PROPS as object), hasSurvey: true })).not.toContain('Claude')
})

test('the band says it in one line per state: connected, handling, subagents, disconnected', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.place.isPlaced = false // a pane waiting for room hides nothing: the band shows
  await begin($, w)
  expect(await bandText($)).toBe('◆ Claude is connected to Fruit Stand')
  wake(w, 'm1')
  await w.clock.advance(11_000)
  expect(await bandText($)).toBe('◆ Claude in Fruit Stand · handling DM from Other Claude')
  await $.turn.complete(TURN)
  await w.clock.settle()
  await $.command.run(RUN('disconnect'))
  expect(await bandText($)).toBe('◇ Claude is disconnected from Fruit Stand · /orchard connect')
})

test('flicker probe: the band redraws only when its line changes, and a quiet session never redraws it', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  let draws = 0
  on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => {
    draws += 1
    const { Box } = $$.ui.resolve(e)
    return <Box />
  })
  await begin($, w)
  const ui = await $.ui.mount({ plugin: 'orchard', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await w.clock.settle()
  const settled = draws
  const writes = w.state.writes.band ?? 0
  await w.clock.advance(10 * 60_000)
  expect(draws).toBe(settled)
  expect(w.state.writes.band ?? 0).toBe(writes)

  // a delivery and the end of its turn: two line changes
  wake(w, 'm1')
  await w.clock.advance(11_000)
  await $.turn.complete(TURN)
  await w.clock.settle()
  expect(draws - settled).toBeLessThanOrEqual(((w.state.writes.band ?? 0) - writes) * 2)
  await ui.unmount()
})

// ---- the status line ----

const statusTexts = (w: World) => w.sinks.events.filter(e => e.name === 'ui.status').map(e => e.text)
const lastStatus = (w: World) => statusTexts(w).at(-1)

test('the status line says what the workspace does around this session: quiet or a count in ten minutes, and the open tasks', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.tasks = [{ id: 't1', title: 'One' }, { id: 't2', title: 'Two', status: 'open' }]
  await begin($, w)
  expect(lastStatus(w)).toBe('orchard · Fruit Stand · quiet · 2 open tasks')

  w.fake.push({ id: 'b1', sender_id: 'claude-other', body: 'standup', destination: { kind: 'broadcast' } }, { reasons: ['broadcast'] })
  await w.clock.settle()
  expect(lastStatus(w)).toBe('orchard · Fruit Stand · ● 1 in 10m · 2 open tasks')

  // it falls by itself as the alert leaves the window
  await w.clock.advance(11 * 60_000)
  expect(lastStatus(w)).toBe('orchard · Fruit Stand · quiet · 2 open tasks')
})

test('the status line omits the tasks while their count is unknown, and is written only when its text changes', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(lastStatus(w)).toMatch(/^orchard · Fruit Stand · quiet( · \d+ open tasks?)?$/)
  const before = statusTexts(w).length
  await w.clock.advance(10 * 60_000)
  expect(statusTexts(w)).toHaveLength(before)
  const texts = statusTexts(w)
  for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1])
})

test('the status line follows the connection, a held wake takes precedence, and the line is cleared when the session ends', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.box.text = 'a draft'
  wake(w, 'm1')
  await w.clock.advance(11_000)
  expect(lastStatus(w)).toBe('orchard · 1 waiting for you — sends when the prompt box is empty')
  w.box.text = ''
  await w.clock.advance(20_000)
  expect(lastStatus(w)).toMatch(/^orchard · Fruit Stand/)

  await $.command.run(RUN('disconnect'))
  expect(lastStatus(w)).toBe('orchard · disconnected')
  await $.command.run(RUN('connect'))
  await w.clock.settle()
  expect(lastStatus(w)).toMatch(/^orchard · Fruit Stand/)

  await $.session.end({ sessionId: 's1', reason: 'exit' } as never)
  expect(lastStatus(w)).toBeUndefined()
})

// ---- /orchard notify ----

test('a changed level applies at once: do-not-disturb stops the wake of a message already pending', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)

  w.fake.push({ id: 'd1', sender_id: 'owner', body: 'ping', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 1 })
  await w.clock.advance(5_000)
  await $.command.run(RUN('notify default nothing'))
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 0 })
  await w.clock.advance(5 * 60_000)
  expect(w.submits).toEqual([])
  expect(await bandText($)).toBe('◆ Claude in Fruit Stand · 1 queued')
})

test('a changed level takes out of the pending queue what it would no longer let in', { options: OPTIONS }, async ($, on) => {
  const w = world(on, { store: { [SETTINGS]: { defaultLevel: 'participating', channels: { releases: 'all' }, batchSeconds: 10, gapSeconds: 60 } } })
  await begin($, w)

  // a plain channel post wakes only because #releases is at all; a broadcast is quiet either way
  w.fake.push({ id: 'c2', sender_id: 'claude-other', body: 'v1.2 is out', destination: { kind: 'channel', id: 'releases' }, recipient_ids: ['owner'] }, { reasons: ['channel'], channel: { id: 'releases', name: 'releases' } })
  w.fake.push({ id: 'b1', sender_id: 'claude-other', body: 'standup', destination: { kind: 'broadcast' }, recipient_ids: [ME, 'owner'] }, { reasons: ['broadcast'] })
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 2, forYou: 1 })

  // #releases back to the default (participating): the post is a plain post again, and is let go
  const out = await $.command.run(RUN('notify #releases default'))
  expect(out.text).toContain('no channel overrides')
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 0 })
  expect(((w.state.latest.queue as { items: { id: string }[] }).items).map(i => i.id)).toEqual(['b1'])

  // it no longer wakes the session, and the broadcast that stays rides with the next prompt
  await w.clock.advance(5 * 60_000)
  expect(w.submits).toEqual([])
  await $.prompt.submit(typed('hello'))
  await w.clock.settle()
  expect(w.submits.at(-1)?.context?.[0]).toContain('standup')
  expect(w.submits.at(-1)?.context?.[0]?.includes('v1.2 is out')).toBe(false)
})

test('/orchard notify shows and sets the levels and rates', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const say = async (args: string) => (await $.command.run(RUN(args))).text ?? ''
  const saved = () => w.store.data.get(SETTINGS)

  expect(await say('notify')).toBe('Orchard notifications: default participating · no channel overrides · batch window 10 s · minimum gap 60 s')
  expect(saved()).toBeUndefined()

  expect(await say('notify default mentions')).toContain('default mentions')
  expect(await say('notify #releases all')).toContain('channels #releases all')
  expect(await say('notify #General nothing')).toContain('#general nothing')
  expect(await say('notify batch 5')).toContain('batch window 5 s')
  expect(await say('notify gap 120')).toContain('minimum gap 120 s')
  expect(saved()).toEqual({ defaultLevel: 'mentions', channels: { releases: 'all', general: 'nothing' }, batchSeconds: 5, gapSeconds: 120 })

  // "default" clears a channel's override
  expect(await say('notify #releases default')).toContain('channels #general nothing')
  expect(saved()).toMatchObject({ channels: { general: 'nothing' } })

  // the stored settings are what a restart reads
  expect(w.store.data.has(storeKey(ENDPOINT, ME))).toBe(true)
})

test('/orchard notify says what is wrong', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const say = async (args: string) => (await $.command.run(RUN(args))).text ?? ''
  expect(await say('notify default loud')).toContain('level is one of all, participating, mentions, nothing')
  expect(await say('notify default default')).toContain('the default level is one of')
  expect(await say('notify #nowhere all')).toContain('no channel named #nowhere; the channels are #general, #releases')
  expect(await say('notify batch 121')).toContain('batch is a whole number of seconds from 0 to 120')
  expect(await say('notify gap 3601')).toContain('gap is a whole number of seconds from 0 to 3600')
  expect(await say('notify gap soon')).toContain('gap is a whole number of seconds')
  expect(await say('notify everything')).toContain('Usage: /orchard notify')
  expect(await say('notify default')).toContain('Usage: /orchard notify')
  expect(await say('bogus')).toBe('Usage: /orchard [notify … | disconnect | connect | reconnect]')
  expect(w.store.data.get(SETTINGS)).toBeUndefined()
})

test('nothing the pane, the commands or the tools put where the model can read has a secret or a participant id it should not', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)
  const said = (await $.command.run(RUN('notify #releases all'))).text ?? ''
  const answers = [await callTool($, 'orchard_history', {}), await callTool($, 'orchard_call', { name: 'workspace_info' })]
  await $.prompt.submit(typed('hi'))
  expectNoSecrets([said, ...answers.map(a => String(a.result ?? a.deny)), ...(await visible($, w))])
})

// ---- the drawing ----

test('the pane draws its header and footer as Svg where a surface has one, as Text on the terminal, inside the budgets', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'terminal') {
      expect(svgs).toEqual([])
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      expect(texts).toContain('● waiting for you')
      expect(texts.some(t => t.startsWith("◆ Claude's view of Orchard"))).toBe(true)
      expect(texts).toContain(`as ${ME}`)
      expect(texts.some(t => t.includes('tending the grove'))).toBe(true)
    } else {
      expect(svgs.length, surface).toBeGreaterThan(2)
      let total = 0
      for (const v of svgs) {
        const source = String(v.props.source)
        total += source.length
        expect(source.length).toBeLessThan(120_000)
        // both themes: variables on :root, redefined for dark; no hex colour outside the style block
        expect(source).toContain('prefers-color-scheme: dark')
        expect(source.replace(/<style>[\s\S]*<\/style>/, '')).not.toMatch(/(fill|stroke)="#(?!81e78a)/)
        expect(source).not.toMatch(/<script|on\w+=/)
        expect(String(v.props.alt)).not.toBe('')
      }
      expect(total).toBeLessThan(240_000)
    }
    await ui.unmount()
  }
})

test('the status chip: green listening or working, amber waiting for you, red offline or error, grey disconnected or signed off', () => {
  const quiet = { unread: 0, forYou: 0, needsYou: 0 }
  expect(chipOf({ kind: 'connected' }, quiet)).toEqual({ kind: 'listening', label: 'listening' })
  expect(chipOf({ kind: 'connected' }, quiet, true)).toEqual({ kind: 'working', label: 'working' })
  expect(chipOf({ kind: 'connected' }, { ...quiet, needsYou: 1 })).toEqual({ kind: 'waiting', label: 'waiting for you' })
  expect(chipOf({ kind: 'connected' }, { ...quiet, unread: 1, forYou: 1, isHeld: true }, true)).toEqual({ kind: 'waiting', label: 'waiting for you' })
  expect(chipOf({ kind: 'offline', failures: 2 }, quiet)).toEqual({ kind: 'offline', label: 'offline' })
  expect(chipOf({ kind: 'error', message: 'x' }, quiet).kind).toBe('error')
  expect(chipOf({ kind: 'disconnected' }, quiet)).toEqual({ kind: 'disconnected', label: 'disconnected' })
  expect(chipOf({ kind: 'signed-off' }, quiet)).toEqual({ kind: 'signed-off', label: 'signed off' })
  expect(chipOf({ kind: 'connecting' }, quiet).kind).toBe('connecting')
  expect(chipOf(null, null).kind).toBe('connecting')
})

test('the header chip follows the connection on the pane', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  // a state the pane draws in full (not the quiet view): a task is claimed
  w.state.override.plugins = { attached: [], roles: [], states: [], decisions: [], tasks: [{ id: 't1', title: 'Fix', status: 'open', href: null }] }
  const header = async (surface: 'terminal' | 'desktop') => {
    const ui = await mountPane($, surface)
    const all = (await drawnText(ui)).join('\n')
    await ui.unmount()
    return all
  }
  expect(await header('desktop')).toMatch(/class="mono leaf" font-size="10.5">listening</)
  w.state.override.counts = { unread: 0, forYou: 0, needsYou: 1 }
  expect(await header('desktop')).toMatch(/class="mono warn" font-size="10.5">waiting for you</)
  expect(await header('terminal')).toContain('● waiting for you')
  w.state.override.status = { kind: 'offline', failures: 1 }
  expect(await header('desktop')).toMatch(/class="mono err" font-size="10.5">offline</)
  w.state.override.status = { kind: 'disconnected' }
  expect(await header('desktop')).toMatch(/class="mono dim" font-size="10.5">disconnected</)
  w.state.override.status = { kind: 'signed-off' }
  expect(await header('desktop')).toMatch(/class="mono dim" font-size="10.5">signed off</)
})

test('drawings are sized from the pane width and clipped to it', () => {
  expect(widthOf(undefined)).toBe(440)
  expect(widthOf(55)).toBe(432)
  expect(widthOf(10)).toBe(300)
  expect(widthOf(500)).toBe(560)
})

test('the band steps aside while the pane is open and comes back when it closes', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await w.clock.advance(15_000)
  expect(await bandText($, 'desktop')).toContain('Claude is connected to')

  await $.command.run(RUN(''))
  await $.ui.mount({ plugin: 'orchard', surface: 'desktop', component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
  await w.clock.advance(1_000)
  expect(await bandText($, 'desktop')).toBeUndefined()

  // the test engine cannot raise `ui.close`, so the pane goes from beneath: out of the list, and a reopen finds no room
  w.panes.length = 0
  w.place.isPlaced = false
  wake(w)
  await w.clock.advance(15_000)
  expect(await bandText($, 'desktop')).toMatch(/^◆ Claude in Fruit Stand · /)
})
