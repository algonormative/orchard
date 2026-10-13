// What the tests share: the mock clock, the fake CLI, files, an in-memory store and the
// engine's own pieces beneath the plugin (the prompt box, the prompt queue). Not a test file.
import type { AgentInfo, On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CWD, SECRETS, SESSION_ID, fakeOrchard, stubFiles, stubStore, watchSinks } from './fake-orchard'

/** How often a held wake looks at the prompt box again (the mod's own constant, written out: a test should not follow it). */
export const HELD_RECHECK_MS = 15_000

export const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never

/**
 * The test's `$` has no `state` noun, so the mod's state is watched from beneath: the
 * latest value written under each key, `override` to stand in for a value the mod would
 * have written, `seed` for a value the mod finds the first time it reads the key (what
 * the host kept across a reload), after which reads are the engine's own again, and
 * `refuse` to make the next write of one key fail (a host that refuses a write).
 */
export function tapState(on: On) {
  const latest: Record<string, unknown> = {}
  /** How many times each key was written: an idle session must write none. */
  const writes: Record<string, number> = {}
  const override: Record<string, unknown> = {}
  const seed: Record<string, unknown> = {}
  const refuse: { key: string | undefined } = { key: undefined }
  type Hook = (_$: unknown, e: { plugin: string; key: string; value?: unknown }, next: (e: never) => Promise<unknown>) => Promise<unknown>
  const loose = on as unknown as (name: string, hook: Hook) => unknown
  loose('state.set', async (_$, e, next) => {
    if (e.plugin === 'orchard' && e.key === refuse.key) {
      refuse.key = undefined
      return { deny: 'the host refused the write' }
    }
    if (e.plugin === 'orchard') {
      latest[e.key] = e.value
      writes[e.key] = (writes[e.key] ?? 0) + 1
    }
    return next(e as never)
  })
  loose('state.get', async (_$, e, next) => {
    if (e.plugin === 'orchard' && e.key in seed) {
      const value = seed[e.key]
      delete seed[e.key]
      return { value: { value, version: 1 } }
    }
    return e.plugin === 'orchard' && e.key in override ? { value: { value: override[e.key], version: 1 } } : next(e as never)
  })
  return { latest, writes, override, seed, refuse }
}

export type Submit = {
  text: string
  context: readonly string[] | undefined
  origin: unknown
  /** Acknowledgements the workspace had received, and `$.store` writes made, when the prompt came in. */
  acksSeen: number
  storeWritesSeen: number
}

export type WorldOptions = {
  files?: Record<string, string>
  /** What `$.store` holds at the start. */
  store?: Record<string, unknown>
  /** What `$.session.id()` answers (default SESSION_ID); `null` makes it fail. */
  sessionId?: string | null
}

