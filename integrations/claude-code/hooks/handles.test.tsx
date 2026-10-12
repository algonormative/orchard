// The participants a session's subagents act as: a handle of the pool at an agent's first Orchard call, the
// lease that keeps two sessions off one slot, the fall back to the session's own participant, and what is
// let go when an agent or the session ends. Against the fake workspace and the mock clock.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
import type { Call } from './fake-orchard'
import { POOL_SUFFIX, RELEASED_LINGER_MS, SHARE_RETRY_MS, UNTRACKED_IDLE_MS, createBook, finished, joinedAs, lingering, markReleased, observe, ownHandles, shown, stanceOf, subHandle, subName, touch } from './handles'
import { LEASE_BEAT_MS, LEASE_STALE_MS, MAX_RECORDS, leaseKey, planEviction } from './lease'
import { begin, callTool, resumes, world } from './test-world'
import type { World } from './test-world'
import { RETRY_ADVICE } from './tools'
import type { OrchardActivityEntry, OrchardAgents, OrchardPlugins, OrchardWorkspaceActivity } from '../types'

const SUB = (n: number) => `${ME}.sub${n}`
const OTHER_SESSION = 'the-other-session'
const RUN = (args: string) => ({ command: 'orchard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })
const END = (reason: 'clear' | 'prompt_input_exit' | 'other') => ({ reason, sessionId: 'ending', resume: { id: 'ending' } })

const feed = (w: World) => (w.state.latest.activity ?? []) as OrchardActivityEntry[]
const table = (w: World) => (w.state.latest.agents ?? {}) as OrchardAgents
const around = (w: World) => w.state.latest.workspaceActivity as OrchardWorkspaceActivity
const held = (w: World) => w.state.latest.plugins as OrchardPlugins
const idOf = (call: Call) => call.argv[call.argv.indexOf('--participant-id') + 1]
const joins = (w: World) => w.fake.calls.filter(c => c.cmd === 'join')
const joinedIds = (w: World) => joins(w).map(idOf)
const resumedIds = (w: World) => resumes(w).map(idOf)
const senders = (w: World) => w.fake.sent.map(m => m.sender_id)
const leases = (w: World) => [...w.store.data.keys()].filter(k => k.startsWith('lease ') && POOL_SUFFIX.test(k))
const leaseOf = (w: World, n: number) => w.store.data.get(leaseKey(ENDPOINT, SUB(n))) as { session: string; at: number } | undefined
const mySession = (w: World) => (w.store.data.get(leaseKey(ENDPOINT, ME)) as { session: string }).session

/** An Agent call as the engine raises `agent.spawn` for it. */
const spawn = async ($: Engine, description = 'Look into it') =>
  (
    await $.agent.spawn({
      tool_use_id: 'tu1',
      prompt: 'do it',
      description,
      subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'sonnet',
      background: true,
      fork: false,
    } as never)
  ).agentId as string

const say = ($: Engine, agentId: string | undefined, body = 'hello') => callTool($, 'orchard_send', { body, direct: 'owner', ...(agentId === undefined ? {} : { agentId }) })
const turnEnds = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'end_turn', agentId } as never)

async function start($: Engine, on: Parameters<typeof world>[0]) {
  const w = world(on)
  await begin($, w)
  return w
}

const tick = async (n = 20) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}
/** Waits (a bounded number of turns) until `isTrue`, for something held up inside the engine to be reached. */
async function until(w: World, isTrue: () => boolean) {
  for (let i = 0; i < 200 && !isTrue(); i += 1) {
    await tick(50)
    await w.clock.settle()
  }
  expect(isTrue()).toBe(true)
}

/** Holds the resume of slot `n`'s handle, which is the entering of it, until `open`. Holds for other slots set earlier stay. */
function holdResume(w: World, n: number) {
  const hold = { isReached: false, open: () => {} }
  const gate = new Promise<void>(resolve => (hold.open = resolve))
  const earlier = w.fake.script
  w.fake.script = async (call, at) => {
    if (call.cmd !== 'resume' || idOf(call) !== SUB(n)) return earlier?.(call, at)
    hold.isReached = true
    await gate
    return undefined
  }
  return hold
}

/** Holds the next read of `key` in the store, after it has seen the value, until `open`. */
function holdRead(w: World, key: string) {
  const hold = { isReached: false, open: () => {} }
  const gate = new Promise<void>(resolve => (hold.open = resolve))
  w.store.before.get = read => {
    if (read !== key) return undefined
    w.store.before.get = undefined
    hold.isReached = true
    return gate
  }
  return hold
}

// ---- the pure parts ----

test('a pooled id is the base and .sub<N>, cut to keep Orchard\'s 128 characters; the name says which subagent', () => {
  expect(subHandle('claude-vault', 3)).toBe('claude-vault.sub3')
  const long = `claude-${'x'.repeat(121)}`
  expect(long).toHaveLength(128)
  expect(subHandle(long, 8)).toHaveLength(128)
  expect(subHandle(long, 8).endsWith('.sub8')).toBe(true)
  expect(subHandle(long, 8)).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
  expect(subName('Claude (vault)', 2)).toBe('Claude (vault) · subagent 2')
  expect(subName('x'.repeat(80), 8).length).toBeLessThanOrEqual(80)
  expect(subName('x'.repeat(80), 8).endsWith(' · subagent 8')).toBe(true)
})

