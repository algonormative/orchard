// A session joins Orchard only when asked: /orchard connect, the orchard_connect tool, autoConnect,
// or the same session having connected before. Otherwise the mod makes no call and shows nothing.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { connectedKey } from './config'
import { ENDPOINT, ME, OPTIONS, SID, UNCONNECTED } from './fake-orchard'
import { bandText, begin, callTool, typed, world } from './test-world'
import type { World } from './test-world'

const RUN = (args: string) => ({ command: 'orchard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
const REMEMBERED = connectedKey(ENDPOINT, SID)
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn' } as never
const PANE_PROPS = { title: 'Orchard', isFocused: false } as never

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'orchard', surface, component: 'Pane', requestId: 'orchard', props: PANE_PROPS })

const textsOf = async (ui: Awaited<ReturnType<typeof mountPane>>) => (await ui.findAll({ type: 'Text' })).map(t => String(t.text))
const keysOf = async (ui: Awaited<ReturnType<typeof mountPane>>) => (await ui.findAll({ type: 'Button' })).map(b => String(b.key))

/** Everything the mod could have done in a session nobody connected: all of it is nothing. */
async function expectSilent($: Engine, w: World) {
  expect(w.fake.calls).toEqual([])
  expect(await bandText($, 'terminal')).toBeUndefined()
  expect(await bandText($, 'desktop')).toBeUndefined()
  expect(w.sinks.events.filter(e => e.name === 'ui.status' && e.text !== undefined)).toEqual([])
  expect(w.opened).toEqual([])
  expect(w.submits.every(s => s.context === undefined)).toBe(true)
  expect(w.state.latest.status ?? null).toBeNull()
  expect(w.store.writes).toEqual([])
}

test('an unconnected session makes no call and shows nothing, however long it runs, and its tools refuse', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await w.clock.advance(10 * 60_000)
  await $.prompt.submit(typed('hello'))
  await $.turn.complete(TURN)
  await w.clock.settle()
  await expectSilent($, w)

  // the tools are registered (deferred), and each answers with the same short refusal
  expect(w.registered.map(t => t.name)).toContain('orchard_connect')
  for (const name of ['orchard_send', 'orchard_reply', 'orchard_ack', 'orchard_history', 'orchard_call']) {
    const answer = await callTool($, name, { body: 'x', direct: 'owner', message_id: 'm1', message_ids: ['m1'], name: 'tasks_list' })
    expect(String(answer.deny), name).toContain("this session isn't connected to Orchard")
    expect(String(answer.deny), name).toContain('/orchard connect')
    expect(String(answer.deny), name).toContain('orchard_connect')
  }
  expect(w.fake.calls).toEqual([])
})

test('a subagent, a Bash command and /orchard notify in an unconnected session reach nothing', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.agent.spawn({ description: 'Read the README', subagentType: 'Explore' } as never)
  await w.clock.settle()
  expect((await $.command.run(RUN('notify'))).text).toContain("isn't connected")
  expect((await $.command.run(RUN('disconnect'))).text).toContain("isn't connected")
  await expectSilent($, w)
  expect(w.state.latest.agents ?? null).toBeNull()
})

test('/orchard connect joins, listens and remembers the session', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await expectSilent($, w)

  expect((await $.command.run(RUN('connect'))).text).toBe('Connecting to Orchard…')
  await w.clock.advance(15_000)

  expect(w.fake.calls.some(c => c.cmd === 'resume' && c.argv.includes(ME))).toBe(true)
  expect(w.fake.calls.some(c => c.cmd === 'alerts')).toBe(true)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(w.store.data.get(REMEMBERED)).toBe(true)
  expect((await $.command.run(RUN('connect'))).text).toContain('already connected')
})

test('the orchard_connect tool does what /orchard connect does, and the other tools work after it', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const answer = await callTool($, 'orchard_connect')
  expect(String(answer.result)).toContain('connecting')
  await w.clock.advance(15_000)

  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(w.store.data.get(REMEMBERED)).toBe(true)
  expect(String((await callTool($, 'orchard_send', { body: 'hi', direct: 'owner' })).result)).toContain('Sent')
  expect(String((await callTool($, 'orchard_connect')).result)).toContain('already connected')
})

