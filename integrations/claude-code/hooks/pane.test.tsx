// The /orchard pane, its buttons and the notification settings, on every surface; and the
// /orchard notify command.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { storeKey } from './alerts'
import { settingsKey } from './classify'
import { DEFAULT_SETTINGS } from './classify'
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
  f.push({ id: 'm1', sender_id: 'owner', body: 'Can you check the build?', destination: { kind: 'direct', id: ME }, recipient_ids: [ME], sent_at: '2026-10-10T09:00:00Z' })
  f.push({ id: 'm2', sender_id: ME, body: 'On it', thread_id: 'm1', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'], sent_at: '2026-10-10T09:01:00Z' })
  f.push({ id: 'm3', sender_id: 'claude-other', body: 'Question about the awning\nsecond line', destination: { kind: 'direct', id: ME }, recipient_ids: [ME], sent_at: '2026-10-10T10:00:00Z' })
  f.push({ id: 'c1', sender_id: 'claude-other', body: 'noise in a channel I am not in', destination: { kind: 'channel', id: 'general' }, recipient_ids: ['owner'] })
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

/** Every string a pane draws: its Texts, and the markup and alt of its Svgs. */
async function drawnText(ui: Awaited<ReturnType<typeof mountPane>>) {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const svgs = (await ui.findAll({ type: 'Svg' })).flatMap(v => [String(v.props.source), String(v.props.alt)])
  return [...texts, ...svgs]
}

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function mountPane<S extends (typeof SURFACES)[number]>($: Engine, surface: S) {
  return $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: PANE_PROPS })
}

test('/orchard opens the pane and lists the inbox, what waits on the owner and the claimed tasks', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)

  const out = await openPane($, w)
  expect(out.text).toBe('Orchard pane opened.')
  expect(w.opened).toEqual([{ id: 'orchard', title: 'Orchard' }])

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const texts = await drawnText(ui)
    const all = texts.join('\n')

    // the header carries the workspace and, once, the participant id (in the drawing where there is one)
    expect(all).toContain('Fruit Stand')
    expect(all.split(`as ${ME}`).length - 1).toBe(1)
    expect(all.split(ME).length - 1).toBe(1)
    // furnish() leaves one open decision, so the chip says the session is waiting on the owner
    expect(all).toContain('waiting for you')
    expect(all).toContain('INBOX')

    // inbox threads this participant is in; the channel post it never received is not there
    expect(all).toContain('Nick')
    expect(all).toContain('OWNER')
    expect(all).toContain('Can you check the build?')
    expect(all).toContain('Other Claude')
    expect(all).toContain('DM')
    expect(all).toContain('Question about the awning')
    expect(all.includes('second line')).toBe(false)
    expect(all.includes('noise in a channel')).toBe(false)
    // needs-you: only the decision it raised that is still open; claimed tasks: only its own
    expect(all).toContain('Ship the awning?')
    expect(all.includes('Old question')).toBe(false)
    expect(all).toContain('Fix the awning')
    expect(all).toContain(' in progress ')
    expect(all.includes('in_progress')).toBe(false)
    expect(all.includes('Paint the stand')).toBe(false)
    expect(all).toContain('tending the grove')
    // message ids never show
    // (the markup's own colours and class names are not text a person reads)
    const readable = [...(await ui.findAll({ type: 'Text' })).map(t => t.text), ...(await ui.findAll({ type: 'Svg' })).map(v => String(v.props.alt)), ...(await ui.findAll({ type: 'Svg' })).flatMap(v => [...String(v.props.source).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(m => m[1] ?? ''))]
    for (const id of ['m1', 'm3', 'd1']) expect(readable.some(t => t.includes(id))).toBe(false)

    expect(await ui.find({ type: 'Button', key: 'reply-m1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reply-m3' })).toBeDefined()
    // one "Open in Orchard" for the whole pane, in the header; it is a Button, never a Link: the
    // surfaces draw a Link only for https and http://localhost, and Orchard turns the latter away
    expect(await ui.findAll({ type: 'Link' })).toEqual([])
    expect((await ui.find({ type: 'Button', key: 'open-workspace' }))?.props.label, surface).toBe('Open in Orchard')
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.label === 'Open in Orchard')).toHaveLength(1)
    await ui.unmount()
  }
  // reading the window also refreshed the band's needs-you count
  expect(w.state.latest.counts).toMatchObject({ needsYou: 1 })
})

