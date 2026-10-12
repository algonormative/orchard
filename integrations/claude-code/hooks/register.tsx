// Every use of `$` is in this file: `claude plugin validate` follows `$` only into
// functions declared in the hooks module's own file, never across an import. The
// modules beside it are pure and take ports (see orchard-cli.ts's `Run`).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OrchardAlert, OrchardPane, OrchardPaneThread, OrchardQueue, OrchardSettings, OrchardStatus } from '../types'
import {
  ALERTS_TIMEOUT_MS,
  EMPTY_QUEUE,
  SHORT_WAIT_MS,
  WAIT_SECONDS,
  addToQueue,
  countsOf,
  isQueueFull,
  parseAlertsPage,
  parseStoreRecord,
  queueScope,
  recordDelivery,
  removeFromQueue,
  retainInQueue,
  scopedQueue,
  storeKey,
  takeBatch,
  wakeDueAt,
} from './alerts'
import type { AlertsPage } from './alerts'
import { bandLine } from './band'
import type { BandTone } from './band'
import { CLAIM_RECHECK_MS, LEASE_BEAT_MS, LEASE_RECHECK_MS, RECENT_KEY, inflightKey, isHeldByOther, leaseKey, liveClaims, parseClaims, parseLease, parseRecent, planEviction, withoutIds } from './lease'
import { DEFAULT_SETTINGS, addParticipation, classify, isLevel, parseParticipation, parseSettings, participationKey, settingsKey } from './classify'
import { checkConn, parseProjectFile, PROJECT_FILE, readOptions, resolveIdentity } from './config'
import type { Options, Parsed, ProjectOverrides } from './config'
import { backoffDelay, connectOnce, createRuntime, track } from './connect'
import type { Runtime } from './connect'
import { frameData, frameMessages, newNonce } from './frame'
import type { FrameMessage } from './frame'
import { HISTORY_WINDOW, openDecisions, parseHistory, parentsOf, participationFrom, rootOf } from './history'
import type { HistoryMessage } from './history'
import { RETRY_ID_TTL_MS, createListenerState, deliveryNote, heldNotice, heldStatusLine, stopLoop, toFrameMessage } from './listener'
import type { ListenerState, Loop } from './listener'
import { NOTIFY_USAGE, applyNotify, describeSettings, parseNotify, parseRate } from './notify'
import { EXIT_CONNECTION, EXIT_OK, runOrchard, workspaceIdOf } from './orchard-cli'
import type { CliInit, CliResult, Run } from './orchard-cli'
import { renderPane } from './pane'
import type { PaneHandlers, Table } from './pane'
import { buildThreads, messageHref, snippetOf, taskHref, workspaceHref } from './threads'
import {
  RETRY_ADVICE,
  RETRY_OWN_ID,
  TOOL_SPECS,
  UNREACHABLE,
  fingerprint,
  makeRequestId,
  parseAck,
  parseCall,
  parseHistoryInput,
  parseReply,
  parseSend,
  pinActor,
  replyDestination,
  scrubSecrets,
  withoutJoiningPrompt,
  MUTATING_CALLS,
} from './tools'

// The values the band draws from, held by the host for the session so a hot reload keeps
// them. Declared here because the validator reads state references only from this file.
const status = atom({ plugin: 'orchard', key: 'status' } as const, null)
const workspace = atom({ plugin: 'orchard', key: 'workspace' } as const, null)
const counts = atom({ plugin: 'orchard', key: 'counts' } as const, { unread: 0, forYou: 0, needsYou: 0 })
// Bumped by every listener start; a loop whose generation is not the current one stops.
const generation = atom({ plugin: 'orchard', key: 'generation' } as const, 0)
// Alerts fetched and not yet delivered. In state, not in a variable, so a hot reload keeps them.
const queue = atom({ plugin: 'orchard', key: 'queue' } as const, EMPTY_QUEUE)
// The notification settings (kept in $.store too) and what the /orchard pane draws.
const settings = atom({ plugin: 'orchard', key: 'settings' } as const, DEFAULT_SETTINGS)
const pane = atom({ plugin: 'orchard', key: 'pane' } as const, null)

const PANE = 'orchard'

/** How long past its due time a loop may be silent before the liveness guard calls it dead. */
const GUARD_SLACK_MS = 120_000

/** How often a listener that holds back for a full queue looks again whether a delivery has made room. */
const BACKPRESSURE_RECHECK_MS = 5_000

/** How often a wake held back by a draft in the prompt box looks at the box again. */
const HELD_RECHECK_MS = 15_000

/** What every function below shares: the connection, the listener and the options. */
type App = { rt: Runtime; ls: ListenerState; options: Options }

