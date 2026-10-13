import { expect, test } from 'claude-code/testing'

import { bandLine } from './band'
import { BIN, CREDENTIAL, CWD, ENDPOINT, ME, OPTIONS } from './fake-orchard'
import type { Call } from './fake-orchard'
import { bandText, begin, connectionCalls, expectNoSecrets, resumes, visible, world } from './test-world'
import type { World } from './test-world'

const WORKSPACE = 'Fruit Stand'

const CONNECTED = { kind: 'connected' }

test('no endpoint configured: the mod does nothing at all', async ($, on) => {
  const w = world(on, { files: { [`${CWD}/.orchard.json`]: JSON.stringify({ participantId: 'someone' }) } })

  await begin($, w)
  await w.clock.advance(20 * 60_000)

  expect(w.fake.calls).toEqual([])
  expect(w.fs.reads).toEqual([])
  expect(w.session.appended()).toEqual([])
  expect(w.sinks.seen).toEqual([])
  expect(w.state.latest).toEqual({})
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface)).toBeUndefined()
  }
})

test('an endpoint in .orchard.json cannot switch the mod on', async ($, on) => {
  const w = world(on, {
    files: { [`${CWD}/.orchard.json`]: JSON.stringify({ endpoint: ENDPOINT, credentialFile: CREDENTIAL }) },
  })

  await begin($, w)

  expect(w.fake.calls).toEqual([])
  expect(await bandText($)).toBeUndefined()
})

test('resume succeeds: connected and quiet draws no band; with news it names the workspace and nothing else', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)

  // resume, then workspace_info through `call ... stdin` (the listener's own calls come after)
  expect(connectionCalls(w).map(c => c.argv)).toEqual([
    [BIN, 'agent', 'resume', '--participant-id', ME],
    [BIN, 'agent', 'call', 'workspace_info', 'stdin'],
  ])
  expect(w.fake.calls[1]?.stdin).toBe('{}')

  for (const call of w.fake.calls) {
    // The endpoint and the credential path travel in the environment only.
    expect(call.env).toEqual({ ORCHARD_AGENT_ENDPOINT: ENDPOINT, ORCHARD_AGENT_CREDENTIAL_FILE: CREDENTIAL })
    expect(call.argv.join(' ').includes(CREDENTIAL)).toBe(false)
    expect(call.argv.join(' ').includes(ENDPOINT)).toBe(false)
    expect(typeof call.timeoutMs).toBe('number')
  }
  // The mod never reads the credential file (or anything but the project file lookup).
  expect(w.fs.reads).toEqual([])

  // Connected, nothing pending, nothing waiting on the owner: the band draws nothing.
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface)).toBe('◆ Claude is connected to Fruit Stand')
  }
  expect(w.state.latest.workspace).toEqual({ name: WORKSPACE, ownerId: 'owner' })
  expect(w.state.latest.status).toEqual(CONNECTED)

  // Any count above zero brings it back, with the workspace name and no ids, request ids or paths.
  w.state.override.band = bandLine({ status: { kind: 'connected' }, workspace: { name: WORKSPACE, ownerId: 'owner' }, counts: { unread: 1, forYou: 0, needsYou: 0 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandText($, surface)).toBe('◆ Claude in Fruit Stand · 1 queued')
  }
  const text = (await bandText($)) ?? ''
  expect(text.includes('/')).toBe(false)
  expect(text.includes('ws_')).toBe(false)

  expectNoSecrets(await visible($, w))
  expect(w.clock.now()).toBe(0)
})

test('connected and quiet, an offline or error session still shows its band', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.script = () => ({ exitCode: 3 })
  await begin($, w)
  expect(await bandText($)).toBe('◆ Claude · ○ offline')
  w.state.override.counts = { unread: 0, forYou: 0, needsYou: 2 }
  expect(await bandText($)).toBe('◆ Claude · ○ offline')
})

test('a band yields to a survey', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)
  expect(await bandText($, 'terminal', { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 100 })).toBeUndefined()
})

test('unknown participant: join with a fresh request id, then the workspace', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.isKnown = false
  await begin($, w)

  expect(connectionCalls(w).map(c => c.cmd)).toEqual(['resume', 'join', 'call'])
  const join = w.fake.calls[1] as Call
  expect(join.argv.slice(0, 7)).toEqual([BIN, 'agent', 'join', '--participant-id', ME, '--name', 'Claude (Fruit Stand)'])
  expect(join.argv[7]).toBe('--request-id')
  expect(join.argv[8]).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
  expect(w.state.latest.status).toEqual(CONNECTED)
  expectNoSecrets(await visible($, w))
})