test('Open in Orchard runs `open` on the exact loopback address, the endpoint\'s port and the right page, on every surface', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)

  const base = `${ORIGIN}/w/${WORKSPACE_ID}`
  const pages: [string, string][] = [
    ['open-workspace', `${base}/channels/general`],
    ['open-thread-m1', `${base}/messages/m1`],
    ['open-thread-m3', `${base}/messages/m3`],
    ['open-decision-d1', `${base}/messages/d1`],
    ['open-task-t1', `${base}/tasks/store1/t1`],
  ]
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    // a thread's own "Open thread" sits in its detail
    await ui.press({ key: 'toggle-m1' })
    await ui.press({ key: 'toggle-m3' })
    await w.clock.settle()
    for (const [key, url] of pages) {
      w.fake.opened.length = 0
      await ui.press({ key })
      await w.clock.settle()
      expect(w.fake.opened, `${surface} ${key}`).toEqual([url])
    }
    await ui.press({ key: 'toggle-m1' })
    await ui.press({ key: 'toggle-m3' })
    await w.clock.settle()
    await ui.unmount()
  }
  // the Orchard CLI was not used for it, and no address but the loopback one was ever opened
  expect(w.fake.calls.some(c => c.argv[0] === 'open')).toBe(false)
  expect(JSON.stringify(w.fake.opened).includes('localhost')).toBe(false)
})

test('Reply… fills the prompt with a draft and never submits', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const before = w.submits.length
    w.fills.length = 0
    w.box.text = ''
    await ui.press({ key: 'reply-m3' })
    await w.clock.settle()
    expect(w.fills).toEqual([{ text: 'Reply on Orchard to message m3 (orchard_reply): ', mode: 'append' }])

    // with a draft already in the box the reply starts on a new line, after it
    w.fills.length = 0
    w.box.text = 'something I was typing'
    await ui.press({ key: 'reply-m1' })
    await w.clock.settle()
    expect(w.fills).toEqual([{ text: '\n\nReply on Orchard to message m1 (orchard_reply): ', mode: 'append' }])
    expect(w.submits).toHaveLength(before)
    await ui.unmount()
  }
})

test('Refresh reads the workspace again', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n').includes('A brand new question')).toBe(false)

  w.fake.push({ id: 'm9', sender_id: 'claude-other', body: 'A brand new question', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] })
  await ui.press({ key: 'refresh' })
  await w.clock.settle()
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('A brand new question')
})

test('an unreachable workspace shows in the pane instead of an empty inbox', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  w.fake.script = () => 'reject'
  await openPane($, w)
  const ui = await mountPane($, 'terminal')
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(all).toContain('The workspace is not reachable')
  expect(all.includes('Nothing in your inbox')).toBe(false)
})

// ---- notification settings in the pane ----