test('joinedAs finds the participant a Bash command joins or resumes as, and nothing else', () => {
  const bin = '/Applications/Orchard.app/Contents/MacOS/Orchard'
  expect(joinedAs(`${bin} agent join --participant-id claude-helper --name 'Helper' --request-id r1`)).toBe('claude-helper')
  expect(joinedAs(`${bin} agent resume --participant-id=claude-helper`)).toBe('claude-helper')
  expect(joinedAs(`"${bin}" agent --endpoint "$E" --credential-file "$C" resume --participant-id "claude-helper"`)).toBe('claude-helper')
  expect(joinedAs(`cd /tmp && ${bin} agent join \\\n  --name Helper \\\n  --participant-id claude-helper.v2 --request-id r1 | jq .`)).toBe('claude-helper.v2')
  expect(joinedAs(`export ORCHARD_AGENT_ENDPOINT=x; orchard agent resume --participant-id claude-lower`)).toBe('claude-lower')
  // other commands, other subcommands, a variable, a participant past the limit, a different segment of the line
  expect(joinedAs(`${bin} agent alerts --participant-id claude-helper`)).toBeUndefined()
  expect(joinedAs(`${bin} agent send --sender-id claude-helper --channel general --body 'join --participant-id claude-x'`)).toBeUndefined()
  expect(joinedAs(`${bin} agent join --participant-id "$ID" --name X`)).toBeUndefined()
  expect(joinedAs(`${bin} agent join --participant-id ${'a'.repeat(129)}`)).toBeUndefined()
  expect(joinedAs(`${bin} agent tools; echo resume --participant-id claude-x`)).toBeUndefined()
  expect(joinedAs('ls -la')).toBeUndefined()
})

test('what the book says an agent acts as, which handles are the session\'s, and which agents are finished', () => {
  const book = createBook()
  const a = touch(book, 'a1', 0)
  expect(shown(ME, a)).toBeUndefined()
  a.sharedUntil = 60_000
  expect(shown(ME, a)).toEqual({ handle: ME, sharesBase: true })
  expect(observe(book, 'a1', 'claude-helper', 5)).toBe(true)
  expect(observe(book, 'a1', 'claude-helper', 6)).toBe(false)
  expect(shown(ME, a)).toEqual({ handle: 'claude-helper', observed: true })
  a.pooled = { slot: 2, handle: SUB(2) }
  expect(shown(ME, a)).toEqual({ handle: SUB(2) })
  expect(ownHandles(ME, book).sort()).toEqual([ME, 'claude-helper', SUB(2)].sort())

  const table: OrchardAgents = {
    a1: { agentId: 'a1', description: '', type: 'Explore', status: 'idle', startedAt: 0 },
    a2: { agentId: 'a2', description: '', type: 'Explore', status: 'failed', startedAt: 0 },
  }
  touch(book, 'a2', 0)
  touch(book, 'a3', 0)
  touch(book, 'a4', 50_000)
  // ended in the table: finished at once; unknown to it: only once quiet for a minute; running or idle: not
  expect(finished(book, table, 59_000).sort()).toEqual(['a2'])
  expect(finished(book, table, 60_000).sort()).toEqual(['a2', 'a3'])
})

test('an agent whose row says ended but whose last Orchard call is newer is let go only once it has been quiet for a minute', () => {
  const book = createBook()
  touch(book, 'a1', 10_000)
  const row = (endedAt: number | undefined): OrchardAgents => ({
    a1: { agentId: 'a1', description: '', type: 'Explore', status: 'completed', startedAt: 0, ...(endedAt === undefined ? {} : { endedAt }) },
  })
  // it ended after its last call (or at the same moment, or the row has no time): let go at once
  expect(finished(book, row(12_000), 12_000)).toEqual(['a1'])
  expect(finished(book, row(10_000), 10_000)).toEqual(['a1'])
  expect(finished(book, row(undefined), 10_000)).toEqual(['a1'])
  // the row is older than its last call: it ran again after it ended, and nothing has listed it since
  expect(finished(book, row(5_000), 11_000)).toEqual([])
  expect(finished(book, row(5_000), 10_000 + UNTRACKED_IDLE_MS - 1)).toEqual([])
  expect(finished(book, row(5_000), 10_000 + UNTRACKED_IDLE_MS)).toEqual(['a1'])
})

test('an agent sharing the session\'s participant waits one minute, a clock that moved back does not make it wait longer, and given-back handles linger two', () => {
  const book = createBook()
  const entry = touch(book, 'a1', 0)
  expect(stanceOf(entry, 0)).toBe('try')
  entry.sharedUntil = SHARE_RETRY_MS
  expect(stanceOf(entry, 1_000)).toBe('share')
  expect(stanceOf(entry, SHARE_RETRY_MS)).toBe('try')
  expect(stanceOf(entry, -3_600_000)).toBe('try')
  entry.pooled = { slot: 1, handle: SUB(1) }
  expect(stanceOf(entry, 1_000)).toBe('have')

  markReleased(book, [SUB(1), SUB(2)], 1_000)
  expect(lingering(book, 1_000 + RELEASED_LINGER_MS - 1)).toEqual([SUB(1), SUB(2)])
  expect(lingering(book, 1_000 + RELEASED_LINGER_MS)).toEqual([])
  markReleased(book, Array.from({ length: 100 }, (_, i) => `claude-x${i}`), 5_000)
  expect(book.released).toHaveLength(32)
})

test('the record eviction leaves a subagent slot\'s lease alone, whatever the cap', () => {
  const keys = [...Array.from({ length: MAX_RECORDS + 5 }, (_, i) => `lease ${ENDPOINT} claude-p${i}`), leaseKey(ENDPOINT, SUB(1)), leaseKey(ENDPOINT, 'claude-q.sub8')]
  const plan = planEviction(keys, [], { endpoint: ENDPOINT, participantId: ME }, 1_000)
  expect(plan.evict.some(k => POOL_SUFFIX.test(k))).toBe(false)
  expect(plan.evict.length).toBe(6)
})

