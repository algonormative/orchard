// The participants a session's agents are seen acting as, and whether Orchard has them signed on: the participants a Bash
// command signs on as through the Orchard CLI (seen once it has run and succeeded), the mod's tools acting as the session's
// own participant, and the sign-on state read from the participant list. The mod creates nothing for an agent. Against the
// fake workspace and the mock clock.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ENDPOINT, ME, OPTIONS } from './fake-orchard'
import { newlyEnded, withHandles } from './feed'
import { MAX_OBSERVED, createBook, hasObserved, observe, observedAs, ownHandles, shownBy, signOnOf, succeeded, useTools } from './handles'
import { leaseKey } from './lease'
import { begin, callTool, world } from './test-world'
import type { World } from './test-world'
import { RETRY_ADVICE } from './tools'
import type { OrchardActivityEntry, OrchardAgents, OrchardPlugins, OrchardWorkspaceActivity } from '../types'

const BIN = '/Applications/Orchard.app/Contents/MacOS/Orchard'
const RUN = (args: string) => ({ command: 'orchard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } })

const feed = (w: World) => (w.state.latest.activity ?? []) as OrchardActivityEntry[]
const table = (w: World) => (w.state.latest.agents ?? {}) as OrchardAgents
const around = (w: World) => w.state.latest.workspaceActivity as OrchardWorkspaceActivity
const held = (w: World) => w.state.latest.plugins as OrchardPlugins
const calls = (w: World, tool: string) => w.fake.calls.filter(c => c.tool === tool)
const participantReads = (w: World) => calls(w, 'mail_participants').length
const entering = (w: World) => w.fake.calls.filter(c => c.cmd === 'join' || c.cmd === 'resume').length
const leaseKeys = (w: World) => [...w.store.data.keys()].filter(k => k.startsWith('lease '))

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
const bash = ($: Engine, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) } as never)
const end = (w: World, agentId: string) => {
  const listed = w.agents.list.find(a => a.id === agentId)
  if (listed !== undefined) listed.status = 'completed'
}

const SUCCESS = { result: { stdout: '', stderr: '', interrupted: false } }

/** The engine's Bash tool beneath the plugin: which commands ran, and how each one ends. `hold` keeps a command running until it resolves. */
function shell(on: Parameters<typeof world>[0]) {
  const sh = { ran: [] as string[], ends: (_command: string): unknown => SUCCESS, hold: undefined as Promise<void> | undefined }
  on('tool.call', { tool: 'Bash' }, async (_$, e) => {
    sh.ran.push(e.command)
    await sh.hold
    return sh.ends(e.command) as never
  })
  return sh
}

/** What an agent's own `Orchard agent join` leaves in the workspace: a registered participant. */
function signOn(w: World, id: string, name = id) {
  w.fake.registered.add(id)
  w.fake.participants.push({ id, name })
}

const channelPost = (w: World, id: string, sender: string) =>
  w.fake.push({ id, sender_id: sender, body: 'hello', destination: { kind: 'channel', id: 'general' }, recipient_ids: [] }, { reasons: ['channel'], channel: { id: 'general', name: 'general' } })

// ---- reading a Bash command ----