/** Runs a promise nobody awaits so a failure in it is a dropped detail, not an unhandled rejection. */
function detach(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

/** `$.process.run` as a port; every CLI call of the mod goes through the one this makes. */
function runner($: EngineInterface): Run {
  return (argv, init) => $.process.run(argv, init)
}

/** One CLI call as the connected participant. Any exit 0 resets the connection backoff. */
async function cli($: EngineInterface, rt: Runtime, args: readonly string[], init: CliInit = {}): Promise<CliResult> {
  const here = rt.current
  if (here === undefined) return { exitCode: 2, message: 'Orchard is not connected' }
  const scrub = [here.identity.participantId, ...(init.scrub ?? [])]
  return track(rt, await runOrchard(runner($), here.conn, args, { ...init, scrub }))
}

/** `call TOOL stdin` with the arguments as JSON. */
function tool($: EngineInterface, rt: Runtime, name: string, args: Record<string, unknown>, init: CliInit = {}): Promise<CliResult> {
  return cli($, rt, ['call', name, 'stdin'], { ...init, stdin: JSON.stringify(args) })
}

async function setStatus($: EngineInterface, next: OrchardStatus) {
  await update($, status, () => next)
}

/** What the queue is stamped with: a digest of this connection's (endpoint, participant). */
function scopeOf(app: App): string | undefined {
  const here = app.rt.current
  return here === undefined ? undefined : queueScope(here.conn.endpoint, here.identity.participantId)
}

/**
 * The pending alerts of this connection. The queue atom outlives a reload, and a reload can
 * come back pointed at another workspace or participant: what it holds then is not this
 * connection's, reads as empty, and is never delivered, acknowledged or counted.
 */
async function readQueue($: EngineInterface, app: App): Promise<OrchardQueue> {
  const scope = scopeOf(app)
  const held = await read($, queue)
  return scope === undefined ? EMPTY_QUEUE : scopedQueue(held, scope)
}

/** Changes this connection's queue (another's is replaced by an empty one first). */
function updateQueue($: EngineInterface, app: App, change: (held: OrchardQueue) => OrchardQueue): Promise<OrchardQueue> {
  const scope = scopeOf(app)
  return update($, queue, held => (scope === undefined ? held : change(scopedQueue(held, scope))))
}

/** Records a failed attempt and arms the next retry. The alert listener calls this too. */
export async function markOffline($: EngineInterface, app: App) {
  const { rt } = app
  rt.failures += 1
  rt.timer?.cancel()
  rt.timer = $.clock.after(backoffDelay(rt.failures), () => {
    detach(reconnect($, app))
  })
  await setStatus($, { kind: 'offline', failures: rt.failures })
}

/** One attempt: resume or join, then learn the workspace. A call during an attempt is ignored. */
export async function reconnect($: EngineInterface, app: App) {
  const { rt } = app
  const here = rt.current
  if (here === undefined || rt.isAttempting) return
  rt.isAttempting = true
  rt.timer?.cancel()
  rt.timer = undefined
  try {
    const outcome = await connectOnce(runner($), rt, here)
    if (outcome.kind === 'connected') {
      await update($, workspace, () => outcome.workspace)
      await setStatus($, connectedStatus(app.ls))
      detach(startListener($, app))
    } else if (outcome.kind === 'offline') {
      await markOffline($, app)
    } else {
      await setStatus($, { kind: 'error', message: outcome.message })
    }
  } catch {
    await setStatus($, { kind: 'error', message: 'the Orchard connection failed unexpectedly' })
  } finally {
    rt.isAttempting = false
  }
}

async function readProject($: EngineInterface, cwd: string): Promise<Parsed<ProjectOverrides>> {
  const path = `${cwd.replace(/\/+$/, '')}/${PROJECT_FILE}`
  try {
    if (!(await $.fs.exists(path))) return { ok: true, value: {} }
    const body = await $.fs.read(path)
    return parseProjectFile(typeof body === 'string' ? body : '')
  } catch {
    return { ok: false, message: `${PROJECT_FILE} could not be read` }
  }
}

/** session.start (and `/orchard reconnect`): show the band, resolve who we are, make the first attempt. */
async function start($: EngineInterface, app: App, cwd: string) {
  const { rt, ls, options } = app
  ls.isStarted = true
  // A fresh start: nothing of an earlier attempt or loop may fire after this.
  rt.timer?.cancel()
  rt.timer = undefined
  rt.failures = 0
  ls.leaseTimer?.cancel()
  ls.leaseTimer = undefined
  stopLoop(ls, 'superseded')
  await setStatus($, { kind: 'connecting' })

  const conn = checkConn(options)
  if (!conn.ok) return setStatus($, { kind: 'error', message: conn.message })

  const project = await readProject($, cwd)
  if (!project.ok) return setStatus($, { kind: 'error', message: project.message })
  if (project.value.isIdIgnored && !ls.isIdToastShown) {
    ls.isIdToastShown = true
    $.ui.toast('Orchard: the participantId in .orchard.json must start with "claude-", so it was ignored')
  }

  const identity = resolveIdentity(options, cwd, project.value)
  if (!identity.ok) return setStatus($, { kind: 'error', message: identity.message })

  rt.current = { conn: conn.value, identity: identity.value }
  await reconnect($, app)
}

// ---- the alert listener ----

const wakeOf = (ls: ListenerState) => (alert: OrchardAlert) => classify(alert, ls.settings, ls.participationSet) === 'wake'

/** The loop is the current one: not stopped, not replaced, and no other start took the generation. */
async function isLive($: EngineInterface, ls: ListenerState, loop: Loop): Promise<boolean> {
  if (loop.isStopped) return false
  if (ls.loop !== loop || (await read($, generation)) !== loop.gen) {
    loop.isStopped = true
    loop.timer?.cancel()
    loop.timer = undefined
    return false
  }
  return true
}

async function syncCounts($: EngineInterface, app: App, needsYou?: number) {
  const pending = countsOf(await readQueue($, app), wakeOf(app.ls))
  await update($, counts, prev => ({ ...prev, ...pending, ...(needsYou === undefined ? {} : { needsYou }) }))
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

const connectedStatus = (ls: ListenerState): OrchardStatus => (ls.isStoreFailing ? { kind: 'connected', isStoreFailing: true } : { kind: 'connected' })

/** Writes to `$.store`. A failure does not stop delivery (the store is a backstop against replay) but the band says so. */
async function storeSet($: EngineInterface, app: App, key: string, value: unknown) {
  let isFailing = false
  try {
    await $.store.set(key, value)
  } catch {
    isFailing = true
  }
  const { ls } = app
  if (isFailing === ls.isStoreFailing) return
  ls.isStoreFailing = isFailing
  await update($, status, current => (current?.kind === 'connected' ? connectedStatus(ls) : current))
}

/** Reads the lease of this connection. */
async function readLease($: EngineInterface, endpoint: string, me: string) {
  return parseLease(await storeGet($, leaseKey(endpoint, me)))
}

/** The id this session holds the lease under: its session id, so a reload of the mod is still the same holder. */
async function leaseHolder($: EngineInterface, ls: ListenerState): Promise<string> {
  if (ls.leaseId === undefined) {
    try {
      ls.leaseId = await $.session.id()
    } catch {
      ls.leaseId = crypto.randomUUID()
    }
  }
  return ls.leaseId
}

/**
 * Takes or renews the lease for this (endpoint, participant). False: another session beat it
 * recently, so this one must not listen. Two sessions starting together can both write; the one
 * whose write lands first finds the other's at its next heartbeat and stands down.
 */
async function holdLease($: EngineInterface, app: App, isForced: boolean): Promise<boolean> {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return true
  const now = await $.clock.now()
  if (!isForced && now - ls.leaseBeatAt < LEASE_BEAT_MS) return true
  const { endpoint } = here.conn
  const me = here.identity.participantId
  const holder = await leaseHolder($, ls)
  if (isHeldByOther(await readLease($, endpoint, me), holder, now)) return false
  ls.leaseBeatAt = now
  await storeSet($, app, leaseKey(endpoint, me), { session: holder, at: now })
  return true
}

/** This session does not listen: another one does. The band says so, and a timer looks whether that session went away. */
async function standDown($: EngineInterface, app: App, loop: Loop) {
  const { ls } = app
  loop.isStopped = true
  loop.stopReason = 'shared'
  loop.timer?.cancel()
  loop.timer = undefined
  ls.watchdog?.cancel()
  ls.watchdog = undefined
  await setStatus($, { kind: 'shared' })
  ls.leaseTimer?.cancel()
  ls.leaseTimer = $.clock.after(LEASE_RECHECK_MS, () => {
    detach(recheckLease($, app))
  })
}

/** A read-only session looks again: once the other session's lease is stale, this one listens. */
async function recheckLease($: EngineInterface, app: App) {
  const { rt, ls } = app
  ls.leaseTimer = undefined
  const here = rt.current
  if (here === undefined || (await read($, status))?.kind !== 'shared') return
  const holder = await leaseHolder($, ls)
  if (isHeldByOther(await readLease($, here.conn.endpoint, here.identity.participantId), holder, await $.clock.now())) {
    ls.leaseTimer = $.clock.after(LEASE_RECHECK_MS, () => {
      detach(recheckLease($, app))
    })
    return
  }
  await setStatus($, connectedStatus(ls))
  detach(startListener($, app))
}

/**
 * Ids this session must not hand to the model now: another module instance of this participant
 * (a reinstall, a reload) has them in a delivery that has not resolved, or has delivered them
 * (the stored record knows, this instance's memory does not). Alerts already delivered are
 * dropped from this instance's queue.
 */
async function blockedIds($: EngineInterface, app: App, q: OrchardQueue): Promise<Set<string>> {
  const { rt, ls } = app
  const here = rt.current
  const blocked = new Set<string>(ls.inFlight)
  if (here === undefined) return blocked
  const { endpoint } = here.conn
  const me = here.identity.participantId
  const now = await $.clock.now()
  for (const claim of liveClaims(parseClaims(await storeGet($, inflightKey(endpoint, me))), now)) {
    if (claim.owner !== ls.instanceId) for (const id of claim.ids) blocked.add(id)
  }
  const done = new Set(parseStoreRecord(await storeGet($, storeKey(endpoint, me)))?.delivered ?? [])
  const gone = q.items.filter(a => done.has(a.id)).map(a => a.id)
  if (gone.length > 0) {
    await updateQueue($, app, cur => removeFromQueue(cur, gone, 0))
    await syncCounts($, app)
  }
  for (const id of gone) blocked.add(id)
  return blocked
}

/** Writes (`ids` given) or clears this instance's claim on a delivery, before the submit and after it resolves. */
async function setClaim($: EngineInterface, app: App, ids: readonly string[], isClaiming: boolean) {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return
  const key = inflightKey(here.conn.endpoint, here.identity.participantId)
  const now = await $.clock.now()
  const claims = liveClaims(parseClaims(await storeGet($, key)), now)
  const next = isClaiming ? [...claims, { owner: ls.instanceId, at: now, ids: [...ids] }] : withoutIds(claims, ls.instanceId, ids)
  if (next.length === 0) {
    try {
      await $.store.delete(key)
    } catch {
      // A claim left behind expires on its own.
    }
    return
  }
  await storeSet($, app, key, next)
}

/** session.end: let go of the lease so the next session of this participant listens at once, not after it goes stale. */
async function releaseLease($: EngineInterface, app: App) {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined || ls.leaseId === undefined) return
  const key = leaseKey(here.conn.endpoint, here.identity.participantId)
  const held = parseLease(await storeGet($, key))
  if (held?.session !== ls.leaseId) return
  stopLoop(ls, 'offline')
  ls.watchdog?.cancel()
  ls.watchdog = undefined
  ls.leaseTimer?.cancel()
  ls.leaseTimer = undefined
  try {
    await $.store.delete(key)
  } catch {
    // The lease then goes stale on its own.
  }
}

/** Marks this record used and forgets the least recently used ones past the cap. */
async function touchRecords($: EngineInterface, app: App, endpoint: string, me: string) {
  try {
    const plan = planEviction(await $.store.keys(), parseRecent(await storeGet($, RECENT_KEY)), { endpoint, participantId: me }, await $.clock.now())
    for (const key of plan.evict) await $.store.delete(key)
    await storeSet($, app, RECENT_KEY, plan.index)
  } catch {
    // Housekeeping: a store that will not list or delete is the write failure the band already reports.
  }
}

/** Display names by participant id; asks the directory only for ids it has not seen, at most every 30 s. */
async function ensureNames($: EngineInterface, app: App, ids: readonly string[]) {
  const { rt, ls } = app
  if (ids.every(id => ls.names.has(id))) return
  const now = await $.clock.now()
  if (ls.namesAt !== undefined && now - ls.namesAt < 30_000) return
  ls.namesAt = now
  const result = await tool($, rt, 'mail_participants', {})
  if (result.exitCode !== EXIT_OK) return
  const participants = (result.json as { participants?: unknown } | undefined)?.participants
  if (!Array.isArray(participants)) return
  for (const p of participants as { id?: unknown; name?: unknown }[]) {
    if (typeof p.id === 'string' && typeof p.name === 'string') ls.names.set(p.id, p.name)
  }
}

/** Adds ids to the participation set (memory and store). */
async function noteParticipation($: EngineInterface, app: App, ids: readonly string[]) {
  const { rt, ls } = app
  const here = rt.current
  const have = new Set(ls.participation)
  const fresh = ids.filter(id => !have.has(id))
  if (here === undefined || fresh.length === 0) return
  ls.participation = addParticipation(ls.participation, fresh)
  ls.participationSet = new Set(ls.participation)
  await storeSet($, app, participationKey(here.conn.endpoint, here.identity.participantId), ls.participation)
}

type Window = { kind: 'ok'; messages: HistoryMessage[] } | { kind: 'offline' } | { kind: 'failed'; message: string }

/** The newest window of history: seeds the cursor, the participation set and the needs-you count. */
async function readWindow($: EngineInterface, app: App): Promise<Window> {
  const result = await tool($, app.rt, 'mail_history', { latest: true, limit: HISTORY_WINDOW })
  if (result.exitCode === EXIT_CONNECTION) return { kind: 'offline' }
  if (result.exitCode !== EXIT_OK) return { kind: 'failed', message: result.message ?? 'the Orchard CLI failed' }
  return { kind: 'ok', messages: parseHistory(result.json) }
}

/**
 * The decisions this participant raised that the owner has not answered, as the host counts them
 * over the whole history (`workspace_decisions`). Undefined when the host cannot say (it has no
 * such tool, or the call failed): the caller then reconstructs from the history window. A tool
 * error is taken to mean an older host and remembered for the connection; a lost connection is not.
 */
async function countOpenDecisions($: EngineInterface, app: App, me: string): Promise<number | undefined> {
  const { ls } = app
  if (ls.decisionsTool === 'missing') return undefined
  const result = await tool($, app.rt, 'workspace_decisions', { sender_id: me })
  if (result.exitCode === EXIT_OK) {
    const decisions = (result.json as { decisions?: unknown } | undefined)?.decisions
    if (Array.isArray(decisions)) {
      ls.decisionsTool = 'available'
      return decisions.length
    }
  }
  if (result.exitCode !== EXIT_CONNECTION) ls.decisionsTool = 'missing'
  return undefined
}

async function applyWindow($: EngineInterface, app: App, messages: readonly HistoryMessage[]) {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return
  const me = here.identity.participantId
  await noteParticipation($, app, participationFrom(messages, me))
  const owner = (await read($, workspace))?.ownerId ?? 'owner'
  await syncCounts($, app, (await countOpenDecisions($, app, me)) ?? openDecisions(messages, me, owner).length)
  ls.decisionsAt = await $.clock.now()
}

/** Re-reads the open decisions: not more than every 15 s, one read at a time. */
async function refreshDecisions($: EngineInterface, app: App) {
  const { ls } = app
  if (ls.isReadingDecisions) return
  const now = await $.clock.now()
  if (ls.decisionsAt !== undefined && now - ls.decisionsAt < 15_000) return
  ls.isReadingDecisions = true
  try {
    const window = await readWindow($, app)
    if (window.kind === 'ok') await applyWindow($, app, window.messages)
  } catch {
    // Counting decisions is a convenience; it must not stop the listener.
  } finally {
    ls.isReadingDecisions = false
  }
}

/** (Re)starts the alert loop under a new generation. Never two live loops for one generation. */
export async function startListener($: EngineInterface, app: App) {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined || ls.isStarting) return
  ls.isStarting = true
  try {
    stopLoop(ls, 'superseded')
    const gen = await update($, generation, g => g + 1)
    const loop: Loop = { gen, timer: undefined, isPolling: false, isStopped: false, expectedBy: 0, stopReason: undefined }
    ls.loop = loop
    loop.expectedBy = (await $.clock.now()) + ALERTS_TIMEOUT_MS + GUARD_SLACK_MS
    await armWatchdog($, app, loop)
    if (await prepare($, app, loop)) {
      await schedule($, app, loop, 0)
      await armFlush($, app)
    }
  } catch {
    if (ls.loop !== undefined) await loopDied($, app, ls.loop, 'crashed')
  } finally {
    ls.isStarting = false
  }
}