// ---- a handle at the first call ----

test('a subagent\'s first Orchard call registers <base>.sub1 and the call acts as it: send, reply, ack, orchard_call', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  w.fake.tasks = [{ id: 't1', title: 'Fix the awning', assignee: null }]
  w.fake.push({ id: 'm1', sender_id: 'claude-other', body: 'question', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] })
  const agentId = await spawn($, 'Write the notes')

  expect((await say($, agentId, 'notes are up')).result).toContain('Sent')
  // resume first (never registered), then join with the display name that says which subagent
  expect(w.fake.calls.filter(c => idOf(c) === SUB(1)).map(c => c.cmd)).toEqual(['resume', 'join'])
  const join = joins(w)[0]
  expect(join?.argv.slice(join.argv.indexOf('--name'), join.argv.indexOf('--name') + 2)).toEqual(['--name', 'Claude (Fruit Stand) · subagent 1'])
  expect(w.fake.participants).toContainEqual({ id: SUB(1), name: 'Claude (Fruit Stand) · subagent 1' })
  expect(w.fake.sent[0]).toMatchObject({ sender_id: SUB(1), body: 'notes are up' })

  // the lease is this session's, under the slot's own key, like the session's own
  expect(leaseOf(w, 1)).toMatchObject({ session: mySession(w) })
  // the table and the feed say which participant the agent is
  expect(table(w)[agentId]).toMatchObject({ handle: SUB(1) })
  expect(table(w)[agentId]?.observed).toBeUndefined()
  expect(table(w)[agentId]?.sharesBase).toBeUndefined()
  expect(feed(w).filter(e => e.agentId === agentId).map(e => e.handle)).toEqual([SUB(1)])

  // every tool that names an actor is pinned to the handle, and naming the session's participant is refused
  await callTool($, 'orchard_reply', { message_id: 'm1', body: 'answer', agentId })
  expect(w.fake.sent[1]).toMatchObject({ sender_id: SUB(1), destination: { kind: 'direct', id: 'claude-other' } })
  await callTool($, 'orchard_ack', { message_ids: ['m1'], agentId })
  const ack = w.fake.calls.find(c => c.cmd === 'ack' && idOf(c) === SUB(1))
  expect(ack?.argv).toContain('m1')
  await callTool($, 'orchard_call', { name: 'task_claim', arguments: { store_id: 'store1', task_id: 't1' }, agentId })
  expect(w.fake.tasks[0]).toMatchObject({ assignee: SUB(1), status: 'in_progress' })
  const forged = await callTool($, 'orchard_call', { name: 'mail_send', arguments: { sender_id: ME, destination: { kind: 'broadcast' }, body: 'as the session' }, agentId })
  expect(String(forged.deny)).toContain("sender_id must be this agent's own participant")
  await callTool($, 'orchard_call', { name: 'mail_send', arguments: { sender_id: SUB(1), destination: { kind: 'broadcast' }, body: 'as myself' }, agentId })
  expect(w.fake.sent[2]).toMatchObject({ sender_id: SUB(1), body: 'as myself' })
  // a reply to the handle's own message goes where that message went
  await callTool($, 'orchard_reply', { message_id: 'm_sent_1', body: 'once more', agentId })
  expect(w.fake.sent.at(-1)).toMatchObject({ sender_id: SUB(1), destination: { kind: 'direct', id: 'owner' } })
  // history names no actor, so it reads the same for everyone
  await callTool($, 'orchard_history', { agentId })
  expect(w.fake.calls.filter(c => c.tool === 'mail_history').every(c => !JSON.stringify(c.stdin).includes(SUB(1)))).toBe(true)

  // the main loop is untouched: the session's own participant, no new registration
  await say($, undefined, 'from main')
  expect(w.fake.sent.at(-1)).toMatchObject({ sender_id: ME, body: 'from main' })
  expect(joinedIds(w)).toEqual([SUB(1)])
  expect(table(w).main).toMatchObject({ handle: ME })
})

test('later calls of the agent reuse its handle: no second join, no second resume', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($)
  await say($, agentId, 'one')
  await say($, agentId, 'two')
  await callTool($, 'orchard_ack', { message_ids: ['m9'], agentId })
  await w.clock.advance(5_000)
  await say($, agentId, 'three')

  expect(senders(w)).toEqual([SUB(1), SUB(1), SUB(1)])
  expect(joinedIds(w)).toEqual([SUB(1)])
  expect(resumedIds(w).filter(id => id === SUB(1))).toHaveLength(1)
})

test('two first calls of one agent together make one assignment: one join', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($)
  const [one, two, three] = await Promise.all([say($, agentId, 'one'), say($, agentId, 'two'), callTool($, 'orchard_ack', { message_ids: ['m9'], agentId })])

  expect([one.result, two.result].every(r => String(r).startsWith('Sent'))).toBe(true)
  expect(String(three.result)).toContain('Acknowledged')
  expect(joinedIds(w)).toEqual([SUB(1)])
  expect(senders(w)).toEqual([SUB(1), SUB(1)])
  expect(w.fake.acks.at(-1)?.ids).toEqual(['m9'])
  expect(leases(w)).toEqual([leaseKey(ENDPOINT, SUB(1))])
})