test('observedAs finds the participants a command signs on or acts as through the Orchard CLI', () => {
  expect(observedAs(`${BIN} agent join --participant-id claude-helper --name 'Helper' --request-id r1`)).toEqual(['claude-helper'])
  expect(observedAs(`${BIN} agent resume --participant-id=claude-helper`)).toEqual(['claude-helper'])
  expect(observedAs(`${BIN} agent alerts --participant-id claude-helper --after 0 --wait 30`)).toEqual(['claude-helper'])
  expect(observedAs(`${BIN} agent ack --participant-id claude-helper --message-id m1 --request-id r2`)).toEqual(['claude-helper'])
  expect(observedAs(`${BIN} agent call mail_history --participant-id claude-helper`)).toEqual(['claude-helper'])
  expect(observedAs(`"${BIN}" agent --endpoint "$E" --credential-file "$C" resume --participant-id "claude-helper"`)).toEqual(['claude-helper'])
  expect(observedAs(`cd /tmp && ${BIN} agent join \\\n  --name Helper \\\n  --participant-id claude-helper.v2 --request-id r1 | jq .`)).toEqual(['claude-helper.v2'])
  expect(observedAs(`export ORCHARD_AGENT_ENDPOINT=x; orchard agent resume --participant-id claude-lower`)).toEqual(['claude-lower'])
  expect(observedAs(`ORCHARD_AGENT_ENDPOINT=x ORCHARD_AGENT_CREDENTIAL_FILE=y env ${BIN} agent resume --participant-id claude-env`)).toEqual(['claude-env'])
  expect(observedAs(`id=$(${BIN} agent join --participant-id claude-sub --name S --request-id r1)`)).toEqual(['claude-sub'])
  // each distinct participant once, in the order they come
  expect(observedAs(`${BIN} agent join --participant-id claude-a --name A --request-id r1 && ${BIN} agent resume --participant-id claude-b; ${BIN} agent ack --participant-id claude-a --message-id m`)).toEqual([
    'claude-a',
    'claude-b',
  ])
})

test('observedAs reads only a command that is the Orchard program: text that mentions it, other commands, variables and long ids are not', () => {
  // the words inside another command's arguments
  expect(observedAs(`echo "${BIN} agent join --participant-id claude-x"`)).toEqual([])
  expect(observedAs(`printf '%s' 'orchard agent resume --participant-id claude-x'`)).toEqual([])
  expect(observedAs(`git commit -m "run Orchard agent join --participant-id claude-x"`)).toEqual([])
  expect(observedAs(`${BIN} agent send --sender-id claude-helper --channel general --body 'please join --participant-id claude-x'`)).toEqual([])
  expect(observedAs(`grep -r "Orchard agent join --participant-id claude-x" .`)).toEqual([])
  // other subcommands, other programs, a variable, an id past the limit, a flag of another command
  expect(observedAs(`${BIN} agent tools; echo resume --participant-id claude-x`)).toEqual([])
  expect(observedAs(`${BIN} agent send --participant-id claude-helper --body hi`)).toEqual([])
  expect(observedAs(`${BIN} agent join --participant-id "$ID" --name X`)).toEqual([])
  expect(observedAs(`${BIN} agent join --participant-id ${'a'.repeat(129)}`)).toEqual([])
  expect(observedAs(`${BIN}x agent join --participant-id claude-x`)).toEqual([])
  expect(observedAs(`${BIN} --participant-id claude-x`)).toEqual([])
  expect(observedAs('ls -la')).toEqual([])
  expect(observedAs('')).toEqual([])
})

test('succeeded: a Bash call counts once it answered, reported no error, was not interrupted and is not still running in the background', () => {
  expect(succeeded(SUCCESS)).toBe(true)
  expect(succeeded({ result: 'done' })).toBe(true)
  expect(succeeded({ result: undefined })).toBe(true)
  expect(succeeded({ deny: 'a hook refused the command' })).toBe(false)
  expect(succeeded({ isError: true, result: 'Exit code 1' })).toBe(false)
  expect(succeeded({ result: { stdout: '', stderr: '', interrupted: true } })).toBe(false)
  expect(succeeded({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } })).toBe(false)
})

// ---- the book ----