test('a join that ended in exit 3 is retried with the same request id', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.isKnown = false
  let joins = 0
  w.fake.script = call => {
    if (call.cmd !== 'join') return undefined
    joins += 1
    return joins === 1 ? 'reject' : undefined
  }
  await begin($, w)
  expect(await bandText($)).toBe('◆ Claude · ○ offline')

  await w.clock.advance(5_000)

  const ids = w.fake.calls.filter(c => c.cmd === 'join').map(c => c.argv[8])
  expect(ids).toHaveLength(2)
  expect(ids[1]).toBe(ids[0])
  expect(w.state.latest.status).toEqual(CONNECTED)
})

test('exit 3 shows offline and retries 5 s, 10 s, 20 s ... capped at 5 min', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  let isDown = true
  w.fake.script = () => (isDown ? { exitCode: 3, stderr: 'Orchard agent: connection refused\n' } : undefined)

  await begin($, w)
  expect(await bandText($)).toBe('◆ Claude · ○ offline')
  expect(w.state.latest.status).toEqual({ kind: 'offline', failures: 1 })

  await w.clock.advance(16 * 60_000)

  const seconds = resumes(w).map(c => c.at / 1000)
  expect(seconds).toEqual([0, 5, 15, 35, 75, 155, 315, 615, 915])
  expect(await bandText($)).toBe('◆ Claude · ○ offline')

  // Back up: the next retry connects, shows the workspace and stops retrying.
  isDown = false
  await w.clock.advance(300_000)
  expect(w.state.latest.status).toEqual(CONNECTED)
  const callsAfterRecovery = connectionCalls(w).length
  await w.clock.advance(60 * 60_000)
  expect(connectionCalls(w).length).toBe(callsAfterRecovery)

  expectNoSecrets(await visible($, w))
})

test('a rejected run (timeout) counts as exit 3', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.script = (_call, n) => (n === 1 ? 'reject' : undefined)

  await begin($, w)
  expect(await bandText($)).toBe('◆ Claude · ○ offline')

  await w.clock.advance(5_000)
  expect(resumes(w).map(c => c.at)).toEqual([0, 5_000])
  expect(w.state.latest.status).toEqual(CONNECTED)
})

test('any exit 0 resets the backoff to 5 s', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  // Three failed resumes (waits 5, 10, 20 s), then a resume that works but a workspace_info that does not.
  let resumeCount = 0
  w.fake.script = call => {
    if (call.cmd === 'resume') {
      resumeCount += 1
      return resumeCount <= 3 ? { exitCode: 3 } : undefined
    }
    if (call.cmd === 'call' && resumeCount === 4) return { exitCode: 3 }
    return undefined
  }

  await begin($, w)
  await w.clock.advance(60_000)

  // 0, 5, 15, 35 (resume ok, workspace_info fails), then 5 s later, not 40 s.
  expect(resumes(w).map(c => c.at / 1000)).toEqual([0, 5, 15, 35, 40])
  expect(w.state.latest.status).toEqual(CONNECTED)
})

test('exit 4 shows a sanitized error in the band and stops', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.script = () => ({
    exitCode: 4,
    stderr:
      `Orchard agent: MCP tool "mail_resume" returned an error: {"error":"mail repository is corrupt: ` +
      `/Users/tester/Library/Application Support/Orchard/ws_0123456789abcdef/mail while serving ${ENDPOINT} ` +
      `request_id orchard-join-9f2c41aa-77e0 using ${CREDENTIAL}"}\n`,
  })

  await begin($, w)

  const text = (await bandText($)) ?? ''
  expect(text.startsWith('◆ Claude · error: ')).toBe(true)
  expect(text).toContain('mail repository is corrupt')
  expect(text.includes('/')).toBe(false)
  expect(text.includes('Users')).toBe(false)
  expect(text.includes('orchard-join')).toBe(false)
  expect(text.includes('9f2c41aa')).toBe(false)
  expectNoSecrets(await visible($, w))

  // Stopped: no retry, however long we wait.
  await w.clock.advance(30 * 60_000)
  expect(w.fake.calls.length).toBe(1)
  expect(w.state.latest.status).toMatchObject({ kind: 'error' })
})

test('exit 2 that echoes the credential path never shows it', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  w.fake.script = () => ({
    exitCode: 2,
    stderr: `Orchard agent: cannot read credential file ${CREDENTIAL}: No such file or directory (os error 2)\n`,
  })

  await begin($, w)

  const text = (await bandText($)) ?? ''
  expect(text.startsWith('◆ Claude · error: ')).toBe(true)
  expectNoSecrets(await visible($, w))
  await w.clock.advance(30 * 60_000)
  expect(w.fake.calls.length).toBe(1)
})