test('two agents get two handles, whether their first calls come one after the other or together', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const a = await spawn($, 'A')
  const b = await spawn($, 'B')
  await say($, a, 'from a')
  await say($, b, 'from b')
  expect(senders(w)).toEqual([SUB(1), SUB(2)])
  expect(table(w)[a]?.handle).toBe(SUB(1))
  expect(table(w)[b]?.handle).toBe(SUB(2))

  const c = await spawn($, 'C')
  const d = await spawn($, 'D')
  await Promise.all([say($, c, 'from c'), say($, d, 'from d')])
  expect(new Set(senders(w).slice(2))).toEqual(new Set([SUB(3), SUB(4)]))
  expect(joinedIds(w).sort()).toEqual([SUB(1), SUB(2), SUB(3), SUB(4)])
})

// ---- the lease: a slot another session holds is passed over, and a clash is found at the next beat ----

test('a slot another session leases is skipped; a stale lease, and this session\'s own, are taken', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  const now = await w.clock.now()
  w.store.data.set(leaseKey(ENDPOINT, SUB(1)), { session: OTHER_SESSION, at: now })
  w.store.data.set(leaseKey(ENDPOINT, SUB(2)), { session: OTHER_SESSION, at: now - LEASE_STALE_MS - 1_000 })
  await begin($, w)
  w.store.data.set(leaseKey(ENDPOINT, SUB(3)), { session: mySession(w), at: now })
  const [a, b, c] = [await spawn($, 'A'), await spawn($, 'B'), await spawn($, 'C')]

  await say($, a)
  await say($, b)
  await say($, c)
  expect(senders(w)).toEqual([SUB(2), SUB(3), SUB(4)])
  expect(leaseOf(w, 1)).toEqual({ session: OTHER_SESSION, at: now })
  expect(leaseOf(w, 2)?.session).toBe(mySession(w))
  expect(leaseOf(w, 3)?.session).toBe(mySession(w))
  expect(joinedIds(w)).toEqual([SUB(2), SUB(3), SUB(4)])
})

test('a write that another session\'s overwrote at once is not a lease: the slot is passed over', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  // the other session writes just after this one does
  w.store.after.set = key => {
    if (key === leaseKey(ENDPOINT, SUB(1))) w.store.data.set(key, { session: OTHER_SESSION, at: w.clock.now() })
  }
  const agentId = await spawn($)

  await say($, agentId, 'one')
  expect(senders(w)).toEqual([SUB(2)])
  expect(leaseOf(w, 1)?.session).toBe(OTHER_SESSION)
  expect(leaseOf(w, 2)?.session).toBe(mySession(w))
  expect(joinedIds(w)).toEqual([SUB(2)])
})

test('a lease another session wrote in the same moment is found at the next beat: the agent goes back to the session\'s own participant', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($)
  await say($, agentId, 'one')
  expect(leaseOf(w, 1)?.session).toBe(mySession(w))

  w.store.data.set(leaseKey(ENDPOINT, SUB(1)), { session: OTHER_SESSION, at: await w.clock.now() })
  await w.clock.advance(LEASE_BEAT_MS + 1_000)
  // the other session's lease is not touched, and the agent now acts as the session
  expect(leaseOf(w, 1)?.session).toBe(OTHER_SESSION)
  expect(table(w)[agentId]).toMatchObject({ handle: ME, sharesBase: true })
  expect(feed(w).filter(e => e.kind === 'handle').map(e => e.text)).toEqual(["Shares this session's Orchard identity: another session took its handle"])
  await say($, agentId, 'two')
  expect(senders(w)).toEqual([SUB(1), ME])
  // the slot is the other session's: a new agent skips it
  const next = await spawn($, 'Next')
  await say($, next, 'three')
  expect(senders(w).at(-1)).toBe(SUB(2))
})

test('the held lease is renewed with the beat, as the session\'s own is', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($)
  await say($, agentId)
  const first = leaseOf(w, 1)?.at ?? 0
  await w.clock.advance(LEASE_BEAT_MS + 1_000)
  const second = leaseOf(w, 1)?.at ?? 0
  expect(second).toBeGreaterThan(first)
  await w.clock.advance(LEASE_BEAT_MS * 2)
  expect(leaseOf(w, 1)?.at ?? 0).toBeGreaterThan(second)
  expect(leaseOf(w, 1)?.session).toBe(mySession(w))
})

// ---- release, and a slot used again ----

test('a handle goes back when its agent ends, and a later agent gets the slot again by resume, not join', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const a = await spawn($, 'A')
  await say($, a, 'from a')
  expect(leaseOf(w, 1)).toBeDefined()

  const listed = w.agents.list.find(x => x.id === a)
  if (listed !== undefined) listed.status = 'completed'
  await turnEnds($, a)
  await w.clock.settle()
  expect(leaseOf(w, 1)).toBeUndefined()
  // the table still says which participant it was
  expect(table(w)[a]).toMatchObject({ status: 'completed', handle: SUB(1) })

  const c = await spawn($, 'C')
  await say($, c, 'from c')
  expect(senders(w)).toEqual([SUB(1), SUB(1)])
  expect(joinedIds(w)).toEqual([SUB(1)])
  expect(resumedIds(w).filter(id => id === SUB(1))).toHaveLength(2)
  expect(table(w)[c]?.handle).toBe(SUB(1))
  expect(leaseOf(w, 1)?.session).toBe(mySession(w))
})

test('an agent that leaves the engine\'s list gives its handle back as lost; a running one keeps it', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const a = await spawn($, 'A')
  const b = await spawn($, 'B')
  await say($, a)
  await say($, b)
  expect(leases(w)).toHaveLength(2)

  w.agents.list = w.agents.list.filter(x => x.id !== a)
  await w.clock.advance(2_500)
  expect(table(w)[a]?.status).toBe('lost')
  expect(leaseOf(w, 1)).toBeUndefined()
  expect(leaseOf(w, 2)).toBeDefined()
})

