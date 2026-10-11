// The /orchard pane, its buttons and the notification settings, on every surface; and the
// /orchard notify command.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { storeKey } from './alerts'
import { settingsKey } from './classify'
import { DEFAULT_SETTINGS } from './classify'
import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
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
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const all = texts.join('\n')

    // the header carries the workspace and, once, the participant id
    expect(texts[0]).toBe('Orchard · Fruit Stand')
    expect(texts[1]).toBe(` · as ${ME}`)
    expect(texts.filter(t => t.includes(ME))).toHaveLength(1)

    // inbox threads this participant is in; the channel post it never received is not there
    expect(all).toContain('Nick (owner) · 2026-10-10 09:00 · 2 messages')
    expect(all).toContain('Can you check the build?')
    expect(all).toContain('Other Claude · 2026-10-10 10:00')
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
    // message ids never show as text
    for (const id of ['m1', 'm3', 'd1']) expect(texts.some(t => t.includes(id))).toBe(false)

    expect(await ui.find({ type: 'Button', key: 'reply-m1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'reply-m3' })).toBeDefined()
    // "Open in Orchard" is a Button, never a Link: the surfaces draw a Link only for https and
    // http://localhost, and Orchard turns the latter away
    expect(await ui.findAll({ type: 'Link' })).toEqual([])
    for (const key of ['open-workspace', 'open-thread-m1', 'open-thread-m3', 'open-decision-d1', 'open-task-t1']) {
      expect((await ui.find({ type: 'Button', key }))?.props.label, key).toBe('Open in Orchard')
    }
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
    for (const [key, url] of pages) {
      w.fake.opened.length = 0
      await ui.press({ key })
      await w.clock.settle()
      expect(w.fake.opened, `${surface} ${key}`).toEqual([url])
    }
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
  expect(await bandText($)).toBe('Orchard · Fruit Stand · 1 new')
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