/**
 * A loop that died on its own (an exception, or no movement by its due time) while the session
 * still says it is connected. The band would draw nothing and nothing would be listening, so the
 * session goes offline and reconnects, which starts a new loop; the more loops die in a row, the
 * longer it waits. A loop another one has replaced leaves that to its replacement.
 */
async function loopDied($: EngineInterface, app: App, loop: Loop, reason: 'crashed' | 'stalled') {
  const { rt, ls } = app
  loop.isStopped = true
  loop.stopReason ??= reason
  loop.timer?.cancel()
  loop.timer = undefined
  if (ls.loop !== loop) return
  ls.watchdog?.cancel()
  ls.watchdog = undefined
  ls.crashes += 1
  // `track` zeroes the failure count whenever a call succeeds (the reconnect's own do), so the
  // wait is carried by the loops that died, not by the calls that failed.
  rt.failures = Math.max(rt.failures, ls.crashes - 1)
  try {
    await markOffline($, app)
  } catch {
    // Offline is a courtesy to the band; the next prompt's liveness guard is still there.
  }
}

/** Arms the watchdog for the time the loop is due to have moved by. */
async function armWatchdog($: EngineInterface, app: App, loop: Loop) {
  const { ls } = app
  ls.watchdog?.cancel()
  const now = await $.clock.now()
  ls.watchdog = $.clock.after(Math.max(5_000, loop.expectedBy - now + 1_000), () => {
    detach(watchdog($, app, loop))
  })
}

/**
 * The loop's due time came. A loop that has moved since is left alone (the watchdog looks again
 * at its new due time); one that has not is stalled, a hung call or a lost timer, and restarted
 * without waiting for the person's next prompt, which an idle session may not have for hours.
 */
async function watchdog($: EngineInterface, app: App, loop: Loop) {
  const { rt, ls } = app
  ls.watchdog = undefined
  // Replaced or stopped: whatever stopped it (offline, an error, a reconnect) decides what is next.
  if (ls.loop !== loop || loop.isStopped) return
  if (rt.isAttempting || ls.isStarting || (await read($, status))?.kind !== 'connected') return armWatchdog($, app, loop)
  if ((await $.clock.now()) < loop.expectedBy) return armWatchdog($, app, loop)
  await loopDied($, app, loop, 'stalled')
}

/**
 * Loads what the listener keeps in `$.store` and reads one history window. Returns
 * whether the loop may run: false after a connection failure (the retry restarts it) or a
 * workspace error (stopped until `/orchard reconnect`).
 */