test('an agent the engine does not list lets its handle go once it has been quiet for a minute', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  await say($, 'workflow-agent')
  expect(senders(w)).toEqual([SUB(1)])
  // the table was asked for it and does not know it: nothing is invented
  expect(table(w)['workflow-agent']).toBeUndefined()

  await w.clock.advance(40_000)
  expect(leaseOf(w, 1)).toBeDefined()
  await say($, 'workflow-agent', 'still here')
  await w.clock.advance(50_000)
  expect(leaseOf(w, 1)).toBeDefined()
  await w.clock.advance(30_000)
  expect(leaseOf(w, 1)).toBeUndefined()
  // a later call takes a handle again, by resume
  await say($, 'workflow-agent', 'back')
  expect(senders(w)).toEqual([SUB(1), SUB(1), SUB(1)])
  expect(joinedIds(w)).toEqual([SUB(1)])
})

test('session.end gives every handle back, but not after /clear and never a lease another session now holds', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const [a, b] = [await spawn($, 'A'), await spawn($, 'B')]
  await say($, a)
  await say($, b)
  expect(leases(w)).toHaveLength(2)

  await $.session.end(END('clear'))
  await w.clock.settle()
  expect(leases(w)).toHaveLength(2)

  w.store.data.set(leaseKey(ENDPOINT, SUB(2)), { session: OTHER_SESSION, at: await w.clock.now() })
  await $.session.end(END('prompt_input_exit'))
  await w.clock.settle()
  expect(leaseOf(w, 1)).toBeUndefined()
  expect(leaseOf(w, 2)?.session).toBe(OTHER_SESSION)
  expect(w.store.data.has(leaseKey(ENDPOINT, ME))).toBe(false)
  // nothing beats a lease any more
  await w.clock.advance(LEASE_BEAT_MS * 3)
  expect(leaseOf(w, 1)).toBeUndefined()
})

test('Disconnect gives the handles back and clears the assignments; Connect, and the agent\'s next call, resume it', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const a = await spawn($, 'A')
  await say($, a)
  expect(leaseOf(w, 1)).toBeDefined()

  await $.command.run(RUN('disconnect'))
  await w.clock.settle()
  expect(leases(w)).toEqual([])
  expect(String((await say($, a)).deny)).toContain('disconnected')
  await w.clock.advance(LEASE_BEAT_MS * 2)
  expect(leases(w)).toEqual([])

  await $.command.run(RUN('connect'))
  await w.clock.settle()
  await say($, a, 'back')
  expect(senders(w)).toEqual([SUB(1), SUB(1)])
  expect(joinedIds(w)).toEqual([SUB(1)])
  expect(leaseOf(w, 1)?.session).toBe(mySession(w))
})

test('/orchard reconnect starts the pool over: the handles go back and are taken again at the next call', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const a = await spawn($, 'A')
  await say($, a)
  await $.command.run(RUN('reconnect'))
  await w.clock.settle()
  expect(leases(w)).toEqual([])
  await say($, a, 'again')
  expect(senders(w)).toEqual([SUB(1), SUB(1)])
  expect(joinedIds(w)).toEqual([SUB(1)])
})

// ---- the session changes while a handle is being taken, or while a lease is being renewed ----

test('Disconnect while a handle is being entered: the call is refused as disconnected, nothing is sent as the session, and the handle goes back', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const hold = holdResume(w, 1)
  const agentId = await spawn($)

  const pending = say($, agentId, 'after disconnect')
  await until(w, () => hold.isReached)
  await $.command.run(RUN('disconnect'))
  hold.open()
  const answer = await pending
  await w.clock.settle()

  expect(String(answer.deny)).toContain('disconnected')
  expect(w.fake.sent).toEqual([])
  expect(leases(w)).toEqual([])
})

// What the claim that started before the session started over must not leave behind, whichever way the session started over.
const STARTS_OVER: { how: string; run: ($: Engine, w: World) => Promise<void> }[] = [
  {
    how: '/orchard reconnect',
    run: async ($, w) => {
      await $.command.run(RUN('reconnect'))
      await w.clock.settle()
    },
  },
  {
    how: 'Disconnect and Connect',
    run: async ($, w) => {
      await $.command.run(RUN('disconnect'))
      await $.command.run(RUN('connect'))
      await w.clock.settle()
    },
  },
]

for (const { how, run } of STARTS_OVER) {
  test(`${how} while a handle is being entered: the call that waited for it claims again, and the old claim hands its slot back`, { options: OPTIONS }, async ($, on) => {
    const w = await start($, on)
    const hold = holdResume(w, 1)
    const agentId = await spawn($)

    const pending = say($, agentId, 'across it')
    await until(w, () => hold.isReached)
    await run($, w)
    hold.open()
    const answer = await pending
    await w.clock.settle()

    // it acts as a handle of its own, not as the session, and holds the one lease
    expect(String(answer.result)).toContain('Sent')
    expect(senders(w)).toEqual([SUB(1)])
    expect(leases(w)).toEqual([leaseKey(ENDPOINT, SUB(1))])
    expect(table(w)[agentId]).toMatchObject({ handle: SUB(1) })
  })

  test(`${how} while a handle is being entered, then another call of the agent: it does not join the old claim, and the old claim does not take the slot it was handed`, { options: OPTIONS }, async ($, on) => {
    const w = await start($, on)
    const hold = holdResume(w, 1)
    const agentId = await spawn($)

    const first = say($, agentId, 'first')
    await until(w, () => hold.isReached)
    await run($, w)
    const second = say($, agentId, 'second')
    await tick(200)
    hold.open()
    const answers = await Promise.all([first, second])
    await w.clock.settle()

    // both went as one handle of this session (the old claim still had slot 1, so the new one took slot 2) and only that one is leased
    expect(answers.map(a => String(a.result).startsWith('Sent'))).toEqual([true, true])
    const used = [...new Set(senders(w))]
    expect(used).toHaveLength(1)
    expect(POOL_SUFFIX.test(String(used[0]))).toBe(true)
    expect(leases(w)).toEqual([leaseKey(ENDPOINT, String(used[0]))])
    expect(table(w)[agentId]).toMatchObject({ handle: used[0] })
  })
}