test('a fresh module instance of a session that connected before connects by itself', { options: UNCONNECTED }, async ($, on) => {
  // what the store kept from the earlier instance
  const w = world(on, { store: { [REMEMBERED]: true } })
  await begin($, w)
  await w.clock.advance(15_000)

  expect(w.fake.calls.some(c => c.cmd === 'resume' && c.argv.includes(ME))).toBe(true)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
})

test('another session of the same project is not remembered as connected', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on, { store: { [connectedKey(ENDPOINT, 'ffffff')]: true } })
  await begin($, w)
  await w.clock.advance(60_000)
  expect(w.fake.calls).toEqual([])
  expect(await bandText($)).toBeUndefined()
})

test('a remembered session that is reloaded without a session.start connects at its next prompt', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on, { store: { [REMEMBERED]: true } })
  await $.prompt.submit(typed('hello'))
  await w.clock.advance(15_000)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
})

test('/orchard disconnect forgets the session: its next start stays out', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.command.run(RUN('connect'))
  await w.clock.advance(15_000)
  expect(w.store.data.get(REMEMBERED)).toBe(true)

  await $.command.run(RUN('disconnect'))
  expect(w.store.data.has(REMEMBERED)).toBe(false)
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })

  // the next start of this session (the store is what a new instance would read)
  const calls = w.fake.calls.length
  await begin($, w)
  await w.clock.advance(60_000)
  expect(w.fake.calls.length).toBe(calls)
  expect(w.state.latest.status).toEqual({ kind: 'disconnected' })

  // Connect puts it back, and remembers it again
  await $.command.run(RUN('connect'))
  await w.clock.advance(15_000)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(w.store.data.get(REMEMBERED)).toBe(true)
})

test('the end of a connected session signs it off but keeps it remembered, so a resume connects again', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.command.run(RUN('connect'))
  await w.clock.advance(15_000)

  await $.session.end({ sessionId: 's1', reason: 'exit' } as never)
  expect(w.fake.calls.some(c => c.tool === 'mail_leave')).toBe(true)
  expect(w.store.data.get(REMEMBERED)).toBe(true)
})

test('signing off through orchard_call forgets the session', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.command.run(RUN('connect'))
  await w.clock.advance(15_000)

  const answer = await callTool($, 'orchard_call', { name: 'mail_leave' })
  expect(answer.deny).toBeUndefined()
  expect(w.state.latest.status).toEqual({ kind: 'signed-off' })
  expect(w.store.data.has(REMEMBERED)).toBe(false)
})

test('the end of an unconnected session signs nothing off', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.session.end({ sessionId: 's1', reason: 'exit' } as never)
  await expectSilent($, w)
})

test('autoConnect connects at start and remembers nothing', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await w.clock.advance(15_000)
  expect(w.fake.calls.some(c => c.cmd === 'resume' && c.argv.includes(ME))).toBe(true)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(w.store.data.has(REMEMBERED)).toBe(false)
})

test('the pane of an unconnected session is the prompt to connect and a Connect button, and nothing else', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const out = await $.command.run(RUN(''))
  await w.clock.settle()
  expect(out.text).toBeDefined()
  expect(w.fake.calls).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect(await textsOf(ui), surface).toEqual(["This session isn't connected to Orchard"])
    expect(await keysOf(ui), surface).toEqual(['connect'])
    expect(await ui.findAll({ type: 'Svg' }), surface).toEqual([])
    await ui.unmount()
  }

  // the button connects the session, and the pane becomes the usual one
  const ui = await mountPane($)
  await ui.press({ key: 'connect' })
  await w.clock.advance(15_000)
  expect(w.state.latest.status).toEqual({ kind: 'connected' })
  expect(w.store.data.get(REMEMBERED)).toBe(true)
  expect(await keysOf(ui)).toEqual(['open-workspace', 'disconnect'])
  await ui.unmount()
})

test('the pane never opens by itself in an unconnected session', { options: UNCONNECTED }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  await $.agent.spawn({ description: 'Read the README', subagentType: 'Explore' } as never)
  await w.clock.advance(60_000)
  expect(w.opened).toEqual([])
  expect(w.panes).toEqual([])
})
