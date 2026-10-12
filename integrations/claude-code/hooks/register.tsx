// Every use of `$` is in this file: `claude plugin validate` follows `$` only into
// functions declared in the hooks module's own file, never across an import. The
// modules beside it are pure and take ports (see orchard-cli.ts's `Run`).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  OrchardActivityEntry,
  OrchardAgents,
  OrchardAlert,
  OrchardBand,
  OrchardCounts,
  OrchardHeartbeat,
  OrchardPaneDecision,
  OrchardPaneTask,
  OrchardPlugins,
  OrchardQueue,
  OrchardSettings,
  OrchardStatus,
  OrchardWorkspace,
  OrchardWorkspaceActivity,
} from '../types'
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
import { DEFAULT_SETTINGS, addParticipation, classify, parseParticipation, parseSettings, participationKey, settingsKey } from './classify'
import { checkConn, parseProjectFile, PROJECT_FILE, PROJECT_ID_PREFIX, RESERVED_IDS, readOptions, resolveIdentity } from './config'
import type { Options, Parsed, ProjectOverrides } from './config'
import { backoffDelay, connectOnce, createRuntime, enterOnce, track } from './connect'
import type { Runtime } from './connect'
import {
  ACTIVITY_KEEP,
  EMPTY_PLUGINS,
  MAIN,
  OTHERS_WINDOW_MS,
  READ_FLOOR_MS,
  anyMoving,
  ackNote,
  attachedPluginIds,
  callNote,
  declaredRoles,
  inboundText,
  isEnded,
  nextAgentLook,
  pruned,
  pushActivity,
  reconciled,
  remember,
  replyNote,
  sendNote,
  stateMarkers,
  taskRows,
  taskStoreIds,
  touchesPlugins,
  withHandle,
  withLastAction,
  withMain,
  withSpawned,
  withinWindow,
} from './feed'
import type { Names, Note } from './feed'
import { frameData, frameMessages, newNonce } from './frame'
import type { FrameMessage } from './frame'
import { POOL_SUFFIX, SHARE_RETRY_MS, actorOf, enteringOf, finished, freeSlots, joinedAs, lingering, markReleased, observe, ownHandles, shareNote, shown, stanceOf, subHandle, subName, touch } from './handles'
import type { ShareReason } from './handles'
import { HISTORY_WINDOW, openDecisions, parseHistory, parseHistoryMessage, parentsOf, participationFrom, rootOf } from './history'
import type { HistoryMessage } from './history'
import { RETRY_ID_TTL_MS, createListenerState, deliveryNote, heldNotice, heldStatusLine, stopLoop, toFrameMessage } from './listener'
import type { ListenerState, Loop } from './listener'
import { NOTIFY_USAGE, applyNotify, describeSettings, parseNotify } from './notify'
import { EXIT_CONNECTION, EXIT_OK, runOrchard, workspaceIdOf } from './orchard-cli'
import type { CliInit, CliResult, Run } from './orchard-cli'
import { renderPane } from './pane'
import type { PaneHandlers, PendingLine, Table } from './pane'
import { same } from './same'
import { alertHref, isDecisionRelated, isReceipt, messageHref, snippetOf, stateHref, taskHref, workspaceHref } from './threads'
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
// The notification settings (kept in $.store too).
const settings = atom({ plugin: 'orchard', key: 'settings' } as const, DEFAULT_SETTINGS)
// What the band draws, and the only thing it reads: written when the line itself changes, so the
// band redraws only then. The heartbeat is the poll clock, which moves on every poll and is
// read only by the pane's footer.
const band = atom({ plugin: 'orchard', key: 'band' } as const, null)
const heartbeat = atom({ plugin: 'orchard', key: 'heartbeat' } as const, { lastPollAt: null })
// What this session's agents did in Orchard and were told (a ring of about 60), the table of its
// agents (main and subagents), what happens in the workspace around it, and what the optional
// plugins hold for it. Each is written only when its value changes. The pane, the status line and
// the band draw from them.
const activity = atom({ plugin: 'orchard', key: 'activity' } as const, [])
const agents = atom({ plugin: 'orchard', key: 'agents' } as const, {})
const EMPTY_WORKSPACE_ACTIVITY: OrchardWorkspaceActivity = { recentFromOthers: 0, openTasks: null }
const workspaceActivity = atom({ plugin: 'orchard', key: 'workspaceActivity' } as const, EMPTY_WORKSPACE_ACTIVITY)
const plugins = atom({ plugin: 'orchard', key: 'plugins' } as const, EMPTY_PLUGINS)

const PANE = 'orchard'

/** How long past its due time a loop may be silent before the liveness guard calls it dead. */
const GUARD_SLACK_MS = 120_000

/** How often a listener that holds back for a full queue looks again whether a delivery has made room. */
const BACKPRESSURE_RECHECK_MS = 5_000

/** How often a wake held back by a draft in the prompt box looks at the box again. */
const HELD_RECHECK_MS = 15_000

/** A receipt waits this long for a burst of them (one task action writes two) before the workspace is read again. */
const WORK_DEBOUNCE_MS = 1_000

/** While the pane is open, the tasks and plugins are read again this often, whatever the alerts said. */
const SAFETY_REFRESH_MS = 60_000

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

/*
 * Each state write is its own function with a literal atom (the validator follows `read` and `update`
 * only to atoms it can see by name). Every one writes unless the value is already there, compared by
 * structure: a write redraws whatever read the atom, and an unchanged value is not news. True: it wrote.
 */
async function putStatus($: EngineInterface, change: (current: OrchardStatus | null) => OrchardStatus | null): Promise<boolean> {
  const current = await read($, status)
  if (same(current, change(current))) return false
  await update($, status, change)
  return true
}

async function putWorkspace($: EngineInterface, change: (current: OrchardWorkspace | null) => OrchardWorkspace | null): Promise<boolean> {
  const current = await read($, workspace)
  if (same(current, change(current))) return false
  await update($, workspace, change)
  return true
}

async function putCounts($: EngineInterface, change: (current: OrchardCounts) => OrchardCounts): Promise<boolean> {
  const current = await read($, counts)
  if (same(current, change(current))) return false
  await update($, counts, change)
  return true
}

async function putActivity($: EngineInterface, change: (current: OrchardActivityEntry[]) => OrchardActivityEntry[]): Promise<boolean> {
  const current = await read($, activity)
  if (same(current, change(current))) return false
  await update($, activity, change)
  return true
}

async function putAgents($: EngineInterface, change: (current: OrchardAgents) => OrchardAgents): Promise<boolean> {
  const current = await read($, agents)
  if (same(current, change(current))) return false
  await update($, agents, change)
  return true
}

async function putWorkspaceActivity($: EngineInterface, change: (current: OrchardWorkspaceActivity) => OrchardWorkspaceActivity): Promise<boolean> {
  const current = await read($, workspaceActivity)
  if (same(current, change(current))) return false
  await update($, workspaceActivity, change)
  return true
}

async function putPlugins($: EngineInterface, change: (current: OrchardPlugins) => OrchardPlugins): Promise<boolean> {
  const current = await read($, plugins)
  if (same(current, change(current))) return false
  await update($, plugins, change)
  return true
}

async function putBand($: EngineInterface, change: (current: OrchardBand | null) => OrchardBand | null): Promise<boolean> {
  const current = await read($, band)
  if (same(current, change(current))) return false
  await update($, band, change)
  return true
}