test('a claim that began before the pool started over does not end the single flight of the claim that took its place', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const [oldHold, newHold] = [holdResume(w, 1), holdResume(w, 2)]
  const agentId = await spawn($)

  const first = say($, agentId, 'first')
  await until(w, () => oldHold.isReached)
  await $.command.run(RUN('reconnect'))
  await w.clock.settle()
  const second = say($, agentId, 'second')
  await until(w, () => newHold.isReached)
  // the old claim ends while the new one is still entering slot 2: a call now waits for the new one, it does not start a third
  oldHold.open()
  await w.clock.settle()
  const third = say($, agentId, 'third')
  await w.clock.settle()
  newHold.open()
  await Promise.all([first, second, third])
  await w.clock.settle()

  expect(new Set(senders(w))).toEqual(new Set([SUB(2)]))
  expect(senders(w)).toHaveLength(3)
  expect(leases(w)).toEqual([leaseKey(ENDPOINT, SUB(2))])
  expect(joinedIds(w).filter(id => id === SUB(3))).toEqual([])
})

test('a beat that is reading the lease when the session ends does not write it back', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($)
  await say($, agentId, 'one')
  expect(leaseOf(w, 1)).toBeDefined()

  const read = holdRead(w, leaseKey(ENDPOINT, SUB(1)))
  const beat = w.clock.advance(LEASE_BEAT_MS + 500)
  await until(w, () => read.isReached)
  await $.session.end(END('prompt_input_exit'))
  expect(leases(w)).toEqual([])
  read.open()
  await beat
  await w.clock.settle()

  expect(leases(w)).toEqual([])
})

test('a beat that is reading the lease when its agent ends does not write it back', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($)
  await say($, agentId, 'one')

  const read = holdRead(w, leaseKey(ENDPOINT, SUB(1)))
  const beat = w.clock.advance(LEASE_BEAT_MS + 500)
  await until(w, () => read.isReached)
  const listed = w.agents.list.find(x => x.id === agentId)
  if (listed !== undefined) listed.status = 'completed'
  await turnEnds($, agentId)
  await until(w, () => leaseOf(w, 1) === undefined)
  read.open()
  await beat
  await w.clock.settle()

  expect(leases(w)).toEqual([])
})

test('an agent whose row says ended but that runs again keeps its handle: the call asks the engine, and a beat does not give it back', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const a = await spawn($, 'A')
  await say($, a, 'one')
  const listed = w.agents.list.find(x => x.id === a)
  if (listed !== undefined) listed.status = 'completed'
  await turnEnds($, a)
  await w.clock.settle()
  expect(leaseOf(w, 1)).toBeUndefined()
  expect(table(w)[a]).toMatchObject({ status: 'completed' })

  // a message resumes it: the engine lists it running again, but nothing has asked the list yet
  await w.clock.advance(5_000)
  if (listed !== undefined) listed.status = 'running'
  await say($, a, 'two')
  expect(table(w)[a]).toMatchObject({ status: 'running', handle: SUB(1) })

  await w.clock.advance(LEASE_BEAT_MS + 1_000)
  expect(leaseOf(w, 1)?.session).toBe(mySession(w))
  await say($, a, 'three')
  expect(senders(w)).toEqual([SUB(1), SUB(1), SUB(1)])
  // one resume for each of the two times it took the handle, none for the third call
  expect(resumedIds(w).filter(id => id === SUB(1))).toHaveLength(2)
})

// ---- the pool is full, or the handle cannot be set up: the call still works ----

test('with every slot leased elsewhere the call goes through as the session, says so once, and asks again no sooner than a minute later', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  const now = await w.clock.now()
  for (let n = 1; n <= 8; n += 1) w.store.data.set(leaseKey(ENDPOINT, SUB(n)), { session: OTHER_SESSION, at: now })
  await begin($, w)
  const agentId = await spawn($, 'Busy')

  expect((await say($, agentId, 'one')).result).toContain('Sent')
  expect(senders(w)).toEqual([ME])
  expect(joinedIds(w)).toEqual([])
  expect(resumedIds(w).some(id => id?.includes('.sub'))).toBe(false)
  expect(table(w)[agentId]).toMatchObject({ handle: ME, sharesBase: true })
  expect(feed(w).filter(e => e.kind === 'handle')).toHaveLength(1)
  expect(feed(w).find(e => e.kind === 'handle')).toMatchObject({ agentId, handle: ME, text: "Shares this session's Orchard identity: no subagent handle was free" })
  // the note is not the agent's last action
  expect(table(w)[agentId]?.lastAction).toBe('Sent to Nick: one')

  // a slot frees up; the agent is not asked about it again for a minute
  w.store.data.delete(leaseKey(ENDPOINT, SUB(3)))
  const writes = w.store.writes.length
  await w.clock.advance(10_000)
  await say($, agentId, 'two')
  await say($, agentId, 'three')
  expect(senders(w)).toEqual([ME, ME, ME])
  expect(w.store.writes.filter(x => POOL_SUFFIX.test(x.key))).toEqual([])
  expect(w.store.writes.length - writes).toBeLessThanOrEqual(2)
  expect(joinedIds(w)).toEqual([])

  await w.clock.advance(55_000)
  await say($, agentId, 'four')
  expect(senders(w).at(-1)).toBe(SUB(3))
  expect(joinedIds(w)).toEqual([SUB(3)])
  expect(table(w)[agentId]).toMatchObject({ handle: SUB(3) })
  expect(table(w)[agentId]?.sharesBase).toBeUndefined()
  expect(feed(w).filter(e => e.kind === 'handle')).toHaveLength(1)
})