/** Everything a test needs around the plugin: clock, fake CLI, files, store, sinks, the prompt queue and box. */
export function world(on: On, options: WorldOptions = {}) {
  // Every 15 s `$.clock.after` (the held-wake recheck) the plugin asked for, and whether it has fired or been
  // cancelled (a cancel aborts its dispatch). Registered before the mock clock: that answers a timer itself and
  // never hands it on to a hook registered after it.
  const timers: { ms: number; isDone: boolean; isCancelled: boolean }[] = []
  on('clock.after', { ms: HELD_RECHECK_MS }, async (_$, e, next) => {
    const timer = { ms: e.ms, isDone: false, isCancelled: false }
    timers.push(timer)
    next.signal.addEventListener('abort', () => (timer.isCancelled = true))
    try {
      return await next(e)
    } finally {
      timer.isDone = true
    }
  })
  const clock = mock.clock(on)
  const fake = fakeOrchard(on, () => clock.now(), ms => clock.sleep(ms))
  const fs = stubFiles(on, options.files ?? {})
  const store = stubStore(on, options.store)
  const sinks = watchSinks(on)
  const session = mock.session(on)
  const state = tapState(on)

  // The prompt box and the prompt queue, as the engine would answer them. `hold` keeps a read of the box waiting.
  // `reads` counts the looks at the box; `gate` keeps the person's own prompt waiting inside the prompt queue.
  const box: { text: string; hold: Promise<void> | undefined; reads: number } = { text: '', hold: undefined, reads: 0 }
  const gate: { person: Promise<void> | undefined } = { person: undefined }
  const submits: Submit[] = []
  const submit: { mode: 'accept' | 'drop' | 'throw'; hold: Promise<void> | undefined } = { mode: 'accept', hold: undefined }
  on('prompt.read', async () => {
    box.reads += 1
    await box.hold
    return { value: { text: box.text, cursor: box.text.length } } as never
  })
  on('prompt.submit', async (_$, e) => {
    submits.push({ text: e.text, context: e.context, origin: e.origin, acksSeen: fake.acks.length, storeWritesSeen: store.writes.length })
    if (e.origin?.kind === 'composer') await gate.person
    // A plugin's prompt queued behind a running turn: the call stays pending until that turn is over and its own starts.
    if (e.origin?.kind === 'plugin') await submit.hold
    if (submit.mode === 'throw') throw new Error('the prompt queue is gone')
    if (submit.mode === 'drop') return { drop: 'a hook refused the prompt' }
    return { text: e.text, context: e.context }
  })
  on('session.cwd', async () => ({ value: CWD }) as never)
  on('session.id', async () => {
    if (options.sessionId === null) throw new Error('no session id')
    return { value: options.sessionId ?? SESSION_ID } as never
  })
  // The tools the plugin registers, the panes it opens and the drafts it fills.
  const registered: { name: string; description: string; inputSchema: unknown; isDeferred?: boolean }[] = []
  on('tool.register', async (_$, e) => {
    registered.push(e as never)
    return { value: { tool: `mcp__orchard__${e.name}` } } as never
  })
  const opened: { id: string; title?: string; focus?: true }[] = []
  // The panes the plugin has open, as `$.ui.panes()` lists them, and what it copied to the clipboard.
  const panes: string[] = []
  const copied: { text: string; surface: unknown }[] = []
  // What `$.ui.open` answers: a window with room places the pane, one without leaves it waiting.
  const place: { isPlaced: boolean } = { isPlaced: true }
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, title: e.title, focus: e.focus })
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: place.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'the window is too narrow' } } as never
  })
  on('ui.panes', async () => ({ value: panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }) as never)
  on('ui.close', async (_$, e) => {
    const at = panes.indexOf(e.id)
    if (at >= 0) panes.splice(at, 1)
    return {} as never
  })
  on('ui.copy', async (_$, e) => {
    copied.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } } as never
  })
  // The engine's agents: a spawn starts one that `$.agent.list()` then shows, until a test changes its status or removes it.
  const agents: { list: AgentInfo[]; spawns: string[]; lists: number; deny: string | undefined } = { list: [], spawns: [], lists: 0, deny: undefined }
  on('agent.spawn', async (_$, e) => {
    if (agents.deny !== undefined) return { deny: agents.deny }
    const agentId = `agent-${agents.spawns.length + 1}`
    agents.spawns.push(agentId)
    agents.list.push({ id: agentId, description: e.description, type: e.subagentType, status: 'running' })
    return { model: 'sonnet', agentId }
  })
  on('agent.list', async () => {
    agents.lists += 1
    return { value: agents.list.map(a => ({ ...a })) } as never
  })
  // Stand in for what the engine returns beneath the plugin.
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }) as never)
  // A band another mod draws beneath the plugin's, when a test sets one.
  const below: { band: string | undefined } = { band: undefined }
  on('ui.render', async ($$, e) => {
    const { Box, Text } = $$.ui.resolve(e)
    if (e.component === 'AbovePrompt' && below.band !== undefined) {
      return (
        <Box>
          <Text>{below.band}</Text>
        </Box>
      )
    }
    return <Box />
  })
  return { clock, timers, fake, fs, store, sinks, session, state, box, gate, submits, submit, registered, opened, panes, copied, place, below, agents }
}

export type World = ReturnType<typeof world>

export async function begin($: Engine, w: World) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

export async function bandText($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props: unknown = BAND_PROPS) {
  const ui = await $.ui.mount({ plugin: 'orchard', surface, component: 'AbovePrompt', props: props as never })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  return texts.length === 0 ? undefined : texts.join('')
}

/** Every string the mod leaves where a person or the model could read it. */
export async function visible($: Engine, w: World): Promise<string[]> {
  return [
    (await bandText($, 'terminal')) ?? '',
    (await bandText($, 'desktop')) ?? '',
    ...w.sinks.seen,
    ...w.submits.map(s => JSON.stringify(s)),
    JSON.stringify(w.session.appended()),
    // The feed, the plugins' items and the message being handled are drawn for the person (their links carry the workspace address), never shown to the model.
    JSON.stringify({ ...w.state.latest, activity: undefined, plugins: undefined, now: undefined }),
  ]
}

export function expectNoSecrets(texts: readonly string[]) {
  for (const text of texts) {
    for (const secret of SECRETS) expect(text.includes(secret)).toBe(false)
  }
}

export const resumes = (w: World) => w.fake.calls.filter(c => c.cmd === 'resume')
/** Calls other than the listener's own polling and bookkeeping. */
export const connectionCalls = (w: World) =>
  w.fake.calls.filter(
    c => !['alerts', 'ack'].includes(c.cmd) && !['mail_history', 'mail_participants', 'workspace_decisions', 'tasks_list', 'plugin_call', 'state_list'].includes(c.tool),
  )

/** The model calling one of the plugin's tools. */
export function callTool($: Engine, name: string, input: Record<string, unknown> = {}) {
  return $.tool.call({ ...input, tool: `mcp__orchard__${name}` } as never) as Promise<{ result?: unknown; deny?: string; text?: string; isError?: boolean }>
}

/** What a person's Enter raises at `prompt.submit`. */
export function typed(text: string) {
  return { text, wait: false, origin: { kind: 'composer' as const } }
}