async function prepare($: EngineInterface, app: App, loop: Loop): Promise<boolean> {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return false
  // The status line outlives a reload: one an earlier instance pinned for a hold would stay up
  // for good. The first listener of this instance unpins it (this instance is not holding yet).
  if (!ls.isStatusSwept && !ls.isHeld) {
    ls.isStatusSwept = true
    pin($, undefined)
  }
  const { endpoint } = here.conn
  const me = here.identity.participantId
  const scope = queueScope(endpoint, me)
  // A new connection may be a different host: ask again whether it has `workspace_decisions`.
  ls.decisionsTool = 'unknown'

  // One session at a time listens as a participant: a second would wake on the same message,
  // answer it twice, and overwrite the first one's cursor.
  if (!(await holdLease($, app, true))) {
    await standDown($, app, loop)
    return false
  }
  await touchRecords($, app, endpoint, me)

  const stored = parseStoreRecord(await storeGet($, storeKey(endpoint, me)))
  ls.settings = parseSettings(await storeGet($, settingsKey(endpoint, me)))
  await update($, settings, () => ls.settings)
  ls.participation = parseParticipation(await storeGet($, participationKey(endpoint, me)))
  ls.participationSet = new Set(ls.participation)
  if (stored !== undefined) ls.record = stored
  // A queue left by another connection (a reload that changed the workspace or participant) is
  // not this one's: start empty, so none of its alerts is delivered or acknowledged here and
  // its cursor cannot become this connection's fetch cursor.
  const held = await read($, queue)
  if (held.scope !== scope) await update($, queue, () => ({ ...EMPTY_QUEUE, scope }))
  const pending = scopedQueue(held, scope)
  ls.fetchCursor = Math.max(ls.record.cursor, pending.items.length > 0 ? pending.cursor : 0)
  ls.hasMore = false

  const window = await readWindow($, app)
  if (!(await isLive($, ls, loop))) return false
  if (window.kind === 'offline') {
    loop.isStopped = true
    loop.stopReason = 'offline'
    await markOffline($, app)
    return false
  }
  if (window.kind === 'failed') {
    // Without a stored cursor there is nothing safe to seed from.
    if (stored === undefined) {
      loop.isStopped = true
      loop.stopReason = 'error'
      await setStatus($, { kind: 'error', message: window.message })
      return false
    }
  } else {
    if (stored === undefined) {
      // No stored cursor: start from now. `--after 0` would replay the whole history.
      ls.record = { cursor: Math.max(0, ...window.messages.map(m => m.sequence)), delivered: [] }
      ls.fetchCursor = Math.max(ls.fetchCursor, ls.record.cursor)
      await storeSet($, app, storeKey(endpoint, me), ls.record)
    }
    await applyWindow($, app, window.messages)
  }
  await syncCounts($, app)
  return true
}

async function schedule($: EngineInterface, app: App, loop: Loop, delayMs: number) {
  const now = await $.clock.now()
  if (loop.isStopped) return
  loop.timer?.cancel()
  loop.expectedBy = now + delayMs + ALERTS_TIMEOUT_MS + GUARD_SLACK_MS
  loop.timer = $.clock.after(delayMs, () => {
    detach(tick($, app, loop))
  })
}

/** One iteration: retry owed acks, ask for alerts, absorb the page, schedule the next. */
async function tick($: EngineInterface, app: App, loop: Loop) {
  const { rt, ls } = app
  loop.timer = undefined
  const here = rt.current
  if (here === undefined || !(await isLive($, ls, loop))) return
  loop.isPolling = true
  try {
    loop.expectedBy = (await $.clock.now()) + ALERTS_TIMEOUT_MS + GUARD_SLACK_MS
    if (!(await holdLease($, app, false))) {
      await standDown($, app, loop)
      return
    }
    await retryAcks($, app)
    // A queue full of alerts that all wake a session has nowhere to put more: leave them on the
    // server (the cursor does not move) and look again once a delivery has made room.
    if (isQueueFull(await readQueue($, app), wakeOf(ls))) {
      if (await isLive($, ls, loop)) await schedule($, app, loop, BACKPRESSURE_RECHECK_MS)
      return
    }
    const isWaiting = !ls.hasMore
    const args = ['alerts', '--participant-id', here.identity.participantId, '--after', String(ls.fetchCursor), '--channels']
    if (isWaiting) args.push('--wait', String(WAIT_SECONDS))
    const before = await $.clock.now()
    const result = await cli($, rt, args, { timeoutMs: ALERTS_TIMEOUT_MS })
    // A call that outlived its generation (a reload, a restart) drops its result.
    if (!(await isLive($, ls, loop))) return
    const elapsed = (await $.clock.now()) - before

    if (result.exitCode === EXIT_CONNECTION) {
      loop.isStopped = true
      loop.stopReason = 'offline'
      await markOffline($, app)
      return
    }
    if (result.exitCode !== EXIT_OK) {
      loop.isStopped = true
      loop.stopReason = 'error'
      await setStatus($, { kind: 'error', message: result.message ?? 'the Orchard CLI failed' })
      return
    }
    const delay = await absorb($, app, loop, result, isWaiting, elapsed)
    ls.crashes = 0
    const polledAt = await $.clock.now()
    await update($, counts, prev => ({ ...prev, lastPollAt: polledAt }))
    if (await isLive($, ls, loop)) await schedule($, app, loop, delay)
  } catch {
    await loopDied($, app, loop, 'crashed')
  } finally {
    loop.isPolling = false
  }
}

/** Takes one page into the queue; answers how long to wait before the next call. */
async function absorb($: EngineInterface, app: App, loop: Loop, result: CliResult, isWaiting: boolean, elapsed: number): Promise<number> {
  const { ls } = app
  const now = await $.clock.now()
  const page: AlertsPage | undefined = parseAlertsPage(result.json, now, id => app.ls.names.get(id) ?? null)
  const remainder = WAIT_SECONDS * 1000 - elapsed
  if (page === undefined) return isWaiting && elapsed < SHORT_WAIT_MS ? remainder : 5_000

  const cursor = Math.max(ls.fetchCursor, page.nextCursor ?? ls.fetchCursor)
  const isAdvanced = cursor > ls.fetchCursor

  const unnamed = page.alerts.filter(a => a.senderName === null).map(a => a.senderId)
  if (unnamed.length > 0) {
    await ensureNames($, app, unnamed)
    for (const alert of page.alerts) alert.senderName ??= ls.names.get(alert.senderId) ?? null
  }
  if (!(await isLive($, ls, loop))) return 0

  // Replies in a thread this participant is in extend the set, so the next reply is one too.
  const kept: OrchardAlert[] = []
  const joined: string[] = []
  for (const alert of page.alerts) {
    if (alert.reasons.includes('reply') || (alert.threadId !== null && ls.participationSet.has(alert.threadId))) {
      joined.push(alert.id)
      ls.participationSet.add(alert.id)
    }
    if (classify(alert, ls.settings, ls.participationSet) !== 'drop') kept.push(alert)
  }
  await noteParticipation($, app, joined)
  if (!(await isLive($, ls, loop))) return 0

  ls.fetchCursor = cursor
  ls.hasMore = page.hasMore && isAdvanced
  if (kept.length > 0) {
    await updateQueue($, app, q => addToQueue(q, kept, cursor, ls.record.delivered, wakeOf(ls)))
    await syncCounts($, app)
    await armFlush($, app)
  }
  if (page.alerts.length > 0) detach(refreshDecisions($, app))

  if (page.alerts.length > 0 && !isAdvanced) return 5_000
  // An empty wait that came back early means the server's waiter cap is full: sleep out the rest.
  if (isWaiting && page.alerts.length === 0 && !ls.hasMore && elapsed < SHORT_WAIT_MS) return remainder
  return 0
}

// ---- waking delivery ----

async function readBox($: EngineInterface): Promise<string> {
  try {
    return (await $.prompt.read()).text
  } catch {
    return ''
  }
}