test('.orchard.json overrides participantId and name only', { options: OPTIONS }, async ($, on) => {
  const w = world(on, {
    files: {
      [`${CWD}/.orchard.json`]: JSON.stringify({
        participantId: 'claude-ci-bot',
        name: 'CI Bot',
        // None of these may take effect: the model can write this file.
        endpoint: 'http://127.0.0.1:9/workspaces/evil/mcp',
        credentialFile: '/etc/evil-credential',
        orchardBin: '/tmp/evil-orchard',
      }),
    },
  })
  w.fake.isKnown = false

  await begin($, w)

  const [resume, join] = w.fake.calls as [Call, Call]
  expect(resume.argv).toEqual([BIN, 'agent', 'resume', '--participant-id', 'claude-ci-bot'])
  expect(join.argv.slice(0, 7)).toEqual([BIN, 'agent', 'join', '--participant-id', 'claude-ci-bot', '--name', 'CI Bot'])
  for (const call of w.fake.calls) {
    expect(call.argv[0]).toBe(BIN)
    expect(call.env).toEqual({ ORCHARD_AGENT_ENDPOINT: ENDPOINT, ORCHARD_AGENT_CREDENTIAL_FILE: CREDENTIAL })
  }
  // The credential file is not read; the project file is.
  expect(w.fs.reads).toEqual([`${CWD}/.orchard.json`])
  expect(w.state.latest.status).toEqual(CONNECTED)
})

test('a .orchard.json participantId that does not start with claude- is ignored, with one toast', { options: OPTIONS }, async ($, on) => {
  const w = world(on, { files: { [`${CWD}/.orchard.json`]: JSON.stringify({ participantId: 'nick', name: 'Nick Impostor' }) } })
  await begin($, w)

  // The default identity stands (the name override, which cannot impersonate, still applies).
  expect(w.fake.calls[0]?.argv).toEqual([BIN, 'agent', 'resume', '--participant-id', ME])
  expect(w.state.latest.status).toEqual(CONNECTED)
  const toasts = w.sinks.seen.filter(line => line.includes('ui.toast') || line.includes('claude-'))
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('must start with')
  expect(toasts[0]?.includes('nick')).toBe(false)

  // A second start in the same session does not toast again.
  await $.command.run({ command: 'orchard', args: 'reconnect', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  await w.clock.settle()
  expect(w.sinks.seen.filter(line => line.includes('must start with'))).toHaveLength(1)
})

const BAD_PROJECT_FILES: [string, string, string][] = [
  ['invalid JSON', '{ not json', '.orchard.json is not valid JSON'],
  ['a reserved participantId', JSON.stringify({ participantId: 'owner' }), 'reserved'],
  ['a malformed participantId', JSON.stringify({ participantId: 'has space' }), 'participantId must be'],
  ['a name that is not a string', JSON.stringify({ name: 7 }), 'name must be a string'],
]
for (const [label, body, expected] of BAD_PROJECT_FILES) {
  test(`.orchard.json with ${label} stops the connection before any call`, { options: OPTIONS }, async ($, on) => {
    const w = world(on, { files: { [`${CWD}/.orchard.json`]: body } })
    await begin($, w)

    expect(w.fake.calls).toEqual([])
    const text = (await bandText($)) ?? ''
    expect(text.startsWith('◆ Claude · error: ')).toBe(true)
    expect(text).toContain(expected)
  })
}

test(
  'userConfig sets the identity and the executable',
  { options: { ...OPTIONS, orchardBin: '/opt/other/Orchard', participantId: 'agent-7', name: 'Agent Seven' } },
  async ($, on) => {
    const w = world(on)
    w.fake.isKnown = false
    await begin($, w)

    const [resume, join] = w.fake.calls as [Call, Call]
    expect(resume.argv).toEqual(['/opt/other/Orchard', 'agent', 'resume', '--participant-id', 'agent-7'])
    expect(join.argv.slice(0, 7)).toEqual(['/opt/other/Orchard', 'agent', 'join', '--participant-id', 'agent-7', '--name', 'Agent Seven'])
  },
)

test('an endpoint without a usable credential path is an error, not a silent mod', {
  options: { endpoint: ENDPOINT, credentialFile: 'relative/secret', orchardBin: BIN },
}, async ($, on) => {
  const w = world(on)
  await begin($, w)

  expect(w.fake.calls).toEqual([])
  const text = (await bandText($)) ?? ''
  expect(text).toBe('◆ Claude · error: credentialFile must be an absolute path')
  expect(text.includes('relative/secret')).toBe(false)
})

test('the band shows new counts from state', { options: OPTIONS }, async ($, on) => {
  const w = world(on)
  await begin($, w)

  w.state.override.band = bandLine({ status: { kind: 'connected' }, workspace: { name: WORKSPACE, ownerId: 'owner' }, counts: { unread: 2, forYou: 1, needsYou: 1 } })
  expect(await bandText($)).toBe('◆ Claude in Fruit Stand · 2 queued · needs you 1')

  w.state.override.band = bandLine({ status: { kind: 'connected' }, workspace: { name: WORKSPACE, ownerId: 'owner' }, counts: { unread: 0, forYou: 0, needsYou: 0 } })
  expect(await bandText($)).toBe('◆ Claude is connected to Fruit Stand')
})
