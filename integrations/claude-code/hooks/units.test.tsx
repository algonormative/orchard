import { expect, test } from 'claude-code/testing'

import { bandLine } from './band'
import { agentColor, agentState, handlingText, howOf, nowOf, shortHandle } from './feed'
import { storeKey } from './alerts'
import { settingsKey } from './classify'
import { planEviction } from './lease'
import { statusLine } from './statusline'
import type { BandInput } from './band'
import type { OrchardAgent } from '../types'
import { checkConn, connectedKey, defaultName, defaultParticipantId, parseProjectFile, readOptions, resolveIdentity, sessionSid } from './config'
import { BACKOFF_MAX_MS, backoffDelay, parseWorkspace } from './connect'
import { CLI_TIMEOUT_MS, DEFAULT_BIN, runOrchard, sanitizeMessage } from './orchard-cli'
import type { Conn, Run } from './orchard-cli'

const CONN: Conn = {
  bin: '/opt/fake/Orchard',
  endpoint: 'http://127.0.0.1:4312/workspaces/ws_0123456789abcdef/mcp',
  credentialFile: '/Users/tester/.secrets/orchard-credential-7f3a',
}

test('sanitizeMessage unwraps the CLI error and keeps the sentence', () => {
  expect(
    sanitizeMessage('Orchard agent: MCP tool "mail_send" returned an error: {"error":"not found: channel general"}\n'),
  ).toBe('not found: channel general')
  expect(
    sanitizeMessage('Orchard agent: MCP tool "x" returned an error: [{"type":"text","text":"invalid request: body is empty"}]'),
  ).toBe('invalid request: body is empty')
  expect(sanitizeMessage('Orchard agent: MCP tool "x" returned an error: "plain words"')).toBe('plain words')
  expect(sanitizeMessage('Orchard agent: invalid usage')).toBe('invalid usage')
  expect(sanitizeMessage('')).toBe('the workspace reported an error')
})

test('sanitizeMessage strips the credential path, endpoint, request ids, ids and paths', () => {
  const raw =
    `Orchard agent: cannot open ${CONN.credentialFile} via ${CONN.endpoint}; ` +
    'request_id conflict for orchard-join-9f2c41aa-77e0-4c1d-9b0e-0123456789ab; ' +
    'message m_00000000000000000042 in ws_0123456789abcdef; also ~/.orchard/state and ./relative/dir and /tmp/x'
  const out = sanitizeMessage(raw, [CONN.credentialFile, CONN.endpoint, 'orchard-join-9f2c41aa-77e0-4c1d-9b0e-0123456789ab'])
  expect(out).toContain('request_id conflict for')
  for (const leaked of ['Users', 'secrets', 'credential-7f3a', '127.0.0.1', 'orchard-join', '9f2c41aa', 'm_0000', 'ws_0123', '.orchard', 'relative', '/tmp']) {
    expect(out.includes(leaked)).toBe(false)
  }
  expect(out.includes('/')).toBe(false)
})

test('sanitizeMessage removes a path with a space in it, whole', () => {
  const out = sanitizeMessage('disk error at /Users/tester/Library/Application Support/Orchard/ws/mail while reading')
  expect(out).toBe('disk error at <path> while reading')
})

test('sanitizeMessage keeps ordinary words and cuts long lines', () => {
  expect(sanitizeMessage('not found: registered participant')).toBe('not found: registered participant')
  const long = sanitizeMessage(`error: ${'word '.repeat(60)}`)
  expect(long.length).toBeLessThanOrEqual(100)
  expect(long.endsWith('…')).toBe(true)
})

test('the backoff doubles from 5 s to a 5 min cap', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 40].map(n => backoffDelay(n) / 1000)).toEqual([5, 10, 20, 40, 80, 160, 300, 300, 300])
  expect(backoffDelay(0)).toBe(5_000)
  expect(backoffDelay(10_000)).toBe(BACKOFF_MAX_MS)
})