async function putHeartbeat($: EngineInterface, change: (current: OrchardHeartbeat) => OrchardHeartbeat): Promise<boolean> {
  const current = await read($, heartbeat)
  if (same(current, change(current))) return false
  await update($, heartbeat, change)
  return true
}

/** Derives the band's line from status, workspace and counts and writes it if the line differs. */
async function refreshBand($: EngineInterface, app: App) {
  const line = bandLine(await read($, status), await read($, workspace), await read($, counts), app.rt.current?.identity.participantId ?? '')
  await putBand($, () => line)
}

/** The band's sources: after a write that changed one, the band follows (and writes only if its line changed). */
async function putStatusShown($: EngineInterface, app: App, change: (current: OrchardStatus | null) => OrchardStatus | null) {
  if (await putStatus($, change)) await refreshBand($, app)
}
async function putWorkspaceShown($: EngineInterface, app: App, change: (current: OrchardWorkspace | null) => OrchardWorkspace | null) {
  if (await putWorkspace($, change)) await refreshBand($, app)
}
async function putCountsShown($: EngineInterface, app: App, change: (current: OrchardCounts) => OrchardCounts) {
  if (await putCounts($, change)) await refreshBand($, app)
}

async function setStatus($: EngineInterface, app: App, next: OrchardStatus) {
  // A disconnected session stays so: an attempt that was already under way must not paint it connected.
  if (app.ls.isDisconnected && next.kind !== 'disconnected') return
  await putStatusShown($, app, () => next)
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
  if (app.ls.isDisconnected) return
  rt.failures += 1
  rt.timer?.cancel()
  rt.timer = $.clock.after(backoffDelay(rt.failures), () => {
    detach(reconnect($, app))
  })
  await setStatus($, app, { kind: 'offline', failures: rt.failures })
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
    // Disconnected while the attempt ran: whatever it found is not wanted.
    if (app.ls.isDisconnected) return
    if (outcome.kind === 'connected') {
      await putWorkspaceShown($, app, () => outcome.workspace)
      await setStatus($, app, connectedStatus(app.ls))
      // The tasks and plugins are read at once, from the answer the connection already has, once the listener is set up (both ask the host about decisions).
      detach(startListener($, app).then(() => refreshWorkspace($, app, outcome.info)))
      // A pane left open through a disconnect has lost its slow refresh: it starts again.
      armSafety($, app)
    } else if (outcome.kind === 'offline') {
      await markOffline($, app)
    } else {
      await setStatus($, app, { kind: 'error', message: outcome.message })
    }
  } catch {
    await setStatus($, app, { kind: 'error', message: 'the Orchard connection failed unexpectedly' })
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

/** session.start (and `/orchard reconnect`, `/orchard connect`): show the band, resolve who we are, make the first attempt. */
async function start($: EngineInterface, app: App, cwd: string) {
  const { rt, ls, options } = app
  ls.isStarted = true
  // Starting is connecting: a session the person disconnected listens again.
  ls.isDisconnected = false
  // A fresh start: nothing of an earlier attempt or loop may fire after this.
  rt.timer?.cancel()
  rt.timer = undefined
  rt.failures = 0
  ls.leaseTimer?.cancel()
  ls.leaseTimer = undefined
  stopLoop(ls, 'superseded')
  // The subagent handles are derived from the identity this start may change: they are claimed again at the next call.
  await releaseHandles($, app)
  // What the workspace-wide counts are built from lives in memory: they begin again with it.
  ls.othersAt = []
  ls.lastOtherAt = undefined
  ls.decayTimer?.cancel()
  ls.decayTimer = undefined
  await putWorkspaceActivity($, () => EMPTY_WORKSPACE_ACTIVITY)
  await setStatus($, app, { kind: 'connecting' })

  const conn = checkConn(options)
  if (!conn.ok) return setStatus($, app, { kind: 'error', message: conn.message })

  const project = await readProject($, cwd)
  if (!project.ok) return setStatus($, app, { kind: 'error', message: project.message })
  if (project.value.isIdIgnored && !ls.isIdToastShown) {
    ls.isIdToastShown = true
    $.ui.toast('Orchard: the participantId in .orchard.json must start with "claude-", so it was ignored')
  }

  const identity = resolveIdentity(options, cwd, project.value)
  if (!identity.ok) return setStatus($, app, { kind: 'error', message: identity.message })

  rt.current = { conn: conn.value, identity: identity.value }
  const handle = identity.value.participantId
  const now = await $.clock.now()
  await putAgents($, held => withMain(held, { handle }, now))
  // After a reload the table may hold live agents nothing is watching any more.
  detach(armAgents($, app))
  await refreshBand($, app)
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
  const held = await readQueue($, app)
  const pending = countsOf(held, wakeOf(app.ls))
  await putCountsShown($, app, prev => ({ ...prev, ...pending, ...(needsYou === undefined ? {} : { needsYou }) }))
}

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

const connectedStatus = (ls: ListenerState): OrchardStatus => (ls.isStoreFailing ? { kind: 'connected', isStoreFailing: true } : { kind: 'connected' })

/** Writes to `$.store`; false when the store refused. A failure does not stop delivery (the store is a backstop against replay) but the band says so. */
async function storeSet($: EngineInterface, app: App, key: string, value: unknown): Promise<boolean> {
  let isFailing = false
  try {
    await $.store.set(key, value)
  } catch {
    isFailing = true
  }
  const { ls } = app
  if (isFailing !== ls.isStoreFailing) {
    ls.isStoreFailing = isFailing
    await putStatusShown($, app, current => (current?.kind === 'connected' ? connectedStatus(ls) : current))
  }
  return !isFailing
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
  await setStatus($, app, { kind: 'shared' })
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
  await setStatus($, app, connectedStatus(ls))
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
 * The decisions that any of `handles` (the session's participant, the handles its subagents act as)
 * raised and the owner has not answered, as the host lists them over the whole history
 * (`workspace_decisions`). The host narrows its list to one sender at most: asking it per handle
 * would be a call for each of up to a few dozen, so it is asked once, for every sender, and the
 * list kept to `handles` here. Undefined when the host cannot say (it has no such tool, or the call
 * failed): the caller then reconstructs from the history window. A tool error is taken to mean an
 * older host and remembered for the connection; a lost connection is not.
 */
async function listedDecisions($: EngineInterface, app: App, handles: readonly string[]): Promise<unknown[] | undefined> {
  const { ls } = app
  if (ls.decisionsTool === 'missing') return undefined
  const result = await tool($, app.rt, 'workspace_decisions', {})
  const listed = result.exitCode === EXIT_OK ? (result.json as { decisions?: unknown } | undefined)?.decisions : undefined
  if (Array.isArray(listed)) {
    ls.decisionsTool = 'available'
    return listed.filter(d => handles.includes((d as { sender_id?: string } | null)?.sender_id as string))
  }
  if (result.exitCode !== EXIT_CONNECTION) ls.decisionsTool = 'missing'
  return undefined
}

const countOpenDecisions = async ($: EngineInterface, app: App, handles: readonly string[]): Promise<number | undefined> => (await listedDecisions($, app, handles))?.length

async function applyWindow($: EngineInterface, app: App, messages: readonly HistoryMessage[]) {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return
  const me = here.identity.participantId
  await noteParticipation($, app, participationFrom(messages, me))
  const owner = (await read($, workspace))?.ownerId ?? 'owner'
  const handles = myHandles(app)
  await syncCounts($, app, (await countOpenDecisions($, app, handles)) ?? openDecisions(messages, handles, owner).length)
  ls.decisionsAt = await $.clock.now()
}

/**
 * Re-reads how many decisions wait on the owner: not more than every 15 s, one read at a time. The
 * host's own count (`workspace_decisions`) is one small call; a host without it is counted from a
 * window of history, which is read only when `isForced` (a decision or an owner's reply arrived),
 * never for every alert.
 */
async function refreshDecisions($: EngineInterface, app: App, isForced = false) {
  const { ls, rt } = app
  if (ls.isReadingDecisions) return
  const now = await $.clock.now()
  if (ls.decisionsAt !== undefined && now - ls.decisionsAt < 15_000) return
  const here = rt.current
  if (here === undefined) return
  ls.isReadingDecisions = true
  try {
    const counted = await countOpenDecisions($, app, myHandles(app))
    if (counted !== undefined) {
      await syncCounts($, app, counted)
      ls.decisionsAt = await $.clock.now()
    } else if (isForced) {
      const window = await readWindow($, app)
      if (window.kind === 'ok') await applyWindow($, app, window.messages)
    }
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
  if (here === undefined || ls.isStarting || ls.isDisconnected) return
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
  // Disconnected while the lease was being taken: give it back.
  if (ls.isDisconnected) {
    await releaseLease($, app)
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
      await setStatus($, app, { kind: 'error', message: window.message })
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
      await setStatus($, app, { kind: 'error', message: result.message ?? 'the Orchard CLI failed' })
      return
    }
    const delay = await absorb($, app, loop, result, isWaiting, elapsed)
    ls.crashes = 0
    ls.lastPollAt = await $.clock.now()
    // Only the pane's footer shows the poll clock, so it is written only while the pane is open.
    if (ls.isPaneOpen) await putHeartbeat($, () => ({ lastPollAt: ls.lastPollAt }))
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
  if (page.alerts.length > 0) {
    const owner = (await read($, workspace))?.ownerId ?? null
    detach(refreshDecisions($, app, page.alerts.some(a => isDecisionRelated(a, owner))))
    // The feed takes the page as it came: no history call, and the workspace is read again once after a receipt.
    await noteArrivals($, app, page.alerts, kept)
    // A task receipt waits for the floor between reads. So does a decision or the owner's answer, unless the pane is open and shows what waits on the owner.
    if (page.alerts.some(a => isDecisionRelated(a, owner)) && ls.isPaneOpen) detach(askRefresh($, app, 'soon'))
    else if (page.alerts.some(a => isReceipt(a) || isDecisionRelated(a, owner))) detach(askRefresh($, app, 'receipt'))
  }

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
  if (ls.isHeld || ls.isDisconnected) return
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
  if (ls.isDelivering || ls.isHeld || ls.isDisconnected) return
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
  if (ls.isDisconnected) return false
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
  await deliver($, app, batch, q, now)
  return true
}

/**
 * Hands `batch` to the prompt queue as a wake, claimed so it is delivered once: the ids are in
 * flight (this instance) and claimed in the store (another instance) from before the submit until
 * it resolves. `lastWakeAt` is set before the submit, so the gap runs from the attempt. A wake
 * (`wake`) delivers through here. No await comes between a caller choosing the batch and the ids
 * being marked in flight.
 */
async function deliver($: EngineInterface, app: App, batch: readonly OrchardAlert[], q: OrchardQueue, now: number): Promise<boolean> {
  const { ls } = app
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
  return isDelivered
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
function endHold($: EngineInterface, app: App) {
  const { ls } = app
  if (ls.isHeld) detach(putCountsShown($, app, prev => ({ ...prev, isHeld: false })))
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
  detach(putCountsShown($, app, prev => ({ ...prev, isHeld: true })))
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
  endHold($, app)
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
  endHold($, app)
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

/** Makes `next` the settings: memory, store, the settings atom, and what they change in the queue. */
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

// ---- what this session's agents do in Orchard, and what the workspace does around it ----

/** The participants this session acts as: the connection's own, the handles its subagents hold, the ones they joined as themselves. */
function myHandles(app: App): string[] {
  const me = app.rt.current?.identity.participantId
  return me === undefined ? [] : ownHandles(me, app.ls.subs)
}

/** The participant an agent of this session acts as: its pooled handle once it has one, else the session's own. */
function handleOf(app: App, agentId: string | undefined): string {
  return actorOf(app.rt.current?.identity.participantId ?? '', app.ls.subs, agentId)
}

/** Names for the sentences of the feed: the directory's where it knows one, the id where it does not. */
function namesOf(app: App): Names {
  const { ls } = app
  return { person: id => ls.names.get(id) ?? id, channel: id => ls.channels.find(c => c.id === id)?.name ?? id }
}

/** Adds an entry to the feed; an outbound one is also the agent's last action. The text is scrubbed of the connection's secrets: a message body can carry anything. */
async function recordActivity($: EngineInterface, app: App, entry: OrchardActivityEntry) {
  const text = clean(app, entry.text)
  const written = { ...entry, text }
  await putActivity($, feed => pushActivity(feed, written, ACTIVITY_KEEP))
  if (entry.direction === 'out') await putAgents($, held => withLastAction(held, entry.agentId, text))
}

/** What a note's reference opens as. */
function refHref(endpoint: string, ref: NonNullable<Note['ref']>): string | null {
  return ref.kind === 'message' ? messageHref(endpoint, ref.id) : ref.kind === 'task' ? taskHref(endpoint, ref.storeId, ref.id) : stateHref(endpoint, ref.id)
}

/**
 * One thing an agent just did in Orchard, into the feed. It follows a call that already succeeded, so
 * nothing that goes wrong here may reach the model: the feed is a courtesy. A write to the roles,
 * state markers or tasks asks for the workspace to be read again soon.
 */
async function logOutbound(
  $: EngineInterface,
  app: App,
  agentId: string | undefined,
  handle: string,
  make: (names: Names) => Note | undefined,
  wanted: { people?: readonly string[]; channel?: string } = {},
) {
  try {
    const { ls, rt } = app
    const here = rt.current
    if (here === undefined) return
    if (wanted.people !== undefined && wanted.people.length > 0) await ensureNames($, app, wanted.people)
    if (wanted.channel !== undefined && !ls.channels.some(c => c.id === wanted.channel)) await loadChannels($, app)
    const note = make(namesOf(app))
    if (note === undefined) return
    const actor = agentId ?? MAIN
    const href = note.ref === undefined ? null : refHref(here.conn.endpoint, note.ref)
    await recordActivity($, app, {
      at: await $.clock.now(),
      agentId: actor,
      handle,
      direction: 'out',
      kind: note.kind,
      text: note.text,
      ...(href === null ? {} : { href }),
    })
    if (touchesPlugins(note)) detach(askRefresh($, app, 'soon'))
  } catch {
    // The call went through; its entry in the feed is a detail.
  }
}

/**
 * A page of alerts, into the feed and the counts. An alert already counted (fetched again after a
 * restart, or already delivered) changes nothing. The workspace's activity counts every alert from
 * anyone but this session's handles, task receipts aside (those echo task actions, this session's
 * own included); the feed logs the ones that reach this session.
 */
async function noteArrivals($: EngineInterface, app: App, alerts: readonly OrchardAlert[], kept: readonly OrchardAlert[]) {
  const { ls, rt } = app
  const here = rt.current
  if (here === undefined) return
  const done = new Set([...ls.seenAlerts, ...ls.record.delivered])
  const fresh = alerts.filter(a => !done.has(a.id))
  if (fresh.length === 0) return
  ls.seenAlerts = remember(ls.seenAlerts, fresh.map(a => a.id))
  // A handle given back a moment ago may still have a message on its way in.
  const mine = new Set([...myHandles(app), ...lingering(app.ls.subs, await $.clock.now())])
  const others = fresh.filter(a => !mine.has(a.senderId) && !isReceipt(a))
  await followOthers($, app, others.map(a => a.arrivedAt))
  const reaching = new Set(kept.map(a => a.id))
  for (const alert of others) {
    if (!reaching.has(alert.id)) continue
    const href = alertHref(here.conn.endpoint, alert)
    await recordActivity($, app, {
      at: alert.arrivedAt,
      agentId: MAIN,
      handle: handleOf(app, MAIN),
      direction: 'in',
      kind: alert.kind,
      text: inboundText(alert),
      ...(href === null ? {} : { href }),
    })
  }
}

/**
 * The count of alerts from others in the last ten minutes follows the arrivals, and falls by itself
 * as they leave the window: one timer, set for when the oldest does. The timer is replaced before
 * anything is awaited, so two calls together leave one.
 */
async function followOthers($: EngineInterface, app: App, arrivals: readonly number[]) {
  const { ls } = app
  const now = await $.clock.now()
  ls.othersAt = withinWindow([...ls.othersAt, ...arrivals], now)
  if (arrivals.length > 0) ls.lastOtherAt = Math.max(ls.lastOtherAt ?? 0, ...arrivals)
  ls.decayTimer?.cancel()
  ls.decayTimer = undefined
  const oldest = ls.othersAt[0]
  if (oldest !== undefined && !ls.isDisconnected) {
    ls.decayTimer = $.clock.after(Math.max(0, oldest + OTHERS_WINDOW_MS - now), () => {
      ls.decayTimer = undefined
      detach(followOthers($, app, []))
    })
  }
  const recentFromOthers = ls.othersAt.length
  const lastAt = ls.lastOtherAt
  await putWorkspaceActivity($, current => ({ ...current, recentFromOthers, ...(lastAt === undefined ? {} : { lastAt }) }))
}

// ---- the agents of this session ----

/**
 * Looks at `$.agent.list()` and lets the table follow it; also lets agents that ended long enough
 * ago go. The list is asked for only when an agent is live (or `isForced`: a turn of an agent the
 * table may not know ended), so a session with none costs nothing.
 */
async function lookAtAgents($: EngineInterface, app: App, isForced = false) {
  const { ls } = app
  ls.agentTimer?.cancel()
  ls.agentTimer = undefined
  try {
    const listed = isForced || anyMoving(await read($, agents)) ? await $.agent.list() : undefined
    const now = await $.clock.now()
    await putAgents($, held => (listed === undefined ? pruned(held, now) : reconciled(held, listed, now)))
    // An agent that ended gives its handle back.
    await sweepHandles($, app)
  } catch {
    // A list that will not come is asked for again at the next look.
  }
  await armAgents($, app)
}

/** Arms the one timer that looks at the agents again; replaced before anything more is awaited, so there is never a second. */
async function armAgents($: EngineInterface, app: App) {
  const { ls } = app
  const held = await read($, agents)
  const now = await $.clock.now()
  ls.agentTimer?.cancel()
  ls.agentTimer = undefined
  const delay = nextAgentLook(held, now)
  if (delay === null) return
  ls.agentTimer = $.clock.after(delay, () => {
    detach(lookAtAgents($, app))
  })
}

/** The main loop's turn began or ended. */
async function setMainStatus($: EngineInterface, app: App, status: 'running' | 'idle') {
  const now = await $.clock.now()
  await putAgents($, held => withMain(held, { status }, now))
}

// ---- the participants this session's subagents act as ----

/**
 * The participant a call acts as, for the agent making it. The main loop acts as the session. A
 * subagent gets a handle of its own at its first Orchard call and keeps it until it ends (handles.ts
 * has the rules). Nothing here may fail the call: whatever goes wrong with the handle, the agent
 * acts as the session.
 */
async function actorFor($: EngineInterface, app: App, agentId: string | undefined): Promise<string> {
  const { ls } = app
  const base = app.rt.current?.identity.participantId ?? ''
  if (agentId === undefined || agentId === MAIN || base === '') return base
  try {
    // A claim that ends stale (the session started over under it) has given back what it took, and the session is
    // still connected: the call claims once more, once, rather than act as the session for the rest of the call.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const now = await $.clock.now()
      if (stanceOf(touch(ls.subs, agentId, now), now) !== 'try') break
      const epoch = ls.subs.epoch
      await claimOnce($, app, agentId)
      if (ls.subs.epoch === epoch || ls.isDisconnected) break
    }
  } catch {
    // The handle is bookkeeping; the call goes on as the session.
  }
  return handleOf(app, agentId)
}

/**
 * One claim per agent at a time: a second call of an agent whose claim is running waits for it and gets its answer.
 * releaseHandles forgets the claims running, so a call after a restart of the pool starts a claim of its own.
 */
function claimOnce($: EngineInterface, app: App, agentId: string): Promise<void> {
  const { subClaims } = app.ls
  const running = subClaims.get(agentId)
  if (running !== undefined) return running
  const work: Promise<void> = claimHandle($, app, agentId)
    .catch(() => undefined)
    .finally(() => {
      // Not a claim that took this one's place after the pool was restarted.
      if (subClaims.get(agentId) === work) subClaims.delete(agentId)
    })
  subClaims.set(agentId, work)
  return work
}

/**
 * Takes a pooled handle for the agent: a slot no other session holds, its lease, then resume (join
 * the first time). Any failure, or a full pool, leaves the agent acting as the session.
 */
async function claimHandle($: EngineInterface, app: App, agentId: string) {
  const { rt, ls } = app
  const here = rt.current
  const book = ls.subs
  if (here === undefined || ls.isDisconnected) return
  const epoch = book.epoch
  // Disconnected or started over while this ran: whatever it took is given back.
  const isStale = () => book.epoch !== epoch || ls.isDisconnected
  let held: { slot: number; handle: string } | undefined
  try {
    // An agent the table does not know yet (a forked skill's), or whose row says it ended (a message may have resumed it),
    // is looked for in the engine's list once, so its end, or its running again, is seen.
    const row = (await read($, agents))[agentId]
    if (row === undefined || isEnded(row.status)) await lookAtAgents($, app, true)
    const slot = await takeSlot($, app, agentId)
    if (typeof slot !== 'number') return await fallBack($, app, agentId, slot)
    held = { slot, handle: subHandle(here.identity.participantId, slot) }
    const identity = { participantId: held.handle, name: subName(here.identity.name, slot) }
    const entered = await enterOnce(runner($), enteringOf(book, held.handle), here.conn, identity)
    const entry = book.agents.get(agentId)
    if (entered.exitCode !== EXIT_OK || entry === undefined || isStale()) {
      await giveBack($, app, held, true)
      held = undefined
      if (entered.exitCode !== EXIT_OK) await fallBack($, app, agentId, 'failed')
      return
    }
    entry.pooled = held
    entry.sharedUntil = undefined
    entry.isNoted = false
    held = undefined
    ls.names.set(identity.participantId, identity.name)
    armHandles($, app)
    try {
      await showHandle($, app, agentId)
    } catch {
      // The table is a courtesy; the handle is held.
    }
  } catch {
    try {
      if (held !== undefined) await giveBack($, app, held, true)
      await fallBack($, app, agentId, 'failed')
    } catch {
      // The agent acts as the session either way.
    }
  }
}

/**
 * Reserves the lowest slot no other session holds and takes its lease, true to lease.ts: a lease
 * another session beat recently keeps the slot; this session's own, or a stale one, does not. The
 * write is read back, because two sessions can write together and the store is the only thing they
 * share; one that lost the race is found at the next beat (beatHandles). Otherwise why there is none:
 * `full` when no slot is free, `failed` when the store would not keep a lease.
 */
async function takeSlot($: EngineInterface, app: App, agentId: string): Promise<number | 'full' | 'failed'> {
  const { rt, ls } = app
  const here = rt.current
  if (here === undefined) return 'full'
  const { endpoint } = here.conn
  const book = ls.subs
  let isRefused = false
  for (const slot of freeSlots(book)) {
    if (book.slots.has(slot)) continue
    // Reserved before anything is awaited: an agent racing for the same slot passes it by.
    book.slots.set(slot, agentId)
    let isTaken = false
    try {
      const key = leaseKey(endpoint, subHandle(here.identity.participantId, slot))
      const now = await $.clock.now()
      const holder = await leaseHolder($, ls)
      if (isHeldByOther(parseLease(await storeGet($, key)), holder, now)) continue
      if (!(await storeSet($, app, key, { session: holder, at: now }))) isRefused = true
      if (parseLease(await storeGet($, key))?.session !== holder) continue
      isTaken = true
      return slot
    } finally {
      if (!isTaken) book.slots.delete(slot)
    }
  }
  return isRefused ? 'failed' : 'full'
}

/**
 * A handle goes back to the pool: its lease is deleted if it is still this session's, and only then
 * is the slot free for another agent here (one that took it sooner would have its fresh lease deleted).
 */
async function giveBack($: EngineInterface, app: App, held: { slot: number; handle: string }, isOurs: boolean) {
  const { rt, ls } = app
  try {
    const here = rt.current
    if (isOurs && here !== undefined) {
      const key = leaseKey(here.conn.endpoint, held.handle)
      if (parseLease(await storeGet($, key))?.session === (await leaseHolder($, ls))) {
        try {
          await $.store.delete(key)
        } catch {
          // The lease then goes stale on its own.
        }
      }
    }
  } finally {
    ls.subs.slots.delete(held.slot)
  }
}

/** The agent acts as the session for now, and asks for a handle again no sooner than a minute from now. The feed says so once. */
async function fallBack($: EngineInterface, app: App, agentId: string, reason: ShareReason) {
  const entry = app.ls.subs.agents.get(agentId)
  if (entry === undefined) return
  const now = await $.clock.now()
  entry.sharedUntil = now + SHARE_RETRY_MS
  const isFirst = !entry.isNoted
  entry.isNoted = true
  await showHandle($, app, agentId)
  if (!isFirst) return
  // Not through recordActivity: this is the mod's note, not the agent's last action.
  const text = shareNote(reason)
  await putActivity($, feed => pushActivity(feed, { at: now, agentId, handle: app.rt.current?.identity.participantId ?? '', direction: 'out', kind: 'handle', text }, ACTIVITY_KEEP))
}

/** The agents table shows the participant the agent acts as. */
async function showHandle($: EngineInterface, app: App, agentId: string) {
  const entry = app.ls.subs.agents.get(agentId)
  const as = entry === undefined ? undefined : shown(app.rt.current?.identity.participantId ?? '', entry)
  if (as !== undefined) await putAgents($, held => withHandle(held, agentId, as))
}

/** An agent that ended (or that nothing will ever say ended) gives its handle back. */
async function sweepHandles($: EngineInterface, app: App) {
  const book = app.ls.subs
  if (book.agents.size === 0) return
  for (const agentId of finished(book, await read($, agents), await $.clock.now())) await forgetAgent($, app, agentId)
}

async function forgetAgent($: EngineInterface, app: App, agentId: string) {
  const book = app.ls.subs
  const entry = book.agents.get(agentId)
  if (entry === undefined) return
  const held = entry.pooled
  entry.pooled = undefined
  book.agents.delete(agentId)
  markReleased(book, [...(held === undefined ? [] : [held.handle]), ...entry.observed], await $.clock.now())
  if (held === undefined) return
  await giveBack($, app, held, true)
  // The tasks and roles it held no longer count as this session's.
  detach(askRefresh($, app, 'soon'))
}

/**
 * session.end, Disconnect, a start over: every handle goes back, and a claim still running undoes itself.
 * Nothing is awaited before no call is pinned to a handle and no beat may renew its lease any more.
 */
async function releaseHandles($: EngineInterface, app: App) {
  const { ls } = app
  const book = ls.subs
  book.epoch += 1
  ls.subTimer?.cancel()
  ls.subTimer = undefined
  const held: { slot: number; handle: string }[] = []
  const joined: string[] = []
  for (const entry of book.agents.values()) {
    if (entry.pooled !== undefined) held.push(entry.pooled)
    joined.push(...entry.observed)
    entry.pooled = undefined
  }
  book.agents.clear()
  // A claim that began before this is not joined by a call after it: that call claims on its own.
  ls.subClaims.clear()
  markReleased(book, [...held.map(h => h.handle), ...joined], await $.clock.now())
  for (const handle of held) await giveBack($, app, handle, true)
}

/** Keeps the timer going while the book holds anything: one beat of the leases, then the next. */
function armHandles($: EngineInterface, app: App) {
  const { ls } = app
  if (ls.subTimer !== undefined || ls.isDisconnected || ls.subs.agents.size === 0) return
  ls.subTimer = $.clock.after(LEASE_BEAT_MS, () => {
    detach(beatHandles($, app))
  })
}

/**
 * Renews the held leases the way the session's own is renewed, and lets go of the handles of agents
 * that ended. A lease another session now holds (two wrote together) is not renewed: its agent goes
 * back to acting as the session, as a listener that finds another's lease stands down.
 */
async function beatHandles($: EngineInterface, app: App) {
  const { rt, ls } = app
  ls.subTimer = undefined
  try {
    const here = rt.current
    if (here === undefined || ls.isDisconnected) return
    await sweepHandles($, app)
    const holder = await leaseHolder($, ls)
    const now = await $.clock.now()
    for (const [agentId, entry] of [...ls.subs.agents]) {
      const held = entry.pooled
      if (held === undefined) continue
      const key = leaseKey(here.conn.endpoint, held.handle)
      const lease = parseLease(await storeGet($, key))
      // Given back while the lease was read (its agent ended, the session did): not renewed, or it would outlive the slot.
      if (entry.pooled !== held || ls.isDisconnected) continue
      if (isHeldByOther(lease, holder, now)) {
        entry.pooled = undefined
        markReleased(ls.subs, [held.handle], now)
        await giveBack($, app, held, false)
        // Not for an agent let go, or a new one in its place, while the slot was given back.
        if (ls.subs.agents.get(agentId) === entry) await fallBack($, app, agentId, 'taken')
      } else {
        await storeSet($, app, key, { session: holder, at: now })
      }
    }
  } catch {
    // The next beat tries again.
  } finally {
    armHandles($, app)
  }
}

/**
 * A subagent's Bash command that joins or resumes as a participant through the Orchard CLI (the
 * orchard skill does): that participant is shown as the agent's and counted as the session's.
 * Nothing is registered, leased or pinned for it. Like a participantId in .orchard.json, a name the
 * model wrote must not be a human's: only Claude-style ids are taken, never the owner's or a pooled one.
 */
async function noteJoined($: EngineInterface, app: App, agentId: string, command: unknown) {
  try {
    const me = app.rt.current?.identity.participantId
    const id = typeof command === 'string' ? joinedAs(command) : undefined
    if (me === undefined || id === undefined || agentId === MAIN || app.ls.isDisconnected || id === me) return
    if (!id.startsWith(PROJECT_ID_PREFIX) || RESERVED_IDS.includes(id.toLowerCase()) || POOL_SUFFIX.test(id)) return
    if (!observe(app.ls.subs, agentId, id, await $.clock.now())) return
    await showHandle($, app, agentId)
    armHandles($, app)
  } catch {
    // Watching is a courtesy; the command runs either way.
  }
}

// ---- tasks and plugins, kept current ----

/**
 * Asks for the workspace to be read again (tasks, decisions, roles, state markers). A burst of asks
 * is one read, a second after the first. A `receipt` also waits until READ_FLOOR_MS after the last
 * read; a `soon` ask (this session's own write, a decision answered) does not. The check for a timer
 * already waiting and the setting of the new one come with nothing awaited between them.
 */
async function askRefresh($: EngineInterface, app: App, kind: 'receipt' | 'soon') {
  const { ls } = app
  if (ls.isDisconnected) return
  const now = await $.clock.now()
  const floor = kind === 'receipt' && ls.workReadAt !== undefined ? ls.workReadAt + READ_FLOOR_MS - now : 0
  const due = now + Math.max(WORK_DEBOUNCE_MS, floor)
  if (ls.workTimer !== undefined && ls.workDueAt !== undefined && ls.workDueAt <= due) return
  ls.workTimer?.cancel()
  ls.workDueAt = due
  ls.workTimer = $.clock.after(due - now, () => {
    ls.workTimer = undefined
    ls.workDueAt = undefined
    detach(refreshWorkspace($, app))
  })
}

/** The slow safety refresh that catches what no alert announced. It runs only while the pane is open and re-arms itself. */
function armSafety($: EngineInterface, app: App) {
  const { ls } = app
  ls.safetyTimer?.cancel()
  ls.safetyTimer = undefined
  if (!ls.isPaneOpen || ls.isDisconnected) return
  ls.safetyTimer = $.clock.after(SAFETY_REFRESH_MS, () => {
    ls.safetyTimer = undefined
    detach(refreshWorkspace($, app).finally(() => armSafety($, app)))
  })
}

/** The pane opened (or was drawn): keep it fresh from now on. */
async function paneOpened($: EngineInterface, app: App) {
  const { ls } = app
  if (!ls.isPaneOpen) {
    ls.isPaneOpen = true
    armSafety($, app)
  }
  await putHeartbeat($, () => ({ lastPollAt: ls.lastPollAt }))
}

/** The pane closed: no timer of its own runs on. */
function paneClosed(app: App) {
  const { ls } = app
  ls.isPaneOpen = false
  ls.safetyTimer?.cancel()
  ls.safetyTimer = undefined
}

const asTask = (endpoint: string, storeId: string, row: Record<string, unknown>): OrchardPaneTask | undefined =>
  typeof row.id !== 'string'
    ? undefined
    : {
        id: row.id,
        title: snippetOf(typeof row.title === 'string' ? row.title : row.id),
        status: (typeof row.status === 'string' ? row.status : 'in_progress').replace(/_/g, ' '),
        href: taskHref(endpoint, storeId, row.id),
      }

/** In-progress tasks assigned to one of `handles`, in each attached task store. Undefined when the workspace could not say. */
async function readClaims($: EngineInterface, app: App, storeIds: readonly string[], handles: readonly string[]): Promise<OrchardPaneTask[] | undefined> {
  const here = app.rt.current
  if (here === undefined) return undefined
  const tasks: OrchardPaneTask[] = []
  for (const storeId of storeIds.slice(0, 4)) {
    const listed = await tool($, app.rt, 'tasks_list', { store_id: storeId, status: 'in_progress' })
    const rows = listed.exitCode === EXIT_OK ? taskRows(listed.json) : undefined
    if (rows === undefined) return undefined
    for (const row of rows) {
      if (typeof row.assignee !== 'string' || !handles.includes(row.assignee)) continue
      const task = asTask(here.conn.endpoint, storeId, row)
      if (task !== undefined) tasks.push(task)
    }
  }
  return tasks
}

/** Open tasks across the task stores. Null with no store; undefined when the workspace could not say. */
async function countOpenTasks($: EngineInterface, app: App, storeIds: readonly string[]): Promise<number | null | undefined> {
  if (storeIds.length === 0) return null
  let total = 0
  for (const storeId of storeIds.slice(0, 4)) {
    const listed = await tool($, app.rt, 'tasks_list', { store_id: storeId, status: 'open' })
    const rows = listed.exitCode === EXIT_OK ? taskRows(listed.json) : undefined
    if (rows === undefined) return undefined
    total += rows.length
  }
  return total
}

/** The decisions that any of `handles` raised and the owner has not answered, as the pane lists them. Undefined when the workspace could not say. */
async function readOpenDecisions($: EngineInterface, app: App, handles: readonly string[]): Promise<OrchardPaneDecision[] | undefined> {
  const here = app.rt.current
  if (here === undefined) return undefined
  const asRow = (m: { id: string; body: string; sentAt: string }) => ({ id: m.id, snippet: snippetOf(m.body), sentAt: m.sentAt, href: messageHref(here.conn.endpoint, m.id) })
  const listed = await listedDecisions($, app, handles)
  if (listed !== undefined) {
    const parsed = listed.map(parseHistoryMessage).filter((m): m is NonNullable<typeof m> => m !== undefined)
    if (parsed.length === listed.length) return parsed.map(asRow)
  }
  const window = await readWindow($, app)
  if (window.kind !== 'ok') return undefined
  return openDecisions(window.messages, handles, (await read($, workspace))?.ownerId ?? 'owner').map(asRow)
}

/**
 * Reads the workspace for what the status line, the band and the pane show: the open tasks, this
 * session's claimed tasks, the decisions it waits on, and (for the plugins that are attached) the
 * roles and state markers of its handles. A part the workspace could not say keeps its last value.
 * One at a time; a request that comes in meanwhile runs once more when this one ends. `known` is a
 * `workspace_info` answer the caller already holds.
 */
async function refreshWorkspace($: EngineInterface, app: App, known?: unknown) {
  const { ls, rt } = app
  const here = rt.current
  if (here === undefined || ls.isDisconnected) return
  if (ls.isRefreshingWork) {
    ls.isWorkDirty = true
    return
  }
  ls.isRefreshingWork = true
  try {
    ls.workReadAt = await $.clock.now()
    let info = known
    if (info === undefined) {
      const answer = await tool($, rt, 'workspace_info', {})
      if (answer.exitCode !== EXIT_OK) return
      info = answer.json
    }
    const handles = myHandles(app)
    const storeIds = taskStoreIds(info)
    const attached = attachedPluginIds(info)
    const open = await countOpenTasks($, app, storeIds)
    const claimed = await readClaims($, app, storeIds, handles)
    const decisions = await readOpenDecisions($, app, handles)
    const roles = attached.includes('roles') ? await readRoles($, app, handles) : []
    const claimedIds = new Set((claimed ?? []).map(t => t.id))
    const states = attached.includes('state') && claimed !== undefined ? await readStates($, app, handles, claimedIds) : attached.includes('state') ? undefined : []
    await putWorkspaceActivity($, current => ({ ...current, ...(open === undefined ? {} : { openTasks: open }) }))
    await putPlugins($, current => ({
      attached,
      roles: roles ?? current.roles,
      states: states ?? current.states,
      decisions: decisions ?? current.decisions,
      tasks: claimed ?? current.tasks,
    }))
    if (decisions !== undefined) await syncCounts($, app, decisions.length)
  } catch {
    // The next receipt, refresh or the slow timer tries again.
  } finally {
    ls.isRefreshingWork = false
    if (ls.isWorkDirty) {
      ls.isWorkDirty = false
      // An ask that came in while this read ran has been through its floor already.
      detach(askRefresh($, app, 'soon'))
    }
  }
}

/** The roles `handles` declared (Roles plugin). Undefined when the workspace could not say. */
async function readRoles($: EngineInterface, app: App, handles: readonly string[]): Promise<OrchardPlugins['roles'] | undefined> {
  const result = await tool($, app.rt, 'plugin_call', { plugin_id: 'roles', operation: 'roles_list', arguments: {} })
  return result.exitCode === EXIT_OK ? declaredRoles(result.json, handles) : undefined
}

/** The state markers `handles` created or that sit on a task they claimed (State plugin). Undefined when the workspace could not say. */
async function readStates($: EngineInterface, app: App, handles: readonly string[], claimedIds: ReadonlySet<string>): Promise<OrchardPlugins['states'] | undefined> {
  const here = app.rt.current
  if (here === undefined) return undefined
  const result = await tool($, app.rt, 'state_list', {})
  return result.exitCode === EXIT_OK ? stateMarkers(result.json, handles, claimedIds, id => stateHref(here.conn.endpoint, id)) : undefined
}

// ---- the pane ----

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

/**
 * Disconnect: this session stops listening, lets go of the lease and wakes for nothing, until
 * Connect. Everything that would call the workspace on its own goes: the loop and its watchdog, the
 * retry, the flush and hold timers, the refresh timers. Memory only; the next session connects as usual.
 */
async function disconnect($: EngineInterface, app: App) {
  const { rt, ls } = app
  if (ls.isDisconnected) return
  ls.isDisconnected = true
  stopLoop(ls, 'disconnected')
  rt.timer?.cancel()
  rt.timer = undefined
  for (const timer of [ls.watchdog, ls.leaseTimer, ls.flushTimer, ls.workTimer, ls.safetyTimer, ls.decayTimer]) timer?.cancel()
  ls.watchdog = undefined
  ls.leaseTimer = undefined
  ls.flushTimer = undefined
  ls.workTimer = undefined
  ls.workDueAt = undefined
  ls.safetyTimer = undefined
  ls.decayTimer = undefined
  ls.isRearmWanted = false
  ls.othersAt = []
  ls.lastOtherAt = undefined
  endHold($, app)
  await releaseLease($, app)
  await releaseHandles($, app)
  await putWorkspaceActivity($, () => EMPTY_WORKSPACE_ACTIVITY)
  await setStatus($, app, { kind: 'disconnected' })
}

/** Connect: a disconnected session starts again as at session start. False when it was not disconnected. */
async function connect($: EngineInterface, app: App): Promise<boolean> {
  if (!app.ls.isDisconnected) return false
  detach(start($, app, await $.session.cwd()))
  return true
}

function paneHandlers($: EngineInterface, app: App): PaneHandlers {
  return {
    open: href => detach(openInOrchard($, href)),
    disconnect: () => detach(disconnect($, app)),
    connect: () => detach(connect($, app)),
  }
}

// ---- the model's tools ----

type ToolAnswer = { result: string } | { deny: string }

const denied = (message: string): ToolAnswer => ({ deny: `Orchard: ${message}` })

const DISCONNECTED = 'this session is disconnected from Orchard; /orchard connect puts it back'

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

/** `as` is the participant the message is sent as: the caller's handle, so two agents sending the same words are two messages. */
async function sendMessage(
  $: EngineInterface,
  app: App,
  label: string,
  as: string,
  identity: unknown,
  message: Record<string, unknown>,
): Promise<{ result: CliResult; id: string | undefined }> {
  const result = await mutate($, app, label, { as, identity }, requestId =>
    tool($, app.rt, 'mail_send', { ...message, request_id: requestId, sender_id: as }, { scrub: [requestId, as] }),
  )
  return { result, id: messageIdOf(result) }
}

/** The destination's participant, when it is a direct message: the name to look up for the feed. */
const directTo = (destination: { kind: string; id?: string }): string[] => (destination.kind === 'direct' && destination.id !== undefined ? [destination.id] : [])

async function answerSend($: EngineInterface, app: App, input: unknown, agentId: string | undefined, as: string): Promise<ToolAnswer> {
  const parsed = parseSend(input)
  if (!parsed.ok) return denied(parsed.message)
  const { destination, body } = parsed.value
  const { result, id } = await sendMessage($, app, 'send', as, parsed.value, { destination, body })
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result)
  // A message the session starts is a thread it is in: the listener is the session's, whichever of its agents sent it.
  if (id !== undefined) await noteParticipation($, app, [id])
  await logOutbound($, app, agentId, as, names => sendNote(destination, body, names, id), {
    people: directTo(destination),
    ...(destination.kind === 'channel' ? { channel: destination.id } : {}),
  })
  return { result: `Sent${id === undefined ? '' : `. message_id: ${id}`}` }
}

async function answerReply($: EngineInterface, app: App, input: unknown, agentId: string | undefined, as: string): Promise<ToolAnswer> {
  const parsed = parseReply(input)
  if (!parsed.ok) return denied(parsed.message)
  const window = await readWindow($, app)
  if (window.kind === 'offline') return { deny: 'Orchard: the workspace is not reachable right now; try again shortly.' }
  if (window.kind === 'failed') return denied(clean(app, window.message))
  const target = window.messages.find(m => m.id === parsed.value.messageId)
  if (target === undefined) return denied('that message is not among the recent messages; send with orchard_send instead')
  // A message this agent sent goes where it went; one from anyone else, the session's own participant included, is answered directly to its sender.
  const destination = replyDestination(target, as)
  if (destination === undefined) return denied('that message has no one to reply to; send with orchard_send instead')

  const { result, id } = await sendMessage($, app, 'reply', as, parsed.value, {
    destination,
    body: parsed.value.body,
    thread_id: target.id,
  })
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result)
  // Posting in a thread makes it one the session is in: everything in the window under the same root.
  const parents = parentsOf(window.messages)
  const root = rootOf(target.id, parents)
  const thread = window.messages.filter(m => rootOf(m.id, parents) === root).map(m => m.id)
  await noteParticipation($, app, id === undefined ? thread : [...thread, id])
  await logOutbound($, app, agentId, as, names => replyNote(names.person(target.senderId), parsed.value.body, id, target.id), { people: [target.senderId] })
  return { result: `Replied${id === undefined ? '' : `. message_id: ${id}`}` }
}

async function answerAck($: EngineInterface, app: App, input: unknown, agentId: string | undefined, as: string): Promise<ToolAnswer> {
  const parsed = parseAck(input)
  if (!parsed.ok) return denied(parsed.message)
  const result = await mutate($, app, 'ack', { as, ...parsed.value }, requestId => {
    const args = ['ack', '--participant-id', as]
    for (const id of parsed.value.messageIds) args.push('--message-id', id)
    args.push('--request-id', requestId)
    return cli($, app.rt, args, { scrub: [requestId, as] })
  })
  if (result.exitCode !== EXIT_OK) return failureAnswer(app, result)
  await logOutbound($, app, agentId, as, () => ackNote(parsed.value.messageIds.length))
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

async function answerCall($: EngineInterface, app: App, input: unknown, agentId: string | undefined, as: string): Promise<ToolAnswer> {
  const parsed = parseCall(input)
  if (!parsed.ok) return denied(parsed.message)
  const { tool: name } = parsed.value
  const isMutating = MUTATING_CALLS.has(name)
  // A mutation acts as the caller's participant (its handle, or the session's), whatever the model
  // wrote: the server trusts the id it is given.
  const pinned = pinActor(name, parsed.value.args, as)
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
  if (isMutating || name === 'plugin_call') {
    const destination = name === 'mail_send' ? (args.destination as { kind: string; id?: string } | undefined) : undefined
    await logOutbound($, app, agentId, as, names => callNote(name, args, result.json, names), {
      people: destination === undefined ? [] : directTo(destination),
      ...(destination?.kind === 'channel' && destination.id !== undefined ? { channel: destination.id } : {}),
    })
  }
  return { result: clean(app, frameData(`orchard_call ${name}`, withoutJoiningPrompt(result.json ?? null), newNonce())) }
}

async function answerTool($: EngineInterface, app: App, name: string, input: unknown, agentId: string | undefined): Promise<ToolAnswer> {
  // A disconnected session is out of the workspace: nothing the model asks reaches it.
  if (app.ls.isDisconnected) return denied(DISCONNECTED)
  // The participant this call acts as, settled once at the start: a handle given back mid-call does not change who sent it.
  const as = await actorFor($, app, agentId)
  // Disconnected while the handle was being set up (the lease, resume, join take a while): the call must not go out as anyone.
  if (app.ls.isDisconnected) return denied(DISCONNECTED)
  try {
    switch (name) {
      case 'orchard_send':
        return await answerSend($, app, input, agentId, as)
      case 'orchard_reply':
        return await answerReply($, app, input, agentId, as)
      case 'orchard_ack':
        return await answerAck($, app, input, agentId, as)
      case 'orchard_history':
        // A read: it names no acting participant, so there is nothing to pin.
        return await answerHistory($, app, input)
      default:
        return await answerCall($, app, input, agentId, as)
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
  // The person disconnected this session: only Connect (or a new session) listens again.
  if (ls.isDisconnected) return
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
      description: 'Open the Orchard pane; /orchard notify to set notification levels; /orchard disconnect, connect or reconnect',
      argumentHint: '[notify … | disconnect | connect | reconnect]',
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
    if (e.reason !== 'clear') {
      await releaseLease($, app)
      await releaseHandles($, app)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    detach(ensureListening($, app))
    if (!isPersonsPrompt(e.origin)) return next(e)

    const { ls } = app
    // A disconnected session delivers nothing and acknowledges nothing; what is queued waits for Connect.
    if (ls.isDisconnected) return next(e)
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

  // Subagents: their descriptions arrive with the spawn. The hook only watches: it never denies or changes one.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId !== undefined) {
      const { agentId } = result
      try {
        const now = await $.clock.now()
        await putAgents($, held => withSpawned(held, { agentId, description: e.description, type: e.subagentType }, now))
        await armAgents($, app)
      } catch {
        // The table is a courtesy; the subagent started.
      }
    }
    return result
  })

  // A subagent's run raises no turn.start: this one is the main loop's.
  on('turn.start', async ($, e, next) => {
    detach(setMainStatus($, app, 'running'))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // A turn that ends in a subagent's loop: look at the list now, in case it was the agent's last.
    if (e.agentId === undefined) detach(setMainStatus($, app, 'idle'))
    else detach(lookAtAgents($, app, true))
    detach(ensureListening($, app))
    return next(e)
  })

  on('command.run', { command: 'orchard' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    if (word === 'reconnect') {
      detach(start($, app, await $.session.cwd()))
      return { text: 'Reconnecting to Orchard…' }
    }
    if (word === 'disconnect') {
      if (app.ls.isDisconnected) return { text: 'Orchard is already disconnected. /orchard connect listens again.' }
      await disconnect($, app)
      return { text: 'Disconnected from Orchard: not listening, nothing wakes this session. /orchard connect puts it back.' }
    }
    if (word === 'connect') {
      return { text: (await connect($, app)) ? 'Connecting to Orchard…' : 'Orchard is already connected (/orchard reconnect starts over).' }
    }
    if (word === 'notify') return { text: await runNotify($, app, rest.join(' ')) }
    if (word !== '') return { text: 'Usage: /orchard [notify … | disconnect | connect | reconnect]' }

    // The tasks and plugins are read as the pane opens, so it does not draw what was true a while ago.
    detach(refreshWorkspace($, app))
    const opened = await $.ui.open({ id: PANE, title: 'Orchard', focus: true })
    await paneOpened($, app)
    return { text: opened.isPlaced ? 'Orchard pane opened.' : 'Orchard pane: widen the terminal to see it.' }
  })

  // A subagent that joins Orchard on its own is seen here. The hook only watches: the command runs as it was,
  // and a hook that fails is skipped by the engine, so there is no `.catch` that could run it twice.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined) detach(noteJoined($, app, e.agentId, e.command))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__orchard__orchard_send' }, ($, e) => answerTool($, app, 'orchard_send', e, e.agentId))
  on('tool.call', { tool: 'mcp__orchard__orchard_reply' }, ($, e) => answerTool($, app, 'orchard_reply', e, e.agentId))
  on('tool.call', { tool: 'mcp__orchard__orchard_ack' }, ($, e) => answerTool($, app, 'orchard_ack', e, e.agentId))
  on('tool.call', { tool: 'mcp__orchard__orchard_history' }, ($, e) => answerTool($, app, 'orchard_history', e, e.agentId))
  on('tool.call', { tool: 'mcp__orchard__orchard_call' }, ($, e) => answerTool($, app, 'orchard_call', e, e.agentId))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    paneClosed(app)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Drawn means open: from here the tasks and plugins are kept fresh (memory only; a draw may not write state).
    if (!app.ls.isPaneOpen) {
      app.ls.isPaneOpen = true
      armSafety($, app)
    }
    const t = $.ui.resolve(e)
    const table: Table = {
      Box: t.Box,
      Text: t.Text,
      Button: t.Button,
      // The terminal draws no Svg: it gets the same structure as Text.
      Svg: e.surface !== 'terminal' && 'Svg' in t ? t.Svg : undefined,
    }
    const held = await readQueue($, app)
    const pending: PendingLine[] = held.items.slice(0, 5).map(a => ({ sender: a.senderName ?? a.senderId, snippet: snippetOf(a.body) }))
    return renderPane(
      table,
      {
        participantId: app.rt.current?.identity.participantId ?? '',
        workspaceName: (await read($, workspace))?.name ?? '',
        workspaceHref: app.rt.current === undefined ? null : workspaceHref(app.rt.current.conn.endpoint),
        status: await read($, status),
        counts: await read($, counts),
        pending,
        plugins: await read($, plugins),
        agents: await read($, agents),
        activity: await read($, activity),
        // Read (the atom, to be drawn again when it moves) and shown from memory, which is never behind it.
        lastPollAt: app.ls.lastPollAt ?? (await read($, heartbeat)).lastPollAt,
        nowMs: await $.clock.now(),
        columns: typeof e.props.bodyColumns === 'number' ? e.props.bodyColumns : undefined,
        surface: e.surface,
      },
      paneHandlers($, app),
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // The band reads one atom: the line itself, written only when its text changes.
    const line = await read($, band)
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

