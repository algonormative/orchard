// The /orchard pane (a read-only view of what this session and its subagents do in Orchard, with
// two buttons) on every surface; the /orchard notify command; the status chip.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { storeKey } from './alerts'
import { settingsKey } from './classify'
import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
import { chipOf, widthOf } from './svg'
import { begin, bandText, callTool, expectNoSecrets, typed, visible, world } from './test-world'
import type { World } from './test-world'

const SETTINGS = settingsKey(ENDPOINT, ME)
const PANE_PROPS = { title: 'Orchard', isFocused: false } as never
const RUN = (args: string) => ({ command: 'orchard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
// Orchard's browser UI answers any Host but the exact loopback address with a 403, `localhost` included.
const ORIGIN = 'http://127.0.0.1:4312'
const WORKSPACE_ID = 'ws_0123456789abcdef'

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

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function mountPane<S extends (typeof SURFACES)[number]>($: Engine, surface: S) {
  return $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
}

/** Every string a pane draws: its Texts, and the markup and alt of its Svgs. */
async function drawnText(ui: { findAll: (query: any) => Promise<any[]> }) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
  const svgs = (await ui.findAll({ type: 'Svg' })).flatMap(v => [String(v.props.source), String(v.props.alt)])
  return [...texts, ...svgs]
}

test('/orchard opens the pane, and every surface draws a read-only view: this session, its tasks and what waits on the owner, two buttons', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)

  const out = await openPane($, w)
  expect(out.text).toBe('Orchard pane opened.')
  expect(w.opened).toEqual([{ id: 'orchard', title: 'Orchard', focus: true }])

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const all = (await drawnText(ui)).join('\n')

    // the header carries the workspace and, once, the participant id (in the drawing where there is one)
    expect(all).toContain('Fruit Stand')
    expect(all.split(`as ${ME}`).length - 1).toBe(1)
    expect(all.split(ME).length - 1).toBe(1)
    // furnish() leaves one open decision, so the chip says the session is waiting on the owner
    expect(all).toContain('waiting for you')
    // what waits on the owner: only the decision it raised that is still open; the tasks: only its own
    expect(all).toContain('Ship the awning?')
    expect(all.includes('Old question')).toBe(false)
    expect(all).toContain('Fix the awning')
    expect(all).toContain('in progress')
    expect(all.includes('in_progress')).toBe(false)
    expect(all.includes('Paint the stand')).toBe(false)
    // no inbox, no toolbar, no settings: nothing in the pane acts on a message
    for (const gone of ['INBOX', 'NOTIFY', 'Handle next', 'Snooze', 'Interrupt', 'Refresh']) expect(all.includes(gone), `${surface} ${gone}`).toBe(false)
    expect(await ui.findAll({ type: 'Select' })).toEqual([])
    expect(await ui.findAll({ type: 'Input' })).toEqual([])
    expect(await ui.findAll({ type: 'Markdown' })).toEqual([])
    expect(await ui.findAll({ type: 'Link' })).toEqual([])
    // its controls: Open in Orchard and Disconnect, standard Buttons
    expect((await ui.findAll({ type: 'Button' })).map(b => String(b.key))).toEqual(['open-workspace', 'disconnect'])
    expect((await ui.find({ type: 'Button', key: 'open-workspace' }))?.props.label).toBe('Open in Orchard ↗')
    expect((await ui.find({ type: 'Button', key: 'disconnect' }))?.props.label).toBe('Disconnect')
    // message ids never show
    for (const id of ['d1', 'd2', 'o2', 't1']) expect((await ui.findAll({ type: 'Text' })).some(t => String(t.text).includes(id)), `${surface} ${id}`).toBe(false)
    await ui.unmount()
  }
  expect(w.state.latest.counts).toMatchObject({ needsYou: 1 })
})

test('an idle session draws one quiet line: connected to the workspace, nothing going on', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n'), surface).toContain('Claude is connected to Fruit Stand. Nothing is going on yet.')
    await ui.unmount()
  }
})

test('Open in Orchard runs `open` on the exact loopback address, the endpoint\'s port and the right page, on every surface', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
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

test('the pane\'s Disconnect button disconnects the session and turns into Connect, which connects it again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'disconnect' })
  await w.clock.settle()
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })
  expect(await ui.find({ type: 'Button', key: 'disconnect' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'connect' }))?.props.label).toBe('Connect')
  const all = (await drawnText(ui)).join('\n')
  expect(all).toContain('● disconnected')
  expect(all).toContain('Disconnected: not listening')
  expect(all.includes('Nothing is going on yet')).toBe(false)
  expect(await bandText($)).toBe('◆ claude-fruit-stand in Fruit Stand · disconnected')

  await ui.press({ key: 'connect' })
  await w.clock.settle()
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect((await ui.find({ type: 'Button', key: 'disconnect' }))?.props.label).toBe('Disconnect')
  expect(await ui.find({ type: 'Button', key: 'connect' })).toBeUndefined()
  await ui.unmount()
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
  expect(await bandText($)).toBe('◆ claude-fruit-stand in Fruit Stand · 1 new')
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

test('the pane draws a header and a footer: as Svg where a surface has one, as Text on the terminal', { options: OPTIONS }, async ($, on) => {
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
      expect(texts).toContain(`this session · as ${ME} · Fruit Stand`)
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

test('the status chip: green listening, amber waiting for you, red offline or error, grey another session or disconnected', () => {
  const quiet = { unread: 0, forYou: 0, needsYou: 0 }
  expect(chipOf({ kind: 'connected' }, quiet)).toEqual({ kind: 'listening', label: 'listening' })
  expect(chipOf({ kind: 'connected' }, { ...quiet, needsYou: 1 })).toEqual({ kind: 'waiting', label: 'waiting for you' })
  expect(chipOf({ kind: 'connected' }, { ...quiet, unread: 1, forYou: 1, isHeld: true })).toEqual({ kind: 'waiting', label: 'waiting for you' })
  expect(chipOf({ kind: 'offline', failures: 2 }, quiet)).toEqual({ kind: 'offline', label: 'offline' })
  expect(chipOf({ kind: 'error', message: 'x' }, quiet).kind).toBe('error')
  expect(chipOf({ kind: 'shared' }, quiet)).toEqual({ kind: 'shared', label: 'another session is listening' })
  expect(chipOf({ kind: 'disconnected' }, quiet)).toEqual({ kind: 'disconnected', label: 'disconnected' })
  expect(chipOf({ kind: 'connecting' }, quiet).kind).toBe('connecting')
  expect(chipOf(null, null).kind).toBe('connecting')
})

test('the header chip follows the connection on the pane', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
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
  w.state.override.status = { kind: 'shared' }
  expect(await header('desktop')).toMatch(/class="mono dim" font-size="10.5">another session is listening</)
  w.state.override.status = { kind: 'disconnected' }
  expect(await header('desktop')).toMatch(/class="mono dim" font-size="10.5">disconnected</)
})

test('drawings are sized from the pane width and clipped to it', () => {
  expect(widthOf(undefined)).toBe(440)
  expect(widthOf(55)).toBe(432)
  expect(widthOf(10)).toBe(300)
  expect(widthOf(500)).toBe(560)
})