test('options: blanks are unset, the binary defaults to the app', () => {
  const none = readOptions({})
  expect(none).toEqual({ bin: DEFAULT_BIN, endpoint: '', credentialFile: '', participantId: '', name: '', autoConnect: false })
  expect(readOptions({ endpoint: '  http://127.0.0.1:1/workspaces/a/mcp ', orchardBin: '  ' }).endpoint).toBe('http://127.0.0.1:1/workspaces/a/mcp')
  expect(readOptions({ orchardBin: '  ' }).bin).toBe(DEFAULT_BIN)
})

test('checkConn wants an absolute credential path and never echoes it', () => {
  const base = readOptions({ endpoint: CONN.endpoint })
  expect(checkConn(base)).toEqual({ ok: false, message: 'credentialFile is not set' })
  const relative = checkConn({ ...base, credentialFile: 'secret/file' })
  expect(relative).toEqual({ ok: false, message: 'credentialFile must be an absolute path' })
  expect(checkConn({ ...base, credentialFile: CONN.credentialFile })).toEqual({
    ok: true,
    value: { bin: DEFAULT_BIN, endpoint: CONN.endpoint, credentialFile: CONN.credentialFile },
  })
})

test('the default participant id is claude- plus a safe slug of the folder name', () => {
  expect(defaultParticipantId('/work/Fruit Stand')).toBe('claude-fruit-stand')
  expect(defaultParticipantId('/work/vault/')).toBe('claude-vault')
  expect(defaultParticipantId('/work/.hidden')).toBe('claude-hidden')
  expect(defaultParticipantId('/work/My_App.v2')).toBe('claude-my_app.v2')
  expect(defaultParticipantId('/work/ü☃')).toBe('claude-session')
  expect(defaultParticipantId('/')).toBe('claude-session')
  expect(defaultParticipantId(`/work/${'a'.repeat(300)}`).length).toBeLessThanOrEqual(128)
  expect(defaultName('/work/Fruit Stand')).toBe('Claude (Fruit Stand)')
  expect(defaultName('/')).toBe('Claude')
})

test('identity: project file over option over default is the base; the handle is <base>.<sid>', () => {
  const options = readOptions({ endpoint: CONN.endpoint, credentialFile: CONN.credentialFile })
  expect(resolveIdentity(options, '/work/vault', {}, 'a1b2c3')).toEqual({
    ok: true,
    value: { participantId: 'claude-vault.a1b2c3', baseId: 'claude-vault', name: 'Claude (vault) · a1b2c3' },
  })
  const configured = { ...options, participantId: 'from-options', name: 'From Options' }
  expect(resolveIdentity(configured, '/work/vault', {}, 'a1b2c3')).toEqual({
    ok: true,
    value: { participantId: 'from-options.a1b2c3', baseId: 'from-options', name: 'From Options · a1b2c3' },
  })
  expect(resolveIdentity(configured, '/work/vault', { participantId: 'from-file' }, 'a1b2c3')).toEqual({
    ok: true,
    value: { participantId: 'from-file.a1b2c3', baseId: 'from-file', name: 'From Options · a1b2c3' },
  })
  expect(resolveIdentity({ ...options, participantId: 'bad id' }, '/work/vault', {}, 'a1b2c3').ok).toBe(false)
})

test('the handle stays within the id rule: a long base gives way to the suffix, a long name to the sid', () => {
  const options = readOptions({ endpoint: CONN.endpoint, credentialFile: CONN.credentialFile, participantId: 'b'.repeat(128), name: 'n'.repeat(200) })
  const identity = resolveIdentity(options, '/work/vault', {}, 'a1b2c3')
  expect(identity.ok).toBe(true)
  if (!identity.ok) return
  expect(identity.value.participantId).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
  expect(identity.value.participantId.length).toBe(128)
  expect(identity.value.participantId.endsWith('.a1b2c3')).toBe(true)
  expect(identity.value.baseId).toBe('b'.repeat(128))
  expect(identity.value.name.length).toBeLessThanOrEqual(80)
  expect(identity.value.name.endsWith(' · a1b2c3')).toBe(true)
})