test('the book keeps what each agent was seen acting as; only Claude-style ids are taken, and the session\'s own is the tools\'', () => {
  const book = createBook()
  expect(ownHandles(ME, book)).toEqual([ME])
  expect(observe(book, 'a1', 'claude-helper', ME)).toBe(true)
  expect(observe(book, 'a1', 'claude-helper', ME)).toBe(false)
  expect(observe(book, 'a2', 'claude-other-helper', ME)).toBe(true)
  // a human's, the owner's and the system's are no one of this session's, in any case
  for (const id of ['owner', 'Owner', 'orchard', 'ORCHARD', 'alice', 'claude']) expect(observe(book, 'a1', id, ME)).toBe(false)
  expect(ownHandles(ME, book)).toEqual([ME, 'claude-helper', 'claude-other-helper'])

  // the session's own participant is what the mod's tools act as
  expect(observe(book, 'a3', ME, ME)).toBe(true)
  expect(observe(book, 'a3', ME, ME)).toBe(false)
  expect(useTools(book, 'a3')).toBe(false)
  expect(useTools(book, 'a4')).toBe(true)
  expect(shownBy(ME, book)).toEqual(
    new Map([
      ['a1', { handle: 'claude-helper', observed: true }],
      ['a2', { handle: 'claude-other-helper', observed: true }],
      ['a3', { handle: ME, sharesBase: true }],
      ['a4', { handle: ME, sharesBase: true }],
    ]),
  )
  expect(hasObserved(book, 'a1')).toBe(true)
  expect(hasObserved(book, 'a3')).toBe(false)
  expect(hasObserved(book, 'nobody')).toBe(false)

  // the latest wins, and an agent that signed on as itself is shown as that even if it also used the tools; the oldest are forgotten
  for (let i = 0; i < MAX_OBSERVED + 2; i += 1) observe(book, 'a5', `claude-n${i}`, ME)
  useTools(book, 'a5')
  expect(shownBy(ME, book).get('a5')).toEqual({ handle: `claude-n${MAX_OBSERVED + 1}`, observed: true })
  expect(ownHandles(ME, book).filter(id => id.startsWith('claude-n'))).toEqual([2, 3, 4, 5].map(i => `claude-n${i}`))
})

test('signOnOf reads the participant list: signed on or not, and the last contact, for the participants asked about', () => {
  const list = {
    participants: [
      { id: ME, name: 'Me', registered: true, last_contact_at: '2026-10-12T10:00:00Z' },
      { id: 'claude-gone', name: 'Gone', registered: false, last_contact_at: 'not a date' },
      { id: 'claude-new', name: 'New', registered: true },
      { id: 'claude-odd', name: 'Odd' },
      { id: 'owner', name: 'Nick', registered: true },
    ],
  }
  const known = signOnOf(list, [ME, 'claude-gone', 'claude-new', 'claude-odd', 'claude-absent'])
  expect(known).toEqual(
    new Map([
      [ME, { registered: true, lastContactAt: Date.parse('2026-10-12T10:00:00Z') }],
      ['claude-gone', { registered: false }],
      ['claude-new', { registered: true }],
    ]),
  )
  expect(signOnOf({ participants: [] }, [ME])).toEqual(new Map())
  expect(signOnOf({}, [ME])).toBeUndefined()
  expect(signOnOf(undefined, [ME])).toBeUndefined()
})

test('the table takes each agent\'s handle and Orchard\'s word on it from the book; an agent seen doing neither has none', () => {
  const agent = (agentId: string, extra: Record<string, unknown> = {}) => ({ agentId, description: agentId, type: 'Explore', status: 'running', startedAt: 1, ...extra })
  const before = {
    main: agent('main', { type: 'main', handle: ME, lastAction: 'Sent to Nick' }),
    a1: agent('a1', { handle: 'claude-stale', observed: true, signedOn: true, lastContactAt: 5 }),
    a2: agent('a2'),
    a3: agent('a3'),
  } as OrchardAgents
  const acts = new Map([
    ['a2', { handle: 'claude-helper', observed: true as const }],
    ['a3', { handle: ME, sharesBase: true as const }],
  ])
  const signOnBy = new Map([
    [ME, { registered: true, lastContactAt: 9 }],
    ['claude-helper', { registered: false }],
  ])
  const after = withHandles(before, acts, signOnBy)
  expect(after.main).toMatchObject({ handle: ME, signedOn: true, lastContactAt: 9, lastAction: 'Sent to Nick' })
  expect(after.a1?.handle).toBeUndefined()
  expect(after.a1?.signedOn).toBeUndefined()
  expect(after.a1?.lastContactAt).toBeUndefined()
  expect(after.a2).toMatchObject({ handle: 'claude-helper', observed: true, signedOn: false })
  expect(after.a2?.lastContactAt).toBeUndefined()
  expect(after.a3).toMatchObject({ handle: ME, sharesBase: true, signedOn: true })
  expect(after.a3?.observed).toBeUndefined()
  // no word on a participant: unknown, not "signed off"
  expect(withHandles(before, acts, new Map()).a2?.signedOn).toBeUndefined()
})