/** Arms the flush timer for the earliest time a wake may fire; replaces any earlier timer. */
async function armFlush($: EngineInterface, app: App) {
  const { ls } = app
  ls.flushTimer?.cancel()
  ls.flushTimer = undefined
  if (ls.isHeld) return
  // A wake is under way: it looks again when it ends, so what arrived meanwhile is not forgotten.
  if (ls.isDelivering) {
    ls.isRearmWanted = true
    return
  }
  const due = wakeDueAt(await readQueue($, app), ls.settings, wakeOf(ls))
  if (due === null) return
  const now = await $.clock.now()
  ls.flushTimer = $.clock.after(Math.max(0, Math.max(due, ls.retryAfter) - now), () => {
    detach(flush($, app))
  })
}

/**
 * The flush timer fired. The wake is claimed before the first await: a second timer firing while
 * this one waits on the queue, the clock or the prompt box would otherwise pass the same guard
 * and wake the session twice inside one gap.
 */
async function flush($: EngineInterface, app: App) {
  const { ls } = app
  ls.flushTimer = undefined
  if (ls.isDelivering || ls.isHeld) return
  ls.isDelivering = true
  let isRearming: boolean
  try {
    isRearming = await wake($, app)
  } finally {
    ls.isDelivering = false
  }
  const isWanted = ls.isRearmWanted
  ls.isRearmWanted = false
  if (isRearming || isWanted) await armFlush($, app)
}

/**
 * Wake the session with everything pending, unless the prompt box has a draft. Answers whether
 * the timer should be armed again (a wake that was not yet due, a delivery that went through or
 * was refused), as opposed to nothing left to do.
 */
async function wake($: EngineInterface, app: App): Promise<boolean> {
  const { ls } = app
  const first = await readQueue($, app)
  const due = wakeDueAt(first, ls.settings, wakeOf(ls))
  if (due === null) return false
  const now = await $.clock.now()
  if (now < Math.max(due, ls.retryAfter)) return true

  // A draft in the box blocks the wake: say so, and let the queue go when the box empties or
  // with the person's next prompt, whichever comes first.
  if ((await readBox($)).trim() !== '') {
    await holdWake($, app, countsOf(first, wakeOf(ls)))
    return false
  }

  // The queue as it is now, after the waits above: the person's own prompt may have carried some
  // of it meanwhile. Nothing is awaited between choosing the batch and marking it in flight.
  const q = await readQueue($, app)
  const blocked = await blockedIds($, app, q)
  const batch = takeBatch(q, blocked, wakeOf(ls))
  if (batch.length === 0) {
    // What is pending is in another instance's delivery: look again once it has resolved or expired.
    if (q.items.some(a => blocked.has(a.id) && !ls.inFlight.has(a.id) && wakeOf(ls)(a))) {
      ls.retryAfter = (await $.clock.now()) + CLAIM_RECHECK_MS
      return true
    }
    return false
  }
  for (const alert of batch) ls.inFlight.add(alert.id)
  let isDelivered = false
  let isClaimed = false
  try {
    await setClaim($, app, batch.map(a => a.id), true)
    isClaimed = true
    // Written before the submit: the gap runs from the attempt, whatever becomes of it.
    await updateQueue($, app, cur => ({ ...cur, lastWakeAt: now }))
    const owner = (await read($, workspace))?.ownerId ?? null
    const text = clean(app, frameMessages(batch.map(toFrameMessage), { ownerId: owner, nonce: newNonce(), note: deliveryNote(q.dropped) }))
    try {
      const sent = await $.prompt.submit({ text })
      isDelivered = sent.drop === undefined
    } catch {
      isDelivered = false
    }
    if (isDelivered) await finishDelivery($, app, batch, q.dropped)
    else ls.retryAfter = (await $.clock.now()) + Math.max(ls.settings.gapSeconds * 1000, 30_000)
  } finally {
    for (const alert of batch) ls.inFlight.delete(alert.id)
    if (isClaimed) await setClaim($, app, batch.map(a => a.id), false)
  }
  return true
}

/** Pins this plugin's status line, or with undefined unpins it. A host that refuses leaves the other signs of a hold. */
function pin($: EngineInterface, text: string | undefined) {
  try {
    $.ui.status(text)
  } catch {
    // The toast and the band still say it.
  }
}

/** Pins the held status line for `waiting` alerts, unless it already says that. */
function showHeld($: EngineInterface, ls: ListenerState, waiting: number) {
  const text = heldStatusLine(waiting)
  if (ls.heldStatus === text) return
  ls.heldStatus = text
  pin($, text)
}

/** The hold is over (a delivery took the queue, the box emptied, nothing is left to wake for): its timer and status line go. */
function endHold($: EngineInterface, ls: ListenerState) {
  if (ls.isHeld) detach(update($, counts, prev => ({ ...prev, isHeld: false })))
  ls.isHeld = false
  ls.holdTimer?.cancel()
  ls.holdTimer = undefined
  if (ls.heldStatus !== undefined) {
    ls.heldStatus = undefined
    pin($, undefined)
  }
}

/** Arms the one timer that looks at the box again; replaces any earlier. */
function armHoldRecheck($: EngineInterface, app: App) {
  const { ls } = app
  ls.holdTimer?.cancel()
  ls.holdTimer = $.clock.after(HELD_RECHECK_MS, () => {
    detach(recheckHold($, app))
  })
}

/**
 * A draft in the box blocks the wake. The hold is shown three ways, because the desktop has no
 * terminal to notify: the notification, a toast where that was not sent (once per hold), and a
 * status line under the prompt for as long as it lasts. The hold is claimed and its timer armed
 * before the first await, so a prompt that carries the queue meanwhile ends the whole of it.
 */
async function holdWake($: EngineInterface, app: App, pending: { unread: number; forYou: number }) {
  const { ls } = app
  ls.isHeld = true
  detach(update($, counts, prev => ({ ...prev, isHeld: true })))
  showHeld($, ls, pending.unread)
  armHoldRecheck($, app)
  const text = heldNotice(pending.unread, pending.forYou)
  let isSent = false
  try {
    isSent = (await $.ui.notify(text, { title: 'Orchard' }))?.isSent === true
  } catch {
    // A refused notification is still a hold, and the toast says so.
  }
  if (!isSent && ls.isHeld) $.ui.toast(text)
}

/**
 * The recheck timer fired: look at the box again. What there is to know is read first and judged
 * after with no await between, so a delivery that landed during the reads is seen, not raced. The
 * person's own next prompt may take the queue first (it ends the hold and this timer); a recheck
 * that falls inside such a delivery leaves it to that delivery and looks again later. The wake
 * itself is the ordinary one (`flush`), so the batch window, the gap and the claim all hold.
 */
async function recheckHold($: EngineInterface, app: App) {
  const { ls } = app
  ls.holdTimer = undefined
  if (!ls.isHeld) return
  const box = await readBox($)
  const queue = await readQueue($, app)
  let current: number | undefined
  try {
    current = await read($, generation)
  } catch {
    current = undefined
  }

  if (!ls.isHeld) return
  if (ls.isDelivering || ls.inFlight.size > 0) return armHoldRecheck($, app)
  // Another module instance has taken over (a reload): the queue is its to deliver, and the
  // status line is its to unpin.
  if (ls.loop !== undefined && !ls.isStarting && current !== undefined && current !== ls.loop.gen) {
    ls.isHeld = false
    ls.heldStatus = undefined
    return
  }
  const pending = countsOf(queue, wakeOf(ls))
  if (pending.forYou > 0 && box.trim() !== '') {
    showHeld($, ls, pending.unread)
    return armHoldRecheck($, app)
  }
  endHold($, ls)
  if (pending.forYou > 0) await flush($, app)
}

/**
 * The delivery call resolved: take the batch out of the queue, write the cursor and the
 * delivered ids in one store write, then (and only then) acknowledge. `reported` is how many
 * discarded quiet alerts the delivery told the model about.
 */