test('a handle that cannot be joined is given back, the call goes through as the session, and the retry waits a minute', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  w.fake.script = call => (call.cmd === 'join' && idOf(call) === SUB(1) ? { exitCode: 4, stderr: 'Orchard agent: MCP tool "mail_register" returned an error: {"error":"nope"}\n' } : undefined)
  const agentId = await spawn($)

  expect((await say($, agentId, 'one')).result).toContain('Sent')
  expect(senders(w)).toEqual([ME])
  expect(leaseOf(w, 1)).toBeUndefined()
  expect(table(w)[agentId]).toMatchObject({ handle: ME, sharesBase: true })
  expect(feed(w).find(e => e.kind === 'handle')?.text).toBe("Shares this session's Orchard identity: its own handle could not be set up")

  await say($, agentId, 'two')
  await w.clock.advance(30_000)
  await say($, agentId, 'three')
  expect(joinedIds(w)).toEqual([SUB(1)])
  expect(senders(w)).toEqual([ME, ME, ME])

  // the workspace takes the join now; the next call after the minute gets the handle
  w.fake.script = undefined
  await w.clock.advance(31_000)
  await say($, agentId, 'four')
  expect(senders(w).at(-1)).toBe(SUB(1))
  expect(leaseOf(w, 1)?.session).toBe(mySession(w))
  expect(feed(w).filter(e => e.kind === 'handle')).toHaveLength(1)
})

test('a workspace that cannot be reached for the resume, and a store that keeps no lease, leave the call going as the session', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  w.fake.script = call => (call.cmd === 'resume' && idOf(call) === SUB(1) ? 'reject' : undefined)
  const a = await spawn($, 'A')
  expect((await say($, a, 'one')).result).toContain('Sent')
  expect(senders(w)).toEqual([ME])
  expect(leaseOf(w, 1)).toBeUndefined()

  w.fake.script = undefined
  w.store.fail.set = true
  const b = await spawn($, 'B')
  expect((await say($, b, 'two')).result).toContain('Sent')
  expect(senders(w)).toEqual([ME, ME])
  expect(joinedIds(w)).toEqual([])
  expect(table(w)[b]).toMatchObject({ handle: ME, sharesBase: true })
  // a store that keeps nothing is a handle that could not be set up, not a full pool
  expect(feed(w).find(e => e.kind === 'handle' && e.agentId === b)?.text).toBe("Shares this session's Orchard identity: its own handle could not be set up")
})

// ---- a subagent that joins Orchard by itself ----

const BIN = '/Applications/Orchard.app/Contents/MacOS/Orchard'
const bash = ($: Engine, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) } as never)

test('a participant a subagent joins as through the CLI is recorded as its handle, observed: nothing registered, leased or pinned', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: 'done' }) as never)
  w.fake.tasks = [{ id: 't1', title: 'Helper task', status: 'in_progress', assignee: 'claude-helper' }, { id: 't2', title: 'Other task', status: 'in_progress', assignee: 'claude-other' }]
  await begin($, w)
  const agentId = await spawn($, 'Helper')
  const calls = w.fake.calls.length

  const ran = await bash($, `${BIN} agent join --participant-id claude-helper --name 'Helper' --request-id r1`, agentId)
  expect((ran as { result?: string }).result).toBe('done')
  await w.clock.settle()
  expect(table(w)[agentId]).toMatchObject({ handle: 'claude-helper', observed: true })
  // the mod ran nothing for it: no join, no resume, no lease
  expect(w.fake.calls.length).toBe(calls)
  expect(joinedIds(w)).toEqual([])
  expect(leases(w)).toEqual([])

  // it is the session's now: its tasks are listed, its messages are not "others"
  await $.command.run(RUN(''))
  await w.clock.settle()
  expect(held(w).tasks.map(t => t.id)).toEqual(['t1'])
  w.fake.push({ id: 'h1', sender_id: 'claude-helper', body: 'hi all', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })
  w.fake.push({ id: 'o1', sender_id: 'claude-other', body: 'hi', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(1)

  // an Orchard tool call of the same agent still gets a pooled handle, and is pinned to that, not to the observed one
  await say($, agentId, 'via the tool')
  expect(senders(w)).toEqual([SUB(1)])
  expect(table(w)[agentId]).toMatchObject({ handle: SUB(1) })
  expect(table(w)[agentId]?.observed).toBeUndefined()
  expect(joinedIds(w)).toEqual([SUB(1)])
})

