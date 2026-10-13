// A fake Orchard CLI and its surroundings for the tests. Nothing here reaches the
// real endpoint: the engine's `process.run` is answered from this script, and the fake
// records every call so a test can read back exactly what the mod asked for.
//
// It models the server closely enough for the listener: a message log with sequences, the
// alerts the server would compute for the participant, `workspace_alerts` paging (the cursor
// is the sequence of the last message scanned, `has_more` when the page filled before the
// scan ended) and long polling on the mock clock.
import type { On } from 'claude-code'

export const BIN = '/opt/fake/Orchard'
export const ENDPOINT = 'http://127.0.0.1:4312/workspaces/ws_0123456789abcdef/mcp'
export const CREDENTIAL = '/Users/tester/.secrets/orchard-credential-7f3a'
export const CWD = '/work/Fruit Stand'
/** The default options: nothing connects a session until it is asked to. */
export const UNCONNECTED = { endpoint: ENDPOINT, credentialFile: CREDENTIAL, orchardBin: BIN }
/** A connected session (`autoConnect`): the tests that are not about connecting assume one. */
export const OPTIONS = { ...UNCONNECTED, autoConnect: true }
/** The configured id for CWD: the base every session of the folder shares (and the key of its settings). */
export const BASE = 'claude-fruit-stand'
/** The test session's id, and the six characters of it that end up in its handle. */
export const SESSION_ID = '3F9A1C0E-7b2d-4c8e-9a51-0d6e2f4b8a17'
export const SID = '3f9a1c'
/** The participant the mod connects as in CWD: this session's own handle. */
export const ME = `${BASE}.${SID}`

/** Strings that must never reach anything the model can read. */
export const SECRETS = [CREDENTIAL, '.secrets', 'orchard-credential', ENDPOINT, '127.0.0.1', 'ws_0123456789abcdef']

export type Call = {
  /** Mock-clock time the call arrived. */
  at: number
  argv: string[]
  /** `resume`, `join`, `call`, `alerts`, `ack` ... (argv[2]). */
  cmd: string
  /** For `call TOOL stdin`: the tool (argv[3]); otherwise the same as `cmd`. */
  tool: string
  env: Record<string, string>
  stdin: string | undefined
  timeoutMs: number | undefined
}

export type Reply = { exitCode: number; stdout?: string; stderr?: string } | 'reject'

export type FakeMessage = {
  id: string
  sequence: number
  sender_id: string
  body: string
  kind?: string
  thread_id?: string
  destination: { kind: 'direct' | 'channel' | 'broadcast'; id?: string }
  recipient_ids: string[]
  sent_at?: string
}

export type FakeAlert = {
  /** direct, broadcast, mention, reply, channel: as the server computes them. */
  reasons: string[]
  message: FakeMessage
  channel?: { id: string; name: string } | null
}