async function finishDelivery($: EngineInterface, app: App, batch: readonly OrchardAlert[], reported: number) {
  const { rt, ls } = app
  const here = rt.current
  const ids = batch.map(a => a.id)
  const cur = await updateQueue($, app, q => removeFromQueue(q, ids, reported))
  // The cursor may only cover what is delivered: never past an alert still waiting. A batch that
  // took a later alert ahead of earlier ones leaves those pending, and the cover stops before them.
  const waiting = cur.items.reduce((min, a) => Math.min(min, a.sequence), Number.POSITIVE_INFINITY)
  const cover = waiting === Number.POSITIVE_INFINITY ? cur.cursor : Math.min(cur.cursor, waiting - 1)
  ls.record = recordDelivery(ls.record, ids, cover)
  endHold($, ls)
  if (here !== undefined) await storeSet($, app, storeKey(here.conn.endpoint, here.identity.participantId), ls.record)
  await syncCounts($, app)
  detach(sendAck($, app, { ids, requestId: `orchard-ack-${crypto.randomUUID()}` }))
  detach(refreshDecisions($, app))
  await armFlush($, app)
}

async function sendAck($: EngineInterface, app: App, entry: { ids: string[]; requestId: string }): Promise<boolean> {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return false
  const args = ['ack', '--participant-id', here.identity.participantId]
  for (const id of entry.ids) args.push('--message-id', id)
  args.push('--request-id', entry.requestId)
  const result = await cli($, rt, args, { scrub: [entry.requestId] })
  // Only a connection failure is worth retrying, with the same request id.
  if (result.exitCode === EXIT_CONNECTION) {
    if (!ls.unacked.some(e => e.requestId === entry.requestId)) ls.unacked = [...ls.unacked, entry].slice(-20)
    return false
  }
  ls.unacked = ls.unacked.filter(e => e.requestId !== entry.requestId)
  return true
}

async function retryAcks($: EngineInterface, app: App) {
  for (const entry of [...app.ls.unacked]) {
    if (!(await sendAck($, app, entry))) return
  }
}

// ---- notification settings ----

/** Makes `next` the settings: memory, store, the pane's copy, and what they change in the queue. */
async function saveSettings($: EngineInterface, app: App, next: OrchardSettings) {
  const { rt, ls } = app
  const here = rt.current
  ls.settings = next
  if (here !== undefined) await storeSet($, app, settingsKey(here.conn.endpoint, here.identity.participantId), next)
  await update($, settings, () => next)
  // What is already pending was classified under the old settings: what the new ones would drop
  // goes (as it would have at the door), what changes between wake and quiet is counted afresh.
  await updateQueue($, app, held => retainInQueue(held, alert => classify(alert, next, ls.participationSet) !== 'drop'))
  await syncCounts($, app)
  await armFlush($, app)
}

/** The channels the participant can see (`mail_channels`). Keeps the last list if the read fails. */
async function loadChannels($: EngineInterface, app: App): Promise<{ id: string; name: string }[]> {
  const result = await tool($, app.rt, 'mail_channels', {})
  const channels = result.exitCode === EXIT_OK ? (result.json as { channels?: unknown } | undefined)?.channels : undefined
  if (Array.isArray(channels)) {
    app.ls.channels = (channels as { id?: unknown; name?: unknown }[])
      .filter((c): c is { id: string; name?: unknown } => typeof c.id === 'string')
      .map(c => ({ id: c.id, name: typeof c.name === 'string' && c.name !== '' ? c.name : c.id }))
  }
  return app.ls.channels
}

/** `/orchard notify ...`: what to say back. */
async function runNotify($: EngineInterface, app: App, rest: string): Promise<string> {
  const { ls } = app
  const command = parseNotify(rest, ls.channels.length > 0 ? ls.channels : await loadChannels($, app))
  if (command.kind === 'error') return `${command.message}\n${NOTIFY_USAGE}`
  if (command.kind !== 'show') await saveSettings($, app, applyNotify(ls.settings, command))
  return describeSettings(ls.settings, ls.channels)
}

// ---- the pane ----

const EMPTY_PANE: OrchardPane = { state: 'loading', error: null, threads: [], decisions: [], tasks: [], channels: [], isOlderShown: false, expanded: [] }

/** Reads everything the pane lists. The band's counts and the participation set are refreshed from the same window. */
async function loadPane($: EngineInterface, app: App) {
  const { rt, ls } = app
  const here = rt.current
  const show = (change: Partial<OrchardPane>) => update($, pane, p => ({ ...(p ?? EMPTY_PANE), ...change }))
  if (here === undefined) return show({ state: 'failed', error: 'Orchard is not connected' })
  await show({ state: 'loading', error: null })

  const me = here.identity.participantId
  const [window, info, channels, people] = await Promise.all([
    readWindow($, app),
    tool($, rt, 'workspace_info', {}),
    loadChannels($, app),
    tool($, rt, 'mail_participants', {}),
  ])
  if (window.kind !== 'ok') {
    return show({ state: 'failed', error: window.kind === 'offline' ? 'The workspace is not reachable' : window.message })
  }
  if (people.exitCode === EXIT_OK) {
    const list = (people.json as { participants?: unknown } | undefined)?.participants
    for (const p of Array.isArray(list) ? (list as { id?: unknown; name?: unknown }[]) : []) {
      if (typeof p.id === 'string' && typeof p.name === 'string') ls.names.set(p.id, p.name)
    }
  }
  await applyWindow($, app, window.messages)

  const { endpoint } = here.conn
  const owner = (await read($, workspace))?.ownerId ?? 'owner'
  const pendingIds = new Map((await readQueue($, app)).items.map(item => [item.id, item.reasons] as const))
  const threads = buildThreads(window.messages, { me, ownerId: owner, endpoint, names: ls.names, pending: pendingIds })
  const decisions = openDecisions(window.messages, me, owner).map(m => ({
    id: m.id,
    snippet: snippetOf(m.body),
    sentAt: m.sentAt,
    href: messageHref(endpoint, m.id),
  }))

  // Claimed tasks: in progress and assigned to this participant, in each attached task store.
  const stores = ((info.json as { workspace?: { task_stores?: unknown } } | undefined)?.workspace?.task_stores ?? []) as unknown
  const tasks: OrchardPane['tasks'] = []
  for (const store of (Array.isArray(stores) ? stores : []).slice(0, 4) as { id?: unknown }[]) {
    if (typeof store.id !== 'string') continue
    const listed = await tool($, rt, 'tasks_list', { store_id: store.id, status: 'in_progress' })
    const rows = listed.exitCode === EXIT_OK ? (listed.json as { tasks?: unknown } | undefined)?.tasks : undefined
    for (const row of (Array.isArray(rows) ? rows : []) as Record<string, unknown>[]) {
      if (row.assignee !== me || typeof row.id !== 'string') continue
      tasks.push({
        id: row.id,
        title: snippetOf(typeof row.title === 'string' ? row.title : row.id),
        status: (typeof row.status === 'string' ? row.status : 'in_progress').replace(/_/g, ' '),
        href: taskHref(endpoint, store.id, row.id),
      })
    }
  }
  await show({ state: 'ready', error: null, threads, decisions, tasks, channels })
}

/** Reply…: a draft in the prompt box for the person to finish. Never submits. */
async function fillReply($: EngineInterface, thread: OrchardPaneThread) {
  const isEmpty = (await readBox($)).trim() === ''
  const draft = `${isEmpty ? '' : '\n\n'}Reply on Orchard to message ${thread.replyToId} (orchard_reply): `
  try {
    await $.prompt.fill({ text: draft, mode: 'append' })
  } catch {
    // A refused fill leaves the box as it was.
  }
}

/**
 * Opens an address of Orchard's browser UI in the person's browser. Only the loopback address on
 * a workspace path is ever opened, whatever a handler is handed.
 */
async function openInOrchard($: EngineInterface, href: string) {
  if (!/^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/w\/[^\s]+$/.test(href)) return
  try {
    await $.process.run(['open', href], { timeoutMs: 10_000 })
  } catch {
    $.ui.toast('Orchard: could not open the browser')
  }
}