test('newlyEnded names the subagents that ended between two looks, one the first did not hold included, and never the main loop', () => {
  const agent = (agentId: string, status: string) => ({ agentId, description: '', type: '', status, startedAt: 1 })
  const before = { main: agent('main', 'idle'), a1: agent('a1', 'running'), a2: agent('a2', 'completed'), a3: agent('a3', 'waiting') } as OrchardAgents
  const after = { main: agent('main', 'completed'), a1: agent('a1', 'completed'), a2: agent('a2', 'completed'), a3: agent('a3', 'running'), a4: agent('a4', 'killed') } as OrchardAgents
  expect(newlyEnded(before, after)).toEqual(['a1', 'a4'])
})

// ---- a subagent that signs on through the CLI ----

test('a participant an agent signs on as through the CLI is its handle once the command has succeeded, and the mod creates nothing for it', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  const sh = shell(on)
  await begin($, w)
  const agentId = await spawn($, 'Helper')
  const entered = entering(w)
  const leases = leaseKeys(w)
  const keys = [...w.store.data.keys()]

  // the command is still running: nothing is known yet
  let finish = () => {}
  sh.hold = new Promise<void>(resolve => (finish = resolve))
  const running = bash($, `${BIN} agent join --participant-id claude-helper --name 'Helper' --request-id r1`, agentId)
  await w.clock.settle()
  expect(sh.ran).toHaveLength(1)
  expect(table(w)[agentId]?.handle).toBeUndefined()

  finish()
  const answer = (await running) as { result?: unknown }
  await w.clock.settle()
  // the command ran once, as the model wrote it, and its answer reached the model untouched
  expect(sh.ran).toEqual([`${BIN} agent join --participant-id claude-helper --name 'Helper' --request-id r1`])
  expect(answer.result).toEqual(SUCCESS.result)
  expect(table(w)[agentId]).toMatchObject({ handle: 'claude-helper', observed: true })
  expect(table(w)[agentId]?.sharesBase).toBeUndefined()
  // no join, resume, lease or store key made for it
  expect(entering(w)).toBe(entered)
  expect(leaseKeys(w)).toEqual(leases)
  expect([...w.store.data.keys()]).toEqual(keys)

  // the handle stays when the agent ends and the table forgets it
  end(w, agentId)
  await turnEnds($, agentId)
  await w.clock.advance(3 * 60_000)
  expect(table(w)[agentId]).toBeUndefined()
  expect(leaseKeys(w)).toEqual(leases)
})

test('a command that failed, was refused, was interrupted or went to the background records nothing; the same command that succeeded does', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  const sh = shell(on)
  await begin($, w)
  const agentId = await spawn($, 'Helper')
  const join = (id: string) => `${BIN} agent join --participant-id ${id} --name X --request-id r1`

  const endings: [string, unknown][] = [
    ['claude-failed', { isError: true, result: 'Exit code 4\nOrchard agent: tool error', text: 'Exit code 4' }],
    ['claude-refused', { deny: 'the user refused the command' }],
    ['claude-interrupted', { result: { stdout: '', stderr: '', interrupted: true } }],
    ['claude-background', { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg1' } }],
  ]
  for (const [id, ending] of endings) {
    sh.ends = () => ending
    await bash($, join(id), agentId)
  }
  await w.clock.settle()
  expect(sh.ran).toHaveLength(endings.length)
  expect(table(w)[agentId]?.handle).toBeUndefined()
  expect(around(w).recentFromOthers).toBe(0)

  sh.ends = () => SUCCESS
  await bash($, join('claude-ok'), agentId)
  await w.clock.settle()
  expect(table(w)[agentId]).toMatchObject({ handle: 'claude-ok', observed: true })
})

test('text that only mentions the command, and commands that are not the Orchard program, record nothing even when they succeed', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  await begin($, w)
  const agentId = await spawn($, 'Helper')

  for (const command of [
    `echo "${BIN} agent join --participant-id claude-spoof"`,
    `echo 'Orchard agent resume --participant-id claude-spoof' | tee notes.txt`,
    `${BIN} agent send --sender-id claude-helper --channel general --body 'join --participant-id claude-spoof' --request-id r1`,
    `${BIN} agent alerts --participant-id "$ID"`,
    'ls -la',
  ]) {
    await bash($, command, agentId)
  }
  await w.clock.settle()
  expect(table(w)[agentId]?.handle).toBeUndefined()
  expect(table(w).main?.handle).toBe(ME)
})