export type Fake = {
  calls: Call[]
  /** Addresses the mod asked the system to open (`open URL`); kept apart from `calls`, which are the Orchard CLI's. */
  opened: string[]
  /** Whether the participant is registered: `resume` fails with not-found until a `join`, and after a `mail_leave`. */
  isKnown: boolean
  /** Who is registered (signed on), by participant id: `mail_participants` reports it, `mail_leave` removes from it. `isKnown` is ME's. A test adds the participants its agents signed on as. */
  registered: Set<string>
  /** When the workspace last heard from a participant (`last_contact_at` in `mail_participants`); a participant not here has no recorded contact. */
  lastContact: Record<string, string>
  workspaceName: string
  ownerId: string
  /** Every message in the workspace, oldest first. `push` adds to it. */
  messages: FakeMessage[]
  /** The alerts the server would compute for the participant, by message id. */
  alerts: Map<string, FakeAlert>
  participants: { id: string; name: string }[]
  /** Acknowledgements received: the ids and the request id. */
  acks: { ids: string[]; requestId: string }[]
  /** Messages sent through `mail_send`, as the tool received them. */
  sent: Record<string, unknown>[]
  channels: { id: string; name: string }[]
  /** Task stores and tasks `tasks_list` answers from: a task without `status` is open, one without `store_id` is in every store. */
  taskStores: { id: string; name: string }[]
  tasks: Record<string, unknown>[]
  /** The plugins `workspace_info` lists, attached or not. */
  plugins: { id: string; attached: boolean }[]
  /** What `roles_list` answers: the declarations of the Roles plugin. `role_declare` adds one. */
  declarations: { participant_id: string; roles: string[] }[]
  /** What `state_list` answers: the markers of the State plugin. */
  markers: Record<string, unknown>[]
  /** Overrides the default answer for a call; `n` is the call's 1-based position. Return undefined for the default. */
  script: ((call: Call, n: number) => Reply | undefined | Promise<Reply | undefined>) | undefined
  /** Adds a message that alerts the participant (or not, with no alert) and wakes a waiting poll. */
  push: (message: Partial<FakeMessage> & { id: string }, alert?: { reasons: string[]; channel?: FakeAlert['channel'] }) => FakeMessage
  /** How many `alerts` calls were answered, and how many are waiting on the server right now. */
  waiting: number
  /** The host has the `workspace_decisions` tool (an older host answers a tool error). */
  hasDecisionsTool: boolean
}

const json = (value: unknown): Reply => ({ exitCode: 0, stdout: JSON.stringify(value, null, 2) })

const NOT_REGISTERED: Reply = {
  exitCode: 4,
  stderr: `Orchard agent: MCP tool "mail_resume" returned an error: {"error":"not found: registered participant ${ME}"}\n`,
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at < 0 ? undefined : argv[at + 1]
}

function alertsPage(fake: Fake, argv: readonly string[]): { exitCode: 0; stdout: string } {
  const after = Number(flag(argv, '--after') ?? 0)
  const limit = Number(flag(argv, '--limit') ?? 50)
  const isChannels = argv.includes('--channels')
  const scanned = fake.messages.filter(m => m.sequence > after)
  const alerts: unknown[] = []
  let next = after
  let count = 0
  for (const message of scanned) {
    count += 1
    next = message.sequence
    const alert = fake.alerts.get(message.id)
    const reasons = (alert?.reasons ?? []).filter(r => isChannels || r !== 'channel')
    if (alert !== undefined && reasons.length > 0) {
      alerts.push({ reasons, message, channel: alert.channel ?? null, resource: { href: `/w/ws_0123456789abcdef/messages/${message.id}` } })
    }
    if (alerts.length === limit) break
  }
  return { exitCode: 0, stdout: JSON.stringify({ alerts, next_cursor: next, has_more: count < scanned.length }, null, 2) }
}