test('the sid is the first six letters and digits of the session id, lowercase; a missing id falls back to the random one', () => {
  expect(sessionSid('3F9A1C0E-7b2d-4c8e-9a51-0d6e2f4b8a17', 'zzzzzz')).toBe('3f9a1c')
  expect(sessionSid('--ab--cd--ef--gh', 'zzzzzz')).toBe('abcdef')
  expect(sessionSid('ab', 'zzzzzz')).toBe('ab')
  expect(sessionSid(undefined, 'Q1W2E3R4')).toBe('q1w2e3')
  expect(sessionSid('---', 'Q1W2E3R4')).toBe('q1w2e3')
  expect(sessionSid(42, '9f8e7d6c')).toBe('9f8e7d')
})

test('settings are kept per base id, so sessions of one project share them; the rest of a record is per handle', () => {
  expect(settingsKey('e', 'claude-vault')).toBe('settings e claude-vault')
  expect(storeKey('e', 'claude-vault.a1b2c3')).toBe('inbox e claude-vault.a1b2c3')
})

test('eviction keeps the handle\'s record and the base\'s, and forgets an old lease with its record', () => {
  const keys = ['lease e old', 'inbox e old', 'settings e claude-vault', 'inbox e claude-vault.a1b2c3']
  const plan = planEviction(keys, [{ endpoint: 'e', participantId: 'old', at: 1 }], [{ endpoint: 'e', participantId: 'claude-vault.a1b2c3' }, { endpoint: 'e', participantId: 'claude-vault' }], 100, 2)
  expect(plan.evict.sort()).toEqual(['inbox e old', 'lease e old'])
  expect(plan.index.map(r => r.participantId).sort()).toEqual(['claude-vault', 'claude-vault.a1b2c3'])
})

test('the project file is read for participantId and name and nothing else', () => {
  expect(parseProjectFile('{}')).toEqual({ ok: true, value: {} })
  expect(parseProjectFile('{"participantId":"claude-ci","name":" CI "}')).toEqual({ ok: true, value: { participantId: 'claude-ci', name: 'CI' } })
  // A participantId that does not start with claude- is left out, and the file says so.
  expect(parseProjectFile('{"participantId":"ci","name":"CI"}')).toEqual({ ok: true, value: { name: 'CI', isIdIgnored: true } })
  expect(parseProjectFile('{"participantId":"","name":""}')).toEqual({ ok: true, value: {} })
  const ignored = parseProjectFile('{"endpoint":"http://127.0.0.1:1/workspaces/x/mcp","credentialFile":"/etc/passwd","orchardBin":"/bin/sh"}')
  expect(ignored).toEqual({ ok: true, value: {} })
  expect(parseProjectFile('[]').ok).toBe(false)
  expect(parseProjectFile('null').ok).toBe(false)
  expect(parseProjectFile('{"participantId":"Owner"}').ok).toBe(false)
  expect(parseProjectFile('{"participantId":"orchard"}').ok).toBe(false)
  expect(parseProjectFile('{"participantId":"a/b"}').ok).toBe(false)
})