test('only Claude-style ids are taken: a human\'s, the owner\'s and the system\'s are not; the session\'s own is the tools\' participant', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  await begin($, w)
  const agentId = await spawn($, 'Helper')

  for (const id of ['owner', 'alice', 'orchard', 'Owner']) await bash($, `${BIN} agent resume --participant-id ${id}`, agentId)
  await w.clock.settle()
  expect(table(w)[agentId]?.handle).toBeUndefined()

  await bash($, `${BIN} agent resume --participant-id=claude-first`, agentId)
  await bash($, `${BIN} agent resume --participant-id=claude-second`, agentId)
  await w.clock.settle()
  expect(table(w)[agentId]).toMatchObject({ handle: 'claude-second', observed: true })

  // acting as the session's own participant through the CLI is acting as the participant the tools use
  const other = await spawn($, 'Other')
  await bash($, `${BIN} agent resume --participant-id ${ME}`, other)
  await w.clock.settle()
  expect(table(w)[other]).toMatchObject({ handle: ME, sharesBase: true })
  expect(table(w)[other]?.observed).toBeUndefined()
})

test('the main loop is an agent too: what it signs on as is the session\'s, and its row stays the session\'s own participant', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  w.fake.tasks = [{ id: 't1', title: 'Main\'s other hat', status: 'in_progress', assignee: 'claude-main-aux' }]
  await begin($, w)
  signOn(w, 'claude-main-aux')

  await bash($, `${BIN} agent join --participant-id claude-main-aux --name Aux --request-id r1`)
  await $.command.run(RUN(''))
  await w.clock.settle()
  expect(held(w).tasks.map(t => t.id)).toEqual(['t1'])
  expect(table(w).main).toMatchObject({ handle: ME, signedOn: true })
  expect(table(w).main?.observed).toBeUndefined()
})

// ---- the session's own, for the filters ----