function paneHandlers($: EngineInterface, app: App): PaneHandlers {
  return {
    refresh: () => detach(loadPane($, app)),
    toggleOlder: () => detach(update($, pane, p => ({ ...(p ?? EMPTY_PANE), isOlderShown: p?.isOlderShown !== true }))),
    toggleThread: replyToId =>
      detach(
        update($, pane, p => {
          const open = p?.expanded ?? []
          return { ...(p ?? EMPTY_PANE), expanded: open.includes(replyToId) ? open.filter(id => id !== replyToId) : [...open, replyToId] }
        }),
      ),
    open: href => detach(openInOrchard($, href)),
    reply: thread => detach(fillReply($, thread)),
    setLevel: (channelId, level) => {
      if (level !== 'inherit' && !isLevel(level)) return
      const channel = channelId === null ? null : (app.ls.channels.find(c => c.id === channelId) ?? { id: channelId, name: channelId })
      detach(saveSettings($, app, applyNotify(app.ls.settings, { kind: 'level', channel, level })))
    },
    setRate: (which, text) => {
      const command = parseRate(which, text)
      if (command.kind === 'rate') detach(saveSettings($, app, applyNotify(app.ls.settings, command)))
      else $.ui.toast(`Orchard: ${command.message}`)
    },
  }
}

// ---- the model's tools ----

type ToolAnswer = { result: string } | { deny: string }

const denied = (message: string): ToolAnswer => ({ deny: `Orchard: ${message}` })

/** The secrets of this connection, for scrubbing anything the model is about to read. */
function secretsOf(app: App): string[] {
  const conn = app.rt.current?.conn
  return conn === undefined ? [] : [conn.credentialFile, conn.endpoint, workspaceIdOf(conn.endpoint) ?? '']
}

const clean = (app: App, text: string) => scrubSecrets(text, secretsOf(app))

/** What the model is told when a call failed. A lost connection means different things for a read and a mutation. */
function failureAnswer(app: App, result: CliResult, kind: 'read' | 'mutation' | 'mutation-own-id' = 'mutation'): ToolAnswer {
  if (result.exitCode === EXIT_CONNECTION) return { deny: kind === 'read' ? UNREACHABLE : kind === 'mutation' ? RETRY_ADVICE : RETRY_OWN_ID }
  return denied(clean(app, result.message ?? 'the workspace refused the request'))
}

/**
 * One mutating call. The request id is generated here and kept when the connection fails
 * before an answer, so the same call made again carries the same id and cannot apply twice.
 */
async function mutate(
  $: EngineInterface,
  app: App,
  label: string,
  identity: unknown,
  run: (requestId: string) => Promise<CliResult>,
): Promise<CliResult> {
  const { ls } = app
  const key = fingerprint(label, identity)
  // A retry id is for a retry: one older than RETRY_ID_TTL_MS is forgotten, and the same words
  // sent again after that are a new message, not the replay of an old receipt.
  const now = await $.clock.now()
  for (const [old, entry] of [...ls.retryIds]) if (now - entry.at > RETRY_ID_TTL_MS) ls.retryIds.delete(old)
  const requestId = ls.retryIds.get(key)?.requestId ?? makeRequestId(label)
  const result = await run(requestId)
  if (result.exitCode === EXIT_CONNECTION) {
    ls.retryIds.delete(key)
    ls.retryIds.set(key, { requestId, at: now })
    for (const old of [...ls.retryIds.keys()].slice(0, Math.max(0, ls.retryIds.size - 50))) ls.retryIds.delete(old)
  } else {
    ls.retryIds.delete(key)
  }
  return result
}

const messageIdOf = (result: CliResult): string | undefined => {
  const id = (result.json as { message?: { id?: unknown } } | undefined)?.message?.id
  return typeof id === 'string' ? id : undefined
}

async function sendMessage(
  $: EngineInterface,
  app: App,
  label: string,
  identity: unknown,
  message: Record<string, unknown>,
): Promise<{ result: CliResult; id: string | undefined }> {
  const me = app.rt.current?.identity.participantId ?? ''
  const result = await mutate($, app, label, identity, requestId =>
    tool($, app.rt, 'mail_send', { ...message, request_id: requestId, sender_id: me }, { scrub: [requestId] }),
  )
  return { result, id: messageIdOf(result) }
}

async function answerSend($: EngineInterface, app: App, input: unknown): Promise<ToolAnswer> {
  const parsed = parseSend(input)
  if (!parsed.ok) return denied(parsed.message)
  const { result, id } = await sendMessage($, app, 'send', parsed.value, { destination: parsed.value.destination, body: parsed.value.body })
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result)
  // A message this participant starts is a thread it is in.
  if (id !== undefined) await noteParticipation($, app, [id])
  return { result: `Sent${id === undefined ? '' : `. message_id: ${id}`}` }
}

async function answerReply($: EngineInterface, app: App, input: unknown): Promise<ToolAnswer> {
  const parsed = parseReply(input)
  if (!parsed.ok) return denied(parsed.message)
  const me = app.rt.current?.identity.participantId ?? ''
  const window = await readWindow($, app)
  if (window.kind === 'offline') return { deny: 'Orchard: the workspace is not reachable right now; try again shortly.' }
  if (window.kind === 'failed') return denied(clean(app, window.message))
  const target = window.messages.find(m => m.id === parsed.value.messageId)
  if (target === undefined) return denied('that message is not among the recent messages; send with orchard_send instead')
  const destination = replyDestination(target, me)
  if (destination === undefined) return denied('that message has no one to reply to; send with orchard_send instead')

  const { result, id } = await sendMessage($, app, 'reply', parsed.value, {
    destination,
    body: parsed.value.body,
    thread_id: target.id,
  })
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result)
  // Posting in a thread makes it one this participant is in: everything in the window under the same root.
  const parents = parentsOf(window.messages)
  const root = rootOf(target.id, parents)
  const thread = window.messages.filter(m => rootOf(m.id, parents) === root).map(m => m.id)
  await noteParticipation($, app, id === undefined ? thread : [...thread, id])
  return { result: `Replied${id === undefined ? '' : `. message_id: ${id}`}` }
}

async function answerAck($: EngineInterface, app: App, input: unknown): Promise<ToolAnswer> {
  const parsed = parseAck(input)
  if (!parsed.ok) return denied(parsed.message)
  const me = app.rt.current?.identity.participantId ?? ''
  const result = await mutate($, app, 'ack', parsed.value, requestId => {
    const args = ['ack', '--participant-id', me]
    for (const id of parsed.value.messageIds) args.push('--message-id', id)
    args.push('--request-id', requestId)
    return cli($, app.rt, args, { scrub: [requestId] })
  })
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result)
  return { result: `Acknowledged ${parsed.value.messageIds.length} message${parsed.value.messageIds.length === 1 ? '' : 's'}` }
}

const frameOf = (m: HistoryMessage, names: ReadonlyMap<string, string>): FrameMessage => ({
  id: m.id,
  senderId: m.senderId,
  senderName: names.get(m.senderId) ?? null,
  body: m.body,
  bodyCut: m.bodyCut,
  where: m.destination === 'channel' ? `channel ${m.destinationId ?? ''}`.trim() : m.destination,
  threadId: m.threadId,
  kind: m.kind,
})

async function answerHistory($: EngineInterface, app: App, input: unknown): Promise<ToolAnswer> {
  const parsed = parseHistoryInput(input)
  if (!parsed.ok) return denied(parsed.message)
  const result = await tool($, app.rt, 'mail_history', parsed.value)
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result, 'read')
  const messages = parseHistory(withoutJoiningPrompt(result.json))
  if (messages.length === 0) return { result: 'No messages matched.' }
  await ensureNames($, app, messages.map(m => m.senderId))
  const owner = (await read($, workspace))?.ownerId ?? null
  const text = frameMessages(
    messages.map(m => frameOf(m, app.ls.names)),
    { ownerId: owner, nonce: newNonce(), note: 'Oldest first. A message_id can be passed to orchard_reply or orchard_ack.' },
  )
  return { result: clean(app, text) }
}