async function answer(fake: Fake, call: Call, sleep: (ms: number) => Promise<void>, signal: () => Promise<void>): Promise<Reply> {
  const argv = call.argv
  if (call.cmd === 'resume') {
    return fake.isKnown ? json({ participant: { id: ME, registered: true } }) : NOT_REGISTERED
  }
  if (call.cmd === 'join') {
    fake.isKnown = true
    return json({ participant: { id: ME, registered: true } })
  }
  if (call.cmd === 'alerts') {
    const wait = Number(flag(argv, '--wait') ?? 0)
    let page = alertsPage(fake, argv)
    if (wait > 0 && (JSON.parse(page.stdout) as { alerts: unknown[] }).alerts.length === 0) {
      // The server holds the request until an alert exists or the wait ends.
      fake.waiting += 1
      try {
        await Promise.race([sleep(wait * 1000), signal()])
      } finally {
        fake.waiting -= 1
      }
      page = alertsPage(fake, argv)
    }
    return page
  }
  if (call.cmd === 'ack') {
    const ids = argv.flatMap((a, i) => (a === '--message-id' ? [argv[i + 1] ?? ''] : []))
    fake.acks.push({ ids, requestId: flag(argv, '--request-id') ?? '' })
    return json({ acknowledged: ids.length })
  }
  if (call.cmd === 'call') {
    const args = (call.stdin ? JSON.parse(call.stdin) : {}) as Record<string, unknown>
    // The plugin gateway runs the operation it names with the nested arguments.
    if (call.tool === 'plugin_call' && typeof args.operation === 'string') {
      return answer(fake, { ...call, tool: args.operation, stdin: JSON.stringify(args.arguments ?? {}) }, sleep, signal)
    }
    switch (call.tool) {
      case 'workspace_info':
        return json({
          workspace: {
            id: 'ws_0123456789abcdef',
            name: fake.workspaceName,
            root: '/Users/tester/Orchard/fruit-stand',
            task_stores: fake.taskStores,
          },
          owner_participant_id: fake.ownerId,
          system_participant_id: 'orchard',
          plugins: fake.plugins.map(p => ({ id: p.id, name: p.id, attached: p.attached, required: false })),
        })
      case 'mail_channels':
        return json({ channels: fake.channels })
      case 'mail_participants':
        return json({
          participants: fake.participants.map(p => ({
            ...p,
            registered: fake.registered.has(p.id),
            ...(fake.lastContact[p.id] === undefined ? {} : { last_contact_at: fake.lastContact[p.id] }),
          })),
        })
      case 'mail_leave': {
        const id = String(args.participant_id ?? '')
        if (!fake.registered.delete(id)) return { exitCode: 4, stderr: `Orchard agent: MCP tool "mail_leave" returned an error: {"error":"not found: registered participant ${id}"}\n` }
        return json({ participant: { id, registered: false } })
      }
      case 'mail_history': {
        let list = fake.messages
        if (typeof args.sender_id === 'string') list = list.filter(m => m.sender_id === args.sender_id)
        if (typeof args.thread_id === 'string') list = list.filter(m => m.thread_id === args.thread_id)
        const limit = typeof args.limit === 'number' ? args.limit : 50
        if (args.latest === true) return json({ messages: list.slice(-limit) })
        const after = typeof args.after === 'number' ? args.after : 0
        return json({ messages: list.filter(m => m.sequence > after).slice(0, limit) })
      }
      case 'mail_send': {
        fake.sent.push(args)
        const message = fake.push({
          id: `m_sent_${fake.sent.length}`,
          sender_id: String(args.sender_id ?? ME),
          body: String(args.body ?? ''),
          destination: args.destination as FakeMessage['destination'],
          thread_id: typeof args.thread_id === 'string' ? args.thread_id : undefined,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          recipient_ids: [],
        })
        return json({ message })
      }
      case 'mail_acknowledge': {
        const ids = Array.isArray(args.message_ids) ? (args.message_ids as string[]) : []
        fake.acks.push({ ids, requestId: String(args.request_id ?? '') })
        return json({ acknowledged: ids.length })
      }
      case 'tasks_list': {
        const tasks = fake.tasks.filter(
          t => (args.status === undefined || (t.status ?? 'open') === args.status) && (t.store_id === undefined || t.store_id === args.store_id),
        )
        return json({ store_id: args.store_id, tasks })
      }
      case 'roles_list':
        return json({ roles: [], declarations: fake.declarations, advisory: true })
      case 'state_list':
        return json({ markers: fake.markers })
      case 'workspace_decisions': {
        if (!fake.hasDecisionsTool) return { exitCode: 4, stderr: 'Orchard agent: unknown tool workspace_decisions\n' }
        const answered = new Set(fake.messages.filter(m => m.sender_id === fake.ownerId).map(m => m.thread_id))
        const open = fake.messages.filter(
          m => m.kind === 'decision' && m.sender_id !== fake.ownerId && !answered.has(m.id) && (typeof args.sender_id !== 'string' || m.sender_id === args.sender_id),
        )
        return json({ decisions: open })
      }
      case 'task_claim':
      case 'task_release':
      case 'task_close':
      case 'task_update': {
        // The task the call names, changed as the call says; its row is what `tasks_list` answers from afterwards.
        const task = fake.tasks.find(t => t.id === args.task_id)
        if (task === undefined) return { exitCode: 4, stderr: 'Orchard agent: task not found\n' }
        if (call.tool === 'task_claim') Object.assign(task, { status: 'in_progress', assignee: args.participant_id })
        if (call.tool === 'task_release') Object.assign(task, { status: 'open', assignee: null })
        if (call.tool === 'task_close') Object.assign(task, { status: 'closed' })
        return json({ task, task_ref: { store_id: args.store_id, task_id: task.id } })
      }
      case 'state_create': {
        const marker = { id: args.id, title: args.title, state: 'todo', revision: 1, subject: args.subject, created_by: args.participant_id }
        fake.markers.push(marker)
        return json({ marker })
      }
      case 'state_advance': {
        const marker = fake.markers.find(m => m.id === args.id)
        if (marker === undefined) return { exitCode: 4, stderr: 'Orchard agent: unknown state marker\n' }
        Object.assign(marker, { state: args.to, revision: Number(marker.revision) + 1 })
        return json({ marker })
      }
      case 'role_declare':
        fake.declarations = fake.declarations.filter(d => d.participant_id !== args.participant_id)
        fake.declarations.push({ participant_id: String(args.participant_id), roles: Array.isArray(args.roles) ? (args.roles as string[]) : [] })
        return json({ declared: true, participant_id: args.participant_id })
    }
  }
  return { exitCode: 2, stderr: 'Orchard agent: unexpected command\n' }
}