test('an observed handle is the session\'s: its tasks, roles, state markers and decisions are listed, and its messages are not other people\'s', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  w.fake.plugins = w.fake.plugins.map(p => ({ ...p, attached: true }))
  w.fake.tasks = [
    { id: 't1', title: 'Helper task', status: 'in_progress', assignee: 'claude-helper' },
    { id: 't2', title: 'Other task', status: 'in_progress', assignee: 'claude-other' },
  ]
  w.fake.declarations = [
    { participant_id: 'claude-helper', roles: ['builder'] },
    { participant_id: 'claude-other', roles: ['qa'] },
  ]
  w.fake.markers = [
    { id: 's1', title: 'Helper marker', state: 'todo', created_by: 'claude-helper', subject: { kind: 'file', root_id: 'r' } },
    { id: 's2', title: 'Other marker', state: 'todo', created_by: 'claude-other', subject: { kind: 'file', root_id: 'r' } },
  ]
  w.fake.hasDecisionsTool = true
  w.fake.push({ id: 'dHelper', sender_id: 'claude-helper', kind: 'decision', body: 'ship it?', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
  w.fake.push({ id: 'dOther', sender_id: 'claude-other', kind: 'decision', body: 'not mine', destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
  await begin($, w)
  signOn(w, 'claude-helper')

  // before it is seen, the helper's work is someone else's
  expect(held(w).tasks).toEqual([])
  expect(held(w).decisions).toEqual([])
  channelPost(w, 'c0', 'claude-helper')
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(1)

  const agentId = await spawn($, 'Helper')
  await bash($, `${BIN} agent join --participant-id claude-helper --name Helper --request-id r1`, agentId)
  // the new participant asks for the workspace to be read again a second later
  await w.clock.advance(1_100)
  expect(held(w).tasks.map(t => t.id)).toEqual(['t1'])
  expect(held(w).roles).toEqual([{ participantId: 'claude-helper', roles: ['builder'] }])
  expect(held(w).states.map(s => s.id)).toEqual(['s1'])
  expect(held(w).decisions.map(d => d.id)).toEqual(['dHelper'])
  expect(w.state.latest.counts).toMatchObject({ needsYou: 1 })

  // its messages from now on are the session's, another participant's still count
  channelPost(w, 'c1', 'claude-helper')
  channelPost(w, 'c2', 'claude-other')
  await w.clock.settle()
  expect(around(w).recentFromOthers).toBe(2)
})

for (const hasTool of [true, false]) {
  test(`a decision an observed handle raised is the session's: listed in the pane and counted in needs-you, from ${hasTool ? "the host's own list" : 'the history window'}`, { options: OPTIONS }, async ($, on) => {
    const w = world(on)
    shell(on)
    w.fake.hasDecisionsTool = hasTool
    await begin($, w)
    const a = await spawn($, 'Asker')
    await bash($, `${BIN} agent join --participant-id claude-asker --name Asker --request-id r1`, a)
    const decision = (id: string, sender: string) =>
      w.fake.push({ id, sender_id: sender, kind: 'decision', body: `${id}?`, destination: { kind: 'direct', id: 'owner' }, recipient_ids: ['owner'] })
    decision('dBase', ME)
    decision('dAsker', 'claude-asker')
    decision('dElse', 'claude-other')
    decision('dOtherHelper', 'claude-other-helper')

    // the pane lists the session's and its subagent's, not another session's, and the count agrees
    await $.command.run(RUN(''))
    await w.clock.settle()
    expect(held(w).decisions.map(d => d.id).sort()).toEqual(['dAsker', 'dBase'])
    expect(w.state.latest.counts).toMatchObject({ needsYou: 2 })
    // one read of the host's list for every handle, not one per handle
    if (hasTool) expect(calls(w, 'workspace_decisions').every(c => c.stdin === '{}')).toBe(true)

    // the owner answers the session's own: the count the listener keeps falls to the subagent's one
    // (the listener waits out the rest of a minute after a poll that came back early)
    await w.clock.advance(61_000)
    w.fake.push({ id: 'ans', sender_id: 'owner', thread_id: 'dBase', body: 'yes', destination: { kind: 'direct', id: ME }, recipient_ids: [ME] }, { reasons: ['direct'] })
    await w.clock.settle()
    expect(w.state.latest.counts).toMatchObject({ needsYou: 1 })
    await $.command.run(RUN(''))
    await w.clock.settle()
    expect(held(w).decisions.map(d => d.id)).toEqual(['dAsker'])
  })
}

// ---- what Orchard says: signed on or not ----

test('each refresh reads the participant list once and sets signedOn per handle: signed on, signed off, or not known', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  await begin($, w)
  signOn(w, 'claude-helper')
  signOn(w, 'claude-fresh')
  w.fake.lastContact['claude-helper'] = '2026-10-12T10:00:00Z'
  const [a, b, c] = [await spawn($, 'Helper'), await spawn($, 'Fresh'), await spawn($, 'Silent')]
  await bash($, `${BIN} agent join --participant-id claude-helper --name Helper --request-id r1`, a)
  await bash($, `${BIN} agent join --participant-id claude-fresh --name Fresh --request-id r2`, b)
  // a participant the list does not carry at all
  await bash($, `${BIN} agent alerts --participant-id claude-nowhere --after 0`, c)

  const reads = participantReads(w)
  await $.command.run(RUN(''))
  await w.clock.settle()
  expect(participantReads(w)).toBe(reads + 1)
  expect(table(w).main).toMatchObject({ handle: ME, signedOn: true })
  expect(table(w)[a]).toMatchObject({ handle: 'claude-helper', observed: true, signedOn: true, lastContactAt: Date.parse('2026-10-12T10:00:00Z') })
  expect(table(w)[b]).toMatchObject({ handle: 'claude-fresh', signedOn: true })
  expect(table(w)[b]?.lastContactAt).toBeUndefined()
  expect(table(w)[c]).toMatchObject({ handle: 'claude-nowhere', observed: true })
  expect(table(w)[c]?.signedOn).toBeUndefined()

  // it signs off by itself; the next refresh says so
  w.fake.registered.delete('claude-helper')
  await $.command.run(RUN(''))
  await w.clock.settle()
  expect(participantReads(w)).toBe(reads + 2)
  expect(table(w)[a]?.signedOn).toBe(false)
  expect(table(w)[b]?.signedOn).toBe(true)

  // a participant list that cannot be read keeps what was known
  w.fake.script = call => (call.tool === 'mail_participants' ? { exitCode: 4, stderr: 'Orchard agent: tool error\n' } : undefined)
  await $.command.run(RUN(''))
  await w.clock.settle()
  expect(table(w)[a]?.signedOn).toBe(false)
  expect(table(w)[b]?.signedOn).toBe(true)
})

test('an agent that ended while still signed on shows it did not sign off; one that left shows it did; the list is read once, a second later', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  await begin($, w)
  signOn(w, 'claude-stays')
  signOn(w, 'claude-leaves')
  const [stays, leaves, plain] = [await spawn($, 'Stays'), await spawn($, 'Leaves'), await spawn($, 'Plain')]
  await bash($, `${BIN} agent join --participant-id claude-stays --name Stays --request-id r1`, stays)
  await bash($, `${BIN} agent join --participant-id claude-leaves --name Leaves --request-id r2`, leaves)
  await w.clock.advance(1_100)
  expect(table(w)[stays]).toMatchObject({ status: 'running', signedOn: true })
  expect(table(w)[leaves]).toMatchObject({ status: 'running', signedOn: true })

  // one of them signs off, then all three end
  w.fake.registered.delete('claude-leaves')
  const reads = participantReads(w)
  for (const id of [stays, leaves, plain]) end(w, id)
  await turnEnds($, stays)
  await w.clock.advance(500)
  expect(table(w)[stays]?.status).toBe('completed')
  expect(participantReads(w)).toBe(reads)
  await w.clock.advance(700)
  expect(participantReads(w)).toBe(reads + 1)
  expect(table(w)[stays]).toMatchObject({ status: 'completed', handle: 'claude-stays', signedOn: true })
  expect(table(w)[leaves]).toMatchObject({ status: 'completed', handle: 'claude-leaves', signedOn: false })
  expect(table(w)[plain]).toMatchObject({ status: 'completed' })
  expect(table(w)[plain]?.handle).toBeUndefined()

  // an agent that never signed on needs no look at the list when it ends
  const quiet = await spawn($, 'Quiet')
  await w.clock.advance(5_000)
  const after = participantReads(w)
  end(w, quiet)
  await turnEnds($, quiet)
  await w.clock.advance(5_000)
  expect(table(w)[quiet]?.status).toBe('completed')
  expect(participantReads(w)).toBe(after)
})

test('the mod keeps no lease and no timer for an agent: nothing but the session\'s own lease sits in the store, however long the agents run', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  await begin($, w)
  signOn(w, 'claude-helper')
  const [a, b] = [await spawn($, 'Helper'), await spawn($, 'Talker')]
  await bash($, `${BIN} agent join --participant-id claude-helper --name Helper --request-id r1`, a)
  await say($, b, 'one')
  const writes = w.store.writes.length

  await w.clock.advance(20 * 60_000)
  expect(leaseKeys(w)).toEqual([leaseKey(ENDPOINT, ME)])
  expect(entering(w)).toBe(1)
  // the writes since are the session's own heartbeat and its place in the stream
  expect(w.store.writes.slice(writes).every(x => !/\.sub\d/.test(x.key))).toBe(true)
  expect(table(w)[a]).toMatchObject({ status: 'running', handle: 'claude-helper' })
})