async function answerCall($: EngineInterface, app: App, input: unknown): Promise<ToolAnswer> {
  const parsed = parseCall(input)
  if (!parsed.ok) return denied(parsed.message)
  const { tool: name } = parsed.value
  const isMutating = MUTATING_CALLS.has(name)
  // A mutation acts as this session's participant, whatever the model wrote: the server trusts
  // the id it is given.
  const pinned = pinActor(name, parsed.value.args, app.rt.current?.identity.participantId ?? '')
  if (!pinned.ok) return denied(pinned.message)
  const args = pinned.value
  // The model's own request_id is honoured; otherwise one is generated and kept across a retry.
  const hasOwnId = typeof args.request_id === 'string' && args.request_id.trim() !== ''
  const result =
    isMutating && !hasOwnId
      ? await mutate($, app, name, args, requestId => tool($, app.rt, name, { ...args, request_id: requestId }, { scrub: [requestId] }))
      : await tool($, app.rt, name, args)
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result, !isMutating ? 'read' : hasOwnId ? 'mutation-own-id' : 'mutation')
  if (name === 'mail_send') {
    const id = messageIdOf(result)
    if (id !== undefined) await noteParticipation($, app, [id])
  }
  return { result: clean(app, frameData(`orchard_call ${name}`, withoutJoiningPrompt(result.json ?? null), newNonce())) }
}

async function answerTool($: EngineInterface, app: App, name: string, input: unknown): Promise<ToolAnswer> {
  try {
    switch (name) {
      case 'orchard_send':
        return await answerSend($, app, input)
      case 'orchard_reply':
        return await answerReply($, app, input)
      case 'orchard_ack':
        return await answerAck($, app, input)
      case 'orchard_history':
        return await answerHistory($, app, input)
      default:
        return await answerCall($, app, input)
    }
  } catch {
    return denied('the request could not be completed')
  }
}

// ---- liveness ----

/**
 * A reload may re-run register without session.start, or drop a timer. On the person's
 * prompt and when a turn ends: start what was never started, restart a loop that died or
 * stopped moving. Never touches a loop that is alive, so one generation never has two.
 */
async function ensureListening($: EngineInterface, app: App) {
  const { rt, ls } = app
  if (!ls.isStarted) {
    ls.isStarted = true
    let cwd: string
    try {
      cwd = await $.session.cwd()
    } catch {
      ls.isStarted = false
      return
    }
    await registerSurface($)
    await start($, app, cwd)
    return
  }
  if (rt.isAttempting || ls.isStarting) return
  if ((await read($, status))?.kind !== 'connected') return
  const loop = ls.loop
  const isAlive = loop !== undefined && !loop.isStopped && (await $.clock.now()) <= loop.expectedBy
  if (!isAlive) detach(startListener($, app))
}

async function registerSurface($: EngineInterface) {
  try {
    await $.command.register({
      name: 'orchard',
      description: 'Open the Orchard pane; /orchard notify to set notification levels; /orchard reconnect',
      argumentHint: '[notify … | reconnect]',
    })
  } catch {
    // The listener works without the command.
  }
  // The model's tools wait behind tool search until it asks for them.
  for (const spec of TOOL_SPECS) {
    try {
      await $.tool.register({ ...spec, isDeferred: true })
    } catch {
      // A tool that cannot be registered is a tool the model does not see.
    }
  }
}

/** The person's own prompts carry the queue; prompts other plugins or tasks raise do not. */
const isPersonsPrompt = (origin: { kind: string } | undefined) => origin === undefined || origin.kind === 'composer' || origin.kind === 'bridge'

export const register: Register = (on, options) => {
  const config = readOptions(options)

  // No endpoint configured: the mod does nothing at all. No hook, no band.
  if (config.endpoint === '') return

  const app: App = { rt: createRuntime(), ls: createListenerState(), options: config }

  on('session.start', async ($, e, next) => {
    await registerSurface($)
    // Not awaited: the first prompt does not wait on a workspace that may be down.
    detach(start($, app, e.cwd))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear keeps this process, its loop and its lease holder id; every other end is a session that will not beat again.
    if (e.reason !== 'clear') await releaseLease($, app)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    detach(ensureListening($, app))
    if (!isPersonsPrompt(e.origin)) return next(e)

    const { ls } = app
    const pending = await readQueue($, app)
    const batch = takeBatch(pending, await blockedIds($, app, pending), wakeOf(ls))
    if (batch.length === 0) return next(e)

    // The queue rides along as context: the model reads it, the person does not see it typed.
    for (const alert of batch) ls.inFlight.add(alert.id)
    let isClaimed = false
    try {
      await setClaim($, app, batch.map(a => a.id), true)
      isClaimed = true
      const owner = (await read($, workspace))?.ownerId ?? null
      const context = clean(app, frameMessages(batch.map(toFrameMessage), { ownerId: owner, nonce: newNonce(), note: deliveryNote(pending.dropped) }))
      const result = await next({ ...e, context: [...(e.context ?? []), context] })
      // Delivered only if the prompt entered; a refused prompt keeps the queue and acknowledges nothing.
      if (result.drop === undefined) await finishDelivery($, app, batch, pending.dropped)
      return result
    } finally {
      for (const alert of batch) ls.inFlight.delete(alert.id)
      if (isClaimed) await setClaim($, app, batch.map(a => a.id), false)
    }
  }).catch(($, e, next) => next(e)) // a hook that fails never costs the person their prompt

  on('turn.complete', async ($, e, next) => {
    detach(ensureListening($, app))
    return next(e)
  })

  on('command.run', { command: 'orchard' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    if (word === 'reconnect') {
      detach(start($, app, await $.session.cwd()))
      return { text: 'Reconnecting to Orchard…' }
    }
    if (word === 'notify') return { text: await runNotify($, app, rest.join(' ')) }
    if (word !== '') return { text: 'Usage: /orchard [notify … | reconnect]' }

    detach(loadPane($, app))
    const opened = await $.ui.open({ id: PANE, title: 'Orchard' })
    return { text: opened.isPlaced ? 'Orchard pane opened.' : 'Orchard pane: widen the terminal to see it.' }
  })

  on('tool.call', { tool: 'mcp__orchard__orchard_send' }, ($, e) => answerTool($, app, 'orchard_send', e))
  on('tool.call', { tool: 'mcp__orchard__orchard_reply' }, ($, e) => answerTool($, app, 'orchard_reply', e))
  on('tool.call', { tool: 'mcp__orchard__orchard_ack' }, ($, e) => answerTool($, app, 'orchard_ack', e))
  on('tool.call', { tool: 'mcp__orchard__orchard_history' }, ($, e) => answerTool($, app, 'orchard_history', e))
  on('tool.call', { tool: 'mcp__orchard__orchard_call' }, ($, e) => answerTool($, app, 'orchard_call', e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const table: Table = {
      Box: t.Box,
      Text: t.Text,
      Button: t.Button,
      // The terminal draws no Svg: it gets the same structure as Text.
      Svg: e.surface !== 'terminal' && 'Svg' in t ? t.Svg : undefined,
      // The mobile app draws no field (its table answers a stub): there the settings are text.
      Input: e.surface !== 'mobile' && 'Input' in t ? t.Input : undefined,
      Select: e.surface !== 'mobile' && 'Select' in t ? t.Select : undefined,
    }
    return renderPane(
      table,
      {
        participantId: app.rt.current?.identity.participantId ?? '',
        workspaceName: (await read($, workspace))?.name ?? '',
        workspaceHref: app.rt.current === undefined ? null : workspaceHref(app.rt.current.conn.endpoint),
        pane: await read($, pane),
        settings: await read($, settings),
        status: await read($, status),
        counts: await read($, counts),
        nowMs: await $.clock.now(),
        columns: typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns : undefined,
      },
      paneHandlers($, app),
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const line = bandLine(await read($, status), await read($, workspace), await read($, counts))
    if (line === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // Theme tokens only (no hex), so the band follows the person's light/dark theme.
    const paint = (tone: BandTone): { color?: string; dimColor?: boolean } =>
      tone === 'mark' ? { color: 'suggestion' } : tone === 'ok' ? { color: 'success' } : tone === 'warn' ? { color: 'warning' } : tone === 'err' ? { color: 'error' } : tone === 'dim' ? { dimColor: true } : {}
    return (
      <Box>
        {line.segments.map((segment, i) => (
          <Text key={`band-${i}`} wrap="truncate-end" bold={segment.tone === 'mark'} {...paint(segment.tone)}>
            {segment.text}
          </Text>
        ))}
      </Box>
    )
  })
}