/** Answers the engine's `process.run` from a script. `sleep` is the mock clock's: long polls wait on it. */
export function fakeOrchard(on: On, now: () => number, sleep: (ms: number) => Promise<void> = async () => {}): Fake {
  let wake: (() => void) | undefined
  let woken: Promise<void> = new Promise(resolve => (wake = resolve))
  const signal = () => woken
  const fake: Fake = {
    calls: [],
    opened: [],
    get isKnown() {
      return fake.registered.has(ME)
    },
    set isKnown(isKnown: boolean) {
      if (isKnown) fake.registered.add(ME)
      else fake.registered.delete(ME)
    },
    registered: new Set([ME, 'owner', 'claude-other']),
    lastContact: {},
    workspaceName: 'Fruit Stand',
    ownerId: 'owner',
    messages: [],
    alerts: new Map(),
    participants: [
      { id: 'owner', name: 'Nick' },
      { id: 'claude-other', name: 'Other Claude' },
      { id: ME, name: `Claude (Fruit Stand) · ${SID}` },
    ],
    acks: [],
    sent: [],
    channels: [
      { id: 'general', name: 'general' },
      { id: 'releases', name: 'releases' },
    ],
    taskStores: [{ id: 'store1', name: 'Fruit stand tasks' }],
    tasks: [],
    // The required plugins and Tasks are attached; State and Roles are not until a test attaches them.
    plugins: [
      { id: 'core', attached: true },
      { id: 'chat', attached: true },
      { id: 'tasks', attached: true },
      { id: 'state', attached: false },
      { id: 'roles', attached: false },
    ],
    declarations: [],
    markers: [],
    script: undefined,
    waiting: 0,
    hasDecisionsTool: false,
    push(partial, alert) {
      const message: FakeMessage = {
        sequence: (fake.messages.at(-1)?.sequence ?? 0) + 1,
        sender_id: 'owner',
        body: 'hello',
        destination: { kind: 'direct', id: ME },
        recipient_ids: [ME],
        sent_at: '2026-10-10T12:00:00Z',
        ...partial,
      }
      fake.messages.push(message)
      if (alert !== undefined) fake.alerts.set(message.id, { reasons: alert.reasons, message, channel: alert.channel ?? null })
      const previous = wake
      woken = new Promise(resolve => (wake = resolve))
      previous?.()
      return message
    },
  }
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    if (argv[0] === 'open') {
      fake.opened.push(argv.slice(1).join(' '))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
    }
    const call: Call = {
      at: now(),
      argv,
      cmd: argv[2] ?? '',
      tool: argv[2] === 'call' ? (argv[3] ?? '') : (argv[2] ?? ''),
      env: { ...(e.init?.env ?? {}) },
      stdin: e.init?.stdin,
      timeoutMs: e.init?.timeoutMs,
    }
    fake.calls.push(call)
    const reply = (await fake.script?.(call, fake.calls.length)) ?? (await answer(fake, call, sleep, signal))
    if (reply === 'reject') throw new Error('timed out')
    return {
      value: {
        exitCode: reply.exitCode,
        stdout: reply.stdout ?? '',
        stderr: reply.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never
  })
  return fake
}