test('the band is the session\'s one line: connected, busy, with subagents, left, offline or a sanitized error, and never a request id', () => {
  const quiet = { unread: 0, forYou: 0, needsYou: 0 }
  const ws = { name: 'Fruit Stand', ownerId: 'owner' }
  const line = (status: BandInput['status'], workspace: BandInput['workspace'], counts: BandInput['counts'], extra: Partial<BandInput> = {}) => bandLine({ status, workspace, counts, ...extra })
  const sub = (agentId: string, status: OrchardAgent['status'], extra: Partial<OrchardAgent> = {}): OrchardAgent => ({ agentId, description: agentId, type: 'general-purpose', status, startedAt: 0, ...extra })
  expect(line(null, null, quiet)).toBeNull()
  expect(line({ kind: 'connecting' }, null, quiet)?.text).toBe('◆ Claude · connecting…')
  // Connected and quiet still draws the standing sign that it is alive.
  expect(line({ kind: 'connected' }, ws, quiet)?.text).toBe('◆ Claude is connected to Fruit Stand')
  expect(line({ kind: 'connected' }, { name: null, ownerId: null }, quiet)?.text).toBe('◆ Claude is connected to the workspace')
  expect(line({ kind: 'connected' }, { name: null, ownerId: null }, { unread: 1, forYou: 0, needsYou: 0 })?.text).toBe('◆ Claude · 1 queued')
  expect(line({ kind: 'offline', failures: 3 }, ws, quiet)).toMatchObject({ text: '◆ Claude in Fruit Stand · ○ offline', tone: 'warning' })
  expect(line({ kind: 'disconnected' }, ws, quiet)).toMatchObject({ text: '◇ Claude is disconnected from Fruit Stand · /orchard connect', tone: 'quiet' })
  expect(line({ kind: 'signed-off' }, ws, quiet)).toMatchObject({ text: '◇ Claude is signed off from Fruit Stand · /orchard connect', tone: 'quiet' })
  expect(line({ kind: 'error', message: 'nope' }, ws, quiet)).toMatchObject({ text: '◆ Claude in Fruit Stand · error: nope', tone: 'error' })
  expect(line({ kind: 'connected' }, ws, { unread: 3, forYou: 0, needsYou: 0 })?.text).toBe('◆ Claude in Fruit Stand · 3 queued')
  expect(line({ kind: 'connected' }, ws, { unread: 2, forYou: 1, needsYou: 1 })?.text).toBe('◆ Claude in Fruit Stand · 2 queued · needs you 1')
  expect(line({ kind: 'connected' }, ws, { unread: 2, forYou: 1, needsYou: 0, isHeld: true })?.text).toBe('◆ Claude in Fruit Stand · 2 queued · sends when box is empty')
  expect(line({ kind: 'connected' }, ws, { unread: 0, forYou: 0, needsYou: 2 })?.text).toBe('◆ Claude in Fruit Stand · needs you 2')
  expect(line({ kind: 'connected' }, ws, { unread: -1, forYou: Number.NaN, needsYou: 0 })?.text).toBe('◆ Claude is connected to Fruit Stand')
  expect(line({ kind: 'connected', isStoreFailing: true }, ws, quiet)).toMatchObject({ tone: 'warning' })
  expect(line({ kind: 'connected' }, { name: 'Line one\nline two', ownerId: null }, { unread: 1, forYou: 0, needsYou: 0 })?.text).toBe('◆ Claude in Line one line two · 1 queued')

  // What it is handling now, and what waits behind it.
  const one = { at: 0, total: 1, items: [{ sender: 'Ada', how: 'DM', snippet: 'hi' }] }
  expect(line({ kind: 'connected' }, ws, { unread: 1, forYou: 1, needsYou: 0 }, { now: one })?.text).toBe('◆ Claude in Fruit Stand · handling DM from Ada · 1 queued')
  expect(line({ kind: 'connected' }, ws, quiet, { now: { ...one, total: 3 } })?.text).toBe('◆ Claude in Fruit Stand · handling 3 messages')

  // Subagents: said while one runs or one is still signed on; a clean finish is no news.
  const agents = {
    a: sub('a', 'running', { handle: 'claude-vault.a', signedOn: true }),
    b: sub('b', 'completed', { handle: 'claude-vault.b', signedOn: true }),
    c: sub('c', 'completed', { handle: 'claude-vault.c', signedOn: false }),
  }
  expect(line({ kind: 'connected' }, ws, quiet, { agents })?.text).toBe('◆ Claude in Fruit Stand · 3 subagents · 1 running · 1 still signed on')
  expect(line({ kind: 'connected' }, ws, quiet, { agents: { c: agents.c } })?.text).toBe('◆ Claude is connected to Fruit Stand')
  expect(line({ kind: 'connected' }, ws, quiet, { agents: { b: { ...agents.b, sharesBase: true } } })?.text).toBe('◆ Claude is connected to Fruit Stand')
})