test('only a subagent\'s own Claude-style joins are recorded: not the main loop\'s, a human\'s, the owner\'s, a pooled id or another command', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: 'done' }) as never)
  await begin($, w)
  const agentId = await spawn($, 'Helper')

  await bash($, `${BIN} agent resume --participant-id claude-from-main`)
  await bash($, `${BIN} agent resume --participant-id owner`, agentId)
  await bash($, `${BIN} agent resume --participant-id alice`, agentId)
  await bash($, `${BIN} agent resume --participant-id ${SUB(2)}`, agentId)
  await bash($, `${BIN} agent resume --participant-id ${ME}`, agentId)
  await bash($, `${BIN} agent alerts --participant-id claude-not-a-join`, agentId)
  await bash($, 'ls -la', agentId)
  await w.clock.settle()
  expect(table(w)[agentId]?.handle).toBeUndefined()
  expect(table(w).main?.handle).toBe(ME)

  await bash($, `${BIN} agent resume --participant-id=claude-first`, agentId)
  await bash($, `${BIN} agent resume --participant-id=claude-second`, agentId)
  await w.clock.settle()
  expect(table(w)[agentId]).toMatchObject({ handle: 'claude-second', observed: true })
})

// ---- the session's own, for the filters ----

test('a pooled handle is the session\'s: the tasks it claimed are listed, its messages are not other people\'s, and both stop when it is given back', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  w.fake.tasks = [{ id: 't1', title: 'Fix the awning', assignee: null }, { id: 't2', title: 'Someone else\'s', status: 'in_progress', assignee: 'claude-other' }]
  const agentId = await spawn($, 'Builder')
  await callTool($, 'orchard_call', { name: 'task_claim', arguments: { store_id: 'store1', task_id: 't1' }, agentId })
  await w.clock.advance(2_000)
  expect(held(w).tasks.map(t => t.id)).toEqual(['t1'])

  const channelPost = (id: string, sender: string) =>
    w.fake.push({ id, sender_id: sender, body: 'hello', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })
  channelPost('c1', SUB(1))
  channelPost('c2', 'claude-other')
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(1)

  // it ends: the handle goes back; what it sent a moment ago is still the session's for a while, and its tasks no longer are
  const listed = w.agents.list.find(x => x.id === agentId)
  if (listed !== undefined) listed.status = 'completed'
  await turnEnds($, agentId)
  await w.clock.advance(2_000)
  expect(leaseOf(w, 1)).toBeUndefined()
  expect(held(w).tasks).toEqual([])
  channelPost('c3', SUB(1))
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(1)
  await w.clock.advance(3 * 60_000)
  channelPost('c4', SUB(1))
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(2)
})

const channelPost = (w: World, id: string, sender: string) =>
  w.fake.push({ id, sender_id: sender, body: 'hello', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })

test('a handle given back by a reconnect is still the session\'s for a while: a late message from it is not counted as another\'s', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const agentId = await spawn($, 'Builder')
  await say($, agentId, 'one')
  await $.command.run(RUN('reconnect'))
  await w.clock.settle()
  expect(leases(w)).toEqual([])

  channelPost(w, 'c1', SUB(1))
  channelPost(w, 'c2', 'claude-other')
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(1)
})

// ---- decisions a subagent's handle raised ----

for (const hasTool of [true, false]) {
  test(`a decision a subagent's handle raised is the session's: listed in the pane and counted in needs-you, from ${hasTool ? "the host's own list" : 'the history window'}`, { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    w.fake.hasDecisionsTool = hasTool
    await begin($, w)
    const a = await spawn($, 'Asker')
    await say($, a, 'one')
    const decision = (id: string, sender: string) =>
      w.fake.push({ id, sender_id: sender, kind: 'decision', body: `${id}?`, destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
    decision('dBase', ME)
    decision('dSub', SUB(1))
    decision('dElse', 'claude-other')
    decision('dOtherSub', 'claude-other.sub1')

    // the pane lists the session's and its subagent's, not another session's, and the count agrees
    await $.command.run(RUN(''))
    await w.clock.settle()
    expect(held(w).decisions.map(d => d.id).sort()).toEqual(['dBase', 'dSub'])
    expect(w.state.latest.counts).toMatchObject({ needsYou: 2 })

    // the owner answers the session's own: the count the listener keeps falls to the subagent's one
    // (the listener waits out the rest of a minute after a poll that came back early)
    await w.clock.advance(61_000)
    w.fake.push({ id: 'ans', sender_id: 'owner', thread_id: 'dBase', body: 'yes', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
    await w.clock.settle()
    expect(w.state.latest.counts).toMatchObject({ needsYou: 1 })
    await $.command.run(RUN(''))
    await w.clock.settle()
    expect(held(w).decisions.map(d => d.id)).toEqual(['dSub'])
  })
}

// ---- two agents, one session ----

test('two agents sending the same words after a lost connection are two requests: each keeps its own request id for the retry', { options: OPTIONS }, async ($, on) => {
  const w = await start($, on)
  const [a, b] = [await spawn($, 'A'), await spawn($, 'B')]
  await say($, a, 'warm up')
  await say($, b, 'warm up')
  const warm = w.fake.calls.filter(c => c.tool === 'mail_send').length
  let isDown = true
  w.fake.script = call => (call.tool === 'mail_send' && isDown ? 'reject' : undefined)

  expect((await say($, a, 'same words')).deny).toBe(RETRY_ADVICE)
  expect((await say($, b, 'same words')).deny).toBe(RETRY_ADVICE)
  isDown = false
  await say($, a, 'same words')
  await say($, b, 'same words')

  const ids = w.fake.calls.filter(c => c.tool === 'mail_send').slice(warm).map(c => (JSON.parse(c.stdin ?? '{}') as { request_id?: string }).request_id)
  const [aFirst, bFirst, aRetry, bRetry] = ids
  expect(ids).toHaveLength(4)
  expect(aFirst).not.toBe(bFirst)
  expect(aRetry).toBe(aFirst)
  expect(bRetry).toBe(bFirst)
  expect(w.fake.sent.slice(-2).map(m => m.sender_id)).toEqual([SUB(1), SUB(2)])
})