/** Answers `fs.exists` and `fs.read` from a map and records every path read. */
export function stubFiles(on: On, files: Record<string, string>): { reads: string[] } {
  const reads: string[] = []
  on('fs.exists', async (_$, e) => ({ value: e.path in files }) as never)
  on('fs.read', async (_$, e) => {
    reads.push(e.path)
    const body = files[e.path]
    if (body === undefined) throw new Error('ENOENT')
    return { value: body } as never
  })
  return { reads }
}

/** The plugin's `$.store` in memory, readable and writable by the test; `writes` records every set. */
export function stubStore(on: On, entries: Record<string, unknown> = {}): { data: Map<string, unknown>; writes: { key: string; value: unknown }[]; fail: { set: boolean } } {
  const data = new Map<string, unknown>(Object.entries(entries))
  const writes: { key: string; value: unknown }[] = []
  const clone = (value: unknown) => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown))
  on('store.get', async (_$, e) => ({ value: clone(data.get(e.key)) }) as never)
  const fail = { set: false }
  on('store.set', async (_$, e) => {
    if (fail.set) throw new Error('the store is full')
    data.set(e.key, clone(e.value))
    writes.push({ key: e.key, value: clone(e.value) })
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    data.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...data.keys()] }) as never)
  return { data, writes, fail }
}

/** How `$.ui.notify` answers in a test: sent by a channel, or refused for the reason named (`denied`: it rejects). */
export type NotifyMode = 'sent' | 'no-surface' | 'refused' | 'denied'

/** One call of a sink the plugin wrote to: which, and the text it was given (undefined: a status cleared). */
export type SinkEvent = { name: string; text: string | undefined }

/**
 * Records everything the plugin shows or says outside the band: toasts, logs, status, notices,
 * notifications. `events` has them by name; `notify.mode` is what `$.ui.notify` answers (the
 * desktop has no surface to notify: `no-surface`).
 */
export function watchSinks(on: On): { seen: string[]; events: SinkEvent[]; notify: { mode: NotifyMode } } {
  const seen: string[] = []
  const events: SinkEvent[] = []
  const notify: { mode: NotifyMode } = { mode: 'sent' }
  // One recorder for several events: `on` is typed per event name, so it is loosened here.
  const any = on as unknown as (name: string, hook: (_$: unknown, e: unknown) => Promise<unknown>) => unknown
  for (const name of ['ui.toast', 'ui.log', 'ui.status', 'ui.notice', 'ui.notify']) {
    any(name, async (_$, e) => {
      seen.push(JSON.stringify(e))
      events.push({ name, text: (e as { text?: string }).text })
      if (name !== 'ui.notify') return { value: undefined }
      if (notify.mode === 'denied') return { deny: 'a hook refused the notification' }
      return { value: notify.mode === 'sent' ? { isSent: true, channel: 'ghostty' } : { isSent: false, reason: notify.mode } }
    })
  }
  return { seen, events, notify }
}