test('workspace_info gives a name and an owner; missing pieces stay null', () => {
  expect(parseWorkspace({ workspace: { name: ' Fruit Stand ' }, owner_participant_id: 'owner' })).toEqual({ name: 'Fruit Stand', ownerId: 'owner' })
  expect(parseWorkspace({ workspace: {} })).toEqual({ name: null, ownerId: null })
  expect(parseWorkspace(undefined)).toEqual({ name: null, ownerId: null })
  expect(parseWorkspace('text')).toEqual({ name: null, ownerId: null })
})

// runOrchard is the wrapper every later piece calls; its result is {exitCode, json?, rejected?, message?}.
type Ran = Parameters<Run>
function stubRun(reply: { exitCode: number; stdout?: string; stderr?: string } | 'reject') {
  const calls: { argv: Ran[0]; init: Ran[1] }[] = []
  const run: Run = async (argv, init) => {
    calls.push({ argv, init })
    if (reply === 'reject') throw new Error(`timed out running ${argv.join(' ')} with ${JSON.stringify(init.env)}`)
    return { exitCode: reply.exitCode, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  return { run, calls }
}

test('runOrchard: env carries the endpoint and the credential path, argv neither, a timeout always', async () => {
  const { run, calls } = stubRun({ exitCode: 0, stdout: '{"ok":true}' })
  const result = await runOrchard(run, CONN, ['status'])
  expect(result).toEqual({ exitCode: 0, json: { ok: true } })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.argv).toEqual(['/opt/fake/Orchard', 'agent', 'status'])
  expect(calls[0]?.init.env).toEqual({ ORCHARD_AGENT_ENDPOINT: CONN.endpoint, ORCHARD_AGENT_CREDENTIAL_FILE: CONN.credentialFile })
  expect(calls[0]?.init.timeoutMs).toBe(CLI_TIMEOUT_MS)

  await runOrchard(run, CONN, ['alerts'], { timeoutMs: 75_000, stdin: '{}' })
  expect(calls[1]?.init.timeoutMs).toBe(75_000)
  expect(calls[1]?.init.stdin).toBe('{}')
})

test('runOrchard: a rejected run is exit 3 with rejected: true and no text from the error', async () => {
  const { run } = stubRun('reject')
  const result = await runOrchard(run, CONN, ['status'])
  expect(result).toEqual({ exitCode: 3, rejected: true })
  expect(JSON.stringify(result).includes(CONN.credentialFile)).toBe(false)
})

test('runOrchard: exit 3 has no message, exit 2 and 4 a sanitized one, others a plain one', async () => {
  expect(await runOrchard(stubRun({ exitCode: 3, stderr: `connection refused at ${CONN.endpoint}` }).run, CONN, ['status'])).toEqual({ exitCode: 3 })

  const four = await runOrchard(
    stubRun({ exitCode: 4, stderr: `Orchard agent: MCP tool "x" returned an error: {"error":"bad thing at ${CONN.credentialFile}"}` }).run,
    CONN,
    ['status'],
  )
  expect(four).toEqual({ exitCode: 4, message: 'bad thing at' })

  const two = await runOrchard(stubRun({ exitCode: 2, stderr: `cannot read credential file ${CONN.credentialFile}` }).run, CONN, ['status'])
  expect(two.exitCode).toBe(2)
  expect(JSON.stringify(two).includes('secrets')).toBe(false)

  expect(await runOrchard(stubRun({ exitCode: 101, stderr: 'panic at /Users/tester/src/main.rs' }).run, CONN, ['status'])).toEqual({
    exitCode: 101,
    message: 'the Orchard CLI exited with code 101',
  })
})

test('runOrchard: output that is not JSON leaves json out', async () => {
  const result = await runOrchard(stubRun({ exitCode: 0, stdout: 'not json' }).run, CONN, ['status'])
  expect(result).toEqual({ exitCode: 0, json: undefined })
})

test('the status line: quiet or a count in ten minutes, the open tasks when known, and what the connection is when it is not up', () => {
  const ws = { name: 'Fruit Stand', ownerId: null }
  const none = { recentFromOthers: 0, openTasks: null }
  expect(statusLine(null, ws, none)).toBeUndefined()
  expect(statusLine({ kind: 'connected' }, ws, none)).toBe('orchard · Fruit Stand · quiet')
  expect(statusLine({ kind: 'connected' }, ws, { recentFromOthers: 4, openTasks: 12 })).toBe('orchard · Fruit Stand · ● 4 in 10m · 12 open tasks')
  expect(statusLine({ kind: 'connected' }, ws, { recentFromOthers: 0, openTasks: 1 })).toBe('orchard · Fruit Stand · quiet · 1 open task')
  expect(statusLine({ kind: 'connected' }, { name: null, ownerId: null }, none)).toBe('orchard · quiet')
  expect(statusLine({ kind: 'disconnected' }, ws, none)).toBe('orchard · disconnected')
  expect(statusLine({ kind: 'signed-off' }, ws, none)).toBe('orchard · signed off')
  expect(statusLine({ kind: 'offline', failures: 1 }, ws, none)).toBe('orchard · offline')
})

test('the words of the pane: short handles, an agent\'s state, how a message reached the session, a stable colour per agent', () => {
  expect(shortHandle('claude-vault.garden', 'claude-vault')).toBe('garden')
  expect(shortHandle('claude-vault', 'claude-vault')).toBe('claude-vault')
  expect(shortHandle('claude-other.x', 'claude-vault')).toBe('claude-other.x')
  const a = (status: OrchardAgent['status'], extra: Partial<OrchardAgent> = {}): OrchardAgent => ({ agentId: 'a1', description: 'd', type: 't', status, startedAt: 0, ...extra })
  expect(agentState(a('running'))).toEqual({ text: '● running', tone: 'ok' })
  expect(agentState(a('completed', { handle: 'x', signedOn: false }))).toEqual({ text: '✓ done · signed off', tone: 'dim' })
  expect(agentState(a('completed', { handle: 'x', signedOn: true }))).toEqual({ text: '⚠ done · still signed on', tone: 'warn' })
  expect(agentState(a('completed', { handle: 'x', signedOn: true, sharesBase: true })).text).toBe('✓ done')
  expect(agentState(a('idle', { agentId: 'main', handle: 'x', signedOn: true })).text).toBe('● signed on')
  expect(howOf({ reasons: ['direct'], where: 'direct' })).toBe('DM')
  expect(howOf({ reasons: ['channel'], where: 'channel general' })).toBe('#general')
  expect(agentColor('agent-1')).toBe(agentColor('agent-1'))
  const alert = { senderName: 'Ada', senderId: 'ada', reasons: ['mention'], where: 'channel general', body: 'hi\nthere' } as never
  const now = nowOf([alert, alert, alert, alert], 5, () => null)
  expect(now).toMatchObject({ at: 5, total: 4 })
  expect(now.items).toHaveLength(3)
  expect(handlingText(now)).toBe('handling 4 messages')
  expect(handlingText(nowOf([alert], 5, () => null))).toBe('handling mention from Ada')
})

test('autoConnect is on only for true; the key remembering a connected session names the endpoint and the session', () => {
  expect(readOptions({ autoConnect: true }).autoConnect).toBe(true)
  expect(readOptions({ autoConnect: 'true' }).autoConnect).toBe(true)
  expect(readOptions({ autoConnect: false }).autoConnect).toBe(false)
  expect(readOptions({ autoConnect: 'yes' }).autoConnect).toBe(false)
  expect(connectedKey('http://e/mcp', 'abc123')).toBe('connected http://e/mcp abc123')
})