test('the pane edits the notification levels and rates on surfaces with fields; mobile reads them as text', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  furnish(w)
  await begin($, w)
  await openPane($, w)
  const saved = () => w.store.data.get(SETTINGS)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await mountPane($, surface)
    const select = await ui.find({ type: 'Select', key: 'notify-default' })
    expect(select?.props.value).toBe('participating')
    expect((select?.props.options as { value: string }[]).map(o => o.value)).toEqual(['all', 'participating', 'mentions', 'nothing'])
    // one select per channel the participant can see, with a way back to the default
    expect(await ui.find({ type: 'Select', key: 'notify-channel-general' })).toBeDefined()
    const releases = await ui.find({ type: 'Select', key: 'notify-channel-releases' })
    expect((releases?.props.options as { value: string }[]).map(o => o.value)).toEqual(['inherit', 'all', 'participating', 'mentions', 'nothing'])
    expect((await ui.find({ type: 'Input', key: 'notify-batch' }))?.props.value).toBe('10')
    expect((await ui.find({ type: 'Input', key: 'notify-gap' }))?.props.value).toBe('60')

    await ui.select({ key: 'notify-default', value: 'mentions' })
    await w.clock.settle()
    expect(saved()).toMatchObject({ defaultLevel: 'mentions' })
    await ui.select({ key: 'notify-channel-releases', value: 'all' })
    await w.clock.settle()
    expect(saved()).toMatchObject({ defaultLevel: 'mentions', channels: { releases: 'all' } })
    expect((await ui.find({ type: 'Select', key: 'notify-channel-releases' }))?.props.value).toBe('all')

    await ui.input({ key: 'notify-batch', text: '5' })
    await ui.input({ key: 'notify-gap', text: '30' })
    await w.clock.settle()
    expect(saved()).toEqual({ defaultLevel: 'mentions', channels: { releases: 'all' }, batchSeconds: 5, gapSeconds: 30 })

    // back to the defaults for the next surface
    await ui.select({ key: 'notify-channel-releases', value: 'inherit' })
    await ui.select({ key: 'notify-default', value: 'participating' })
    await ui.input({ key: 'notify-batch', text: '10' })
    await ui.input({ key: 'notify-gap', text: '60' })
    await w.clock.settle()
    expect(saved()).toEqual(DEFAULT_SETTINGS)
    await ui.unmount()
  }

  const mobile = await mountPane($, 'mobile')
  expect(await mobile.findAll({ type: 'Select' })).toEqual([])
  expect(await mobile.findAll({ type: 'Input' })).toEqual([])
  expect((await mobile.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain(
    'Orchard notifications: default participating · no channel overrides · batch window 10 s · minimum gap 60 s',
  )
})

test('a rate that is not a number of seconds in range is refused with a toast and changes nothing', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')
  for (const text of ['soon', '-3', '999', '1.5', '']) {
    await ui.input({ key: 'notify-batch', text })
  }
  await w.clock.settle()
  expect(w.store.data.get(SETTINGS)).toBeUndefined()
  expect(w.sinks.seen.filter(line => line.includes('Orchard: batch is a whole number of seconds from 0 to 120')).length).toBeGreaterThan(0)
})

test('a changed level applies at once: do-not-disturb stops the wake of a message already pending', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await openPane($, w)
  const ui = await mountPane($, 'terminal')

  w.fake.push({ id: 'd1', sender_id: 'owner', body: 'ping', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 1 })
  await w.clock.advance(5_000)
  await ui.select({ key: 'notify-default', value: 'nothing' })
  await w.clock.settle()
  expect(w.state.latest.counts).toMatchObject({ unread: 1, forYou: 0 })
  await w.clock.advance(5 * 60_000)
  expect(w.submits).toEqual([])
  expect(await bandText($)).toBe('◆ orchard · 1 new')
})