// ---- the mod's tools ----

test('a subagent that uses the mod\'s tools acts as the session\'s participant, and the table says it shares it', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const entered = entering(w)
  const [a, b] = [await spawn($, 'Builder'), await spawn($, 'Reader')]

  expect((await say($, a, 'from a subagent')).deny).toBeUndefined()
  await say($, undefined, 'from the main loop')
  await callTool($, 'orchard_call', { name: 'mail_send', arguments: { destination: { kind: 'broadcast' }, body: 'via call' }, agentId: a })
  expect(w.fake.sent.map(m => m.sender_id)).toEqual([ME, ME, ME])
  expect(table(w)[a]).toMatchObject({ handle: ME, sharesBase: true })
  expect(table(w)[a]?.observed).toBeUndefined()
  // a read is a use of the session's participant too
  await callTool($, 'orchard_history', { agentId: b })
  await w.clock.settle()
  expect(table(w)[b]).toMatchObject({ handle: ME, sharesBase: true })
  // the main loop's row is the session's own participant, not a "shares"
  expect(table(w).main).toMatchObject({ handle: ME })
  expect(table(w).main?.sharesBase).toBeUndefined()

  // the feed names the agent and the participant it acted as
  expect(feed(w).filter(e => e.direction === 'out').map(e => [e.agentId, e.handle])).toEqual([[a, ME], ['main', ME], [a, ME]])
  // and the mod made nothing for it
  expect(entering(w)).toBe(entered)
  expect(leaseKeys(w)).toHaveLength(1)
})