test('a changed level takes out of the pending queue what it would no longer let in', { options: OPTIONS }, async ($, on) => {
  const w = world(on, { store: { [SETTINGS]: { ...DEFAULT_SETTINGS, channels: { releases: 'all' } } } })
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

// ---- /orchard notify ----

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
  const w = await (async () => {
    const x = world(on)
    await begin($, x)
    return x
  })()
  const say = async (args: string) => (await $.command.run(RUN(args))).text ?? ''
  expect(await say('notify default loud')).toContain('level is one of all, participating, mentions, nothing')
  expect(await say('notify default default')).toContain('the default level is one of')
  expect(await say('notify #nowhere all')).toContain('no channel named #nowhere; the channels are #general, #releases')
  expect(await say('notify batch 121')).toContain('batch is a whole number of seconds from 0 to 120')
  expect(await say('notify gap 3601')).toContain('gap is a whole number of seconds from 0 to 3600')
  expect(await say('notify gap soon')).toContain('gap is a whole number of seconds')
  expect(await say('notify everything')).toContain('Usage: /orchard notify')
  expect(await say('notify default')).toContain('Usage: /orchard notify')
  expect(await say('bogus')).toBe('Usage: /orchard [notify … | reconnect]')
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

// ---- the redesign: drawn header and rows, the fold, the status chip ----

function crowd(w: World, n: number) {
  for (let i = 1; i <= n; i++) {
    w.fake.push({ id: `p${i}`, sender_id: `peer-${i}`, body: `Peer message number ${i}`, destination: { kind: 'direct', id: ME }, recipient_ids: [ME], sent_at: `2026-10-10T0${i}:00:00Z` })
  }
}

test('the pane draws a header, an inbox and a footer: as Svg where a surface has one, as Text on the terminal', { options: OPTIONS }, async ($, on) => {
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
      expect(texts.some(t => t.startsWith('◆ Orchard · Fruit Stand'))).toBe(true)
      expect(texts.some(t => /Nick \[OWNER\]/.test(t))).toBe(true)
      expect(texts.some(t => t.includes('tending the grove'))).toBe(true)
    } else {
      expect(svgs.length, surface).toBeGreaterThan(4)
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

test('the newest five threads show; the rest fold behind a button that opens them', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  crowd(w, 7)
  await begin($, w)
  await openPane($, w)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const replies = async () => (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('reply-'))
    expect(await replies(), surface).toHaveLength(5)
    expect((await ui.find({ type: 'Button', key: 'older-threads' }))?.props.label).toBe('▸ 2 older threads')
    expect((await drawnText(ui)).join('\n')).not.toContain('Peer message number 1')

    await ui.press({ key: 'older-threads' })
    await w.clock.settle()
    expect(await replies()).toHaveLength(7)
    expect((await ui.find({ type: 'Button', key: 'older-threads' }))?.props.label).toBe('▾ hide older threads')
    expect((await drawnText(ui)).join('\n')).toContain('Peer message number 1')

    await ui.press({ key: 'older-threads' })
    await w.clock.settle()
    expect(await replies()).toHaveLength(5)
    await ui.unmount()
  }
})

test('a thread opens and closes its detail; unread rows are marked, read ones are not', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  crowd(w, 1)
  await begin($, w)
  await openPane($, w)

  const ui = await mountPane($, 'terminal')
  const text = async () => (await drawnText(ui)).join('\n')
  expect(await ui.find({ type: 'Button', key: 'open-thread-p1' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'toggle-p1' }))?.props.label).toBe('▸ more')
  await ui.press({ key: 'toggle-p1' })
  await w.clock.settle()
  expect((await ui.find({ type: 'Button', key: 'toggle-p1' }))?.props.label).toBe('▾ less')
  expect((await ui.find({ type: 'Button', key: 'open-thread-p1' }))?.props.label).toBe('Open thread')
  expect(await text()).toContain('1 message')
  await ui.press({ key: 'toggle-p1' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Button', key: 'open-thread-p1' })).toBeUndefined()
  await ui.unmount()
})

test('the status chip: green listening, amber waiting for you, red offline or error, grey another session', () => {
  const quiet = { unread: 0, forYou: 0, needsYou: 0 }
  expect(chipOf({ kind: 'connected' }, quiet)).toEqual({ kind: 'listening', label: 'listening' })
  expect(chipOf({ kind: 'connected' }, { ...quiet, needsYou: 1 })).toEqual({ kind: 'waiting', label: 'waiting for you' })
  expect(chipOf({ kind: 'connected' }, { ...quiet, unread: 1, forYou: 1, isHeld: true })).toEqual({ kind: 'waiting', label: 'waiting for you' })
  expect(chipOf({ kind: 'offline', failures: 2 }, quiet)).toEqual({ kind: 'offline', label: 'offline' })
  expect(chipOf({ kind: 'error', message: 'x' }, quiet).kind).toBe('error')
  expect(chipOf({ kind: 'shared' }, quiet)).toEqual({ kind: 'shared', label: 'another session is listening' })
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
})

test('drawings are sized from the pane width and clipped to it', () => {
  expect(widthOf(undefined)).toBe(440)
  expect(widthOf(55)).toBe(432)
  expect(widthOf(10)).toBe(300)
  expect(widthOf(500)).toBe(560)
})