test('a call the mod refused does not make its agent a user of the session\'s participant', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const a = await spawn($, 'Builder')
  expect((await callTool($, 'orchard_send', { body: '', direct: 'owner', agentId: a })).deny).toContain('body is required')
  expect(table(w)[a]?.handle).toBeUndefined()
})

test('an agent that signed on as itself keeps showing that when it also uses the tools; its calls still act as the session\'s participant', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  shell(on)
  await begin($, w)
  const a = await spawn($, 'Both')
  await bash($, `${BIN} agent join --participant-id claude-both --name Both --request-id r1`, a)
  await say($, a, 'via the tool')
  expect(w.fake.sent.map(m => m.sender_id)).toEqual([ME])
  expect(table(w)[a]).toMatchObject({ handle: 'claude-both', observed: true })
  expect(table(w)[a]?.sharesBase).toBeUndefined()
})

// ---- two agents, one session ----

test('two agents sending the same words after a lost connection are two requests: each keeps its own request id for the retry', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  const [a, b] = [await spawn($, 'A'), await spawn($, 'B')]
  await say($, a, 'warm up')
  await say($, b, 'warm up')
  const warm = calls(w, 'mail_send').length
  let isDown = true
  w.fake.script = call => (call.tool === 'mail_send' && isDown ? 'reject' : undefined)

  expect((await say($, a, 'same words')).deny).toBe(RETRY_ADVICE)
  expect((await say($, b, 'same words')).deny).toBe(RETRY_ADVICE)
  isDown = false
  await say($, a, 'same words')
  await say($, b, 'same words')

  const ids = calls(w, 'mail_send').slice(warm).map(c => (JSON.parse(c.stdin ?? '{}') as { request_id?: string }).request_id)
  const [aFirst, bFirst, aRetry, bRetry] = ids
  expect(ids).toHaveLength(4)
  expect(aFirst).not.toBe(bFirst)
  expect(aRetry).toBe(aFirst)
  expect(bRetry).toBe(bFirst)
  expect(w.fake.sent.slice(-2).map(m => m.sender_id)).toEqual([ME, ME])
})
