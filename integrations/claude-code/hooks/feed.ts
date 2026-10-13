// What the mod keeps of this session's life in Orchard, as pure functions: the activity feed's
// sentences, the table of agents (main and subagents) and how it follows `$.agent.list()`, the
// workspace-wide counts, and what the optional plugins (tasks, roles, state) hold for this
// session's handles. No `$` here; register.tsx makes every call and every write.
import type { OrchardActivityEntry, OrchardAgent, OrchardAgentStatus, OrchardAgents, OrchardAlert, OrchardPlugins } from '../types'
import { plain } from './config'
import type { SignOn, Shown } from './handles'
import { MUTATING_CALLS, PINNED_PLUGIN_WRITE } from './tools'
import type { Destination } from './tools'

/** The agent id of the session's own loop. */
export const MAIN = 'main'

/** How many entries the activity feed keeps. */
export const ACTIVITY_KEEP = 60
/** "Recent" for the workspace's activity from others. */
export const OTHERS_WINDOW_MS = 10 * 60_000
/** How often the agent table is compared with `$.agent.list()` while an agent is live. */
export const AGENT_POLL_MS = 2_000
/** How long an agent that ended stays in the table. */
export const AGENT_LINGER_MS = 2 * 60_000
/** Workspace reads that a receipt asks for run at most this often. */
export const READ_FLOOR_MS = 30_000
/** Alert ids remembered as counted and logged. */
export const SEEN_KEEP = 300

/** An entry that is one line of the feed: no control characters, cut short. */
const line = (text: string, max = 100) => plain(text, max)

// ---- the activity feed ----

/** The feed with `entry` added, the oldest forgotten past `keep`. */
export function pushActivity(list: readonly OrchardActivityEntry[], entry: OrchardActivityEntry, keep = ACTIVITY_KEEP): OrchardActivityEntry[] {
  return [...list, entry].slice(-keep)
}

/** What `absorb` tells the feed about an alert, in words a person reads: who, how it reached this session, what it said. */
export function inboundText(alert: Pick<OrchardAlert, 'senderName' | 'senderId' | 'reasons' | 'where' | 'body' | 'kind'>): string {
  const who = line(alert.senderName ?? alert.senderId, 40)
  const how = alert.reasons.includes('mention')
    ? 'mention'
    : alert.reasons.includes('direct')
      ? 'DM'
      : alert.reasons.includes('reply')
        ? 'reply'
        : alert.reasons.includes('broadcast')
          ? 'broadcast'
          : alert.where.startsWith('channel ')
            ? `#${alert.where.slice('channel '.length)}`
            : alert.where
  const first = alert.body.split('\n').find(l => l.trim() !== '') ?? ''
  const snippet = line(first, 80)
  return `${who} (${how})${snippet === '' ? '' : `: ${snippet}`}`
}

/** Whose names the sentences use: a name where the directory has one, the id where it does not. */
export type Names = { person: (id: string) => string; channel: (id: string) => string }

/** What an item the sentence is about opens as; register.tsx turns it into an address. */
export type Ref = { kind: 'message'; id: string } | { kind: 'task'; storeId: string; id: string } | { kind: 'state'; id: string }

/** One thing the agent did in Orchard: its kind, the sentence, and where it opens. */
export type Note = { kind: string; text: string; ref?: Ref }

const quoted = (title: unknown): string => (typeof title === 'string' && plain(title, 60) !== '' ? ` “${plain(title, 60)}”` : '')
const humane = (word: string) => word.replace(/_/g, ' ')

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** A message sent or posted: to whom, and the start of it. */
export function sendNote(destination: Destination, body: string, names: Names, messageId?: string): Note {
  const first = body.split('\n').find(l => l.trim() !== '') ?? ''
  const snippet = line(first, 80)
  const tail = snippet === '' ? '' : `: ${snippet}`
  const text =
    destination.kind === 'direct'
      ? `Sent to ${line(names.person(destination.id), 40)}${tail}`
      : destination.kind === 'channel'
        ? `Posted in #${line(names.channel(destination.id), 40)}${tail}`
        : `Broadcast${tail}`
  return { kind: 'send', text, ...(messageId === undefined ? {} : { ref: { kind: 'message', id: messageId } }) }
}

export function replyNote(toName: string, body: string, messageId: string | undefined, targetId: string): Note {
  const first = body.split('\n').find(l => l.trim() !== '') ?? ''
  const snippet = line(first, 80)
  return { kind: 'reply', text: `Replied to ${line(toName, 40)}${snippet === '' ? '' : `: ${snippet}`}`, ref: { kind: 'message', id: messageId ?? targetId } }
}

export function ackNote(count: number): Note {
  return { kind: 'ack', text: `Acknowledged ${count} message${count === 1 ? '' : 's'}` }
}

/** The destination an `orchard_call mail_send` names, when it is a well-formed one. */
function destinationOf(value: unknown): Destination | undefined {
  const d = record(value)
  if (d.kind === 'broadcast') return { kind: 'broadcast' }
  const id = str(d.id)
  return (d.kind === 'direct' || d.kind === 'channel') && id !== undefined ? { kind: d.kind, id } : undefined
}

const CALL_WORDS: Readonly<Record<string, string>> = {
  mail_channel_create: 'Created a channel',
  artifact_delete: 'Deleted a file',
  artifact_commit: 'Committed files',
  resource_link: 'Linked a resource',
  plugin_attach: 'Attached a plugin',
  plugin_detach: 'Detached a plugin',
}

const TASK_VERBS: Readonly<Record<string, string>> = {
  task_create: 'Created',
  task_update: 'Updated',
  task_claim: 'Claimed',
  task_release: 'Released',
  task_close: 'Closed',
}

/**
 * The note for an `orchard_call` that wrote: a task claimed, closed or updated, a role declared, a
 * state marker created or moved, a message sent. Undefined for a read (it changes nothing, so it is
 * no activity) and for a write nothing here has words for. `result` is the workspace's answer, where
 * titles come from; with none, the sentence says "a task" and the like, never an id.
 */
export function callNote(tool: string, args: Record<string, unknown>, result: unknown, names: Names): Note | undefined {
  const answer = record(result)
  if (tool === 'mail_send') {
    const destination = destinationOf(args.destination)
    const id = str(record(answer.message).id)
    return destination === undefined ? undefined : sendNote(destination, typeof args.body === 'string' ? args.body : '', names, id)
  }
  if (tool === 'mail_acknowledge') return ackNote(Array.isArray(args.message_ids) ? args.message_ids.length : 0)
  if (tool in TASK_VERBS) {
    const task = record(answer.task)
    const title = task.title ?? answer.title
    const id = str(task.id) ?? str(args.task_id)
    const storeId = str(args.store_id)
    const verb = TASK_VERBS[tool] as string
    const titled = quoted(title)
    return {
      kind: 'task',
      text: titled === '' ? `${verb} a task` : `${verb} task${titled}`,
      ...(id === undefined || storeId === undefined ? {} : { ref: { kind: 'task', storeId, id } as Ref }),
    }
  }
  if (tool === 'plugin_call' && args.operation === PINNED_PLUGIN_WRITE) {
    const roles = record(args.arguments).roles
    const list = Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string').map(r => humane(plain(r, 40))) : []
    return { kind: 'role', text: list.length === 0 ? 'Cleared its declared roles' : `Declared roles: ${list.join(', ')}` }
  }
  if (tool === 'state_create' || tool === 'state_advance') {
    const marker = record(answer.marker)
    const id = str(marker.id) ?? str(args.id)
    const title = marker.title ?? args.title
    const text =
      tool === 'state_create' ? `Created state marker${quoted(title)}` : `Moved${quoted(title)}${str(args.to) === undefined ? '' : ` to ${humane(plain(str(args.to) as string, 40))}`}`
    return { kind: 'state', text, ...(id === undefined ? {} : { ref: { kind: 'state', id } as Ref }) }
  }
  if (tool === 'state_define') {
    const id = str(record(args.definition).id)
    return { kind: 'state', text: id === undefined ? 'Defined a state machine' : `Defined state machine “${humane(plain(id, 40))}”` }
  }
  if (MUTATING_CALLS.has(tool)) return { kind: 'call', text: CALL_WORDS[tool] ?? 'Changed something in the workspace' }
  return undefined
}

/** A write that changes what the plugins hold for this session: its role, its state markers, its tasks. */
export const touchesPlugins = (note: Note): boolean => note.kind === 'role' || note.kind === 'state' || note.kind === 'task'

// ---- agents ----

const STATUSES: readonly OrchardAgentStatus[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed', 'lost']
const asStatus = (value: string): OrchardAgentStatus => ((STATUSES as readonly string[]).includes(value) ? (value as OrchardAgentStatus) : 'running')

/** Ended: it will not run again by itself (a message may resume one, and then it is listed live again). */
export const isEnded = (status: OrchardAgentStatus): boolean => status === 'completed' || status === 'failed' || status === 'killed' || status === 'lost'
/** Changes by itself, so it is looked at every few seconds. An idle one waits for a message and is looked at when its turn ends. */
export const isMoving = (status: OrchardAgentStatus): boolean => status === 'pending' || status === 'running' || status === 'waiting'

/** The part of `AgentInfo` the table reads. */
export type ListedAgent = { id: string; description: string; type: string; status: string }

/** The table with the main loop's entry set (created at first), keeping what it already knew. */
export function withMain(held: OrchardAgents, patch: { handle?: string; status?: 'running' | 'idle' }, now: number): OrchardAgents {
  const have = held[MAIN]
  const handle = patch.handle ?? have?.handle
  const next: OrchardAgent = {
    ...have,
    agentId: MAIN,
    description: have?.description ?? 'Claude',
    type: 'main',
    status: patch.status ?? have?.status ?? 'idle',
    startedAt: have?.startedAt ?? now,
    ...(handle === undefined ? {} : { handle }),
  }
  return { ...held, [MAIN]: next }
}

/** A subagent the Agent tool just started. The spawn is a fact; `$.agent.list()` settles the rest. */
export function withSpawned(held: OrchardAgents, spawn: { agentId: string; description: string; type: string }, now: number): OrchardAgents {
  if (spawn.agentId === MAIN) return held
  const { endedAt: _ended, ...have } = held[spawn.agentId] ?? { startedAt: now }
  return {
    ...held,
    [spawn.agentId]: {
      ...have,
      agentId: spawn.agentId,
      description: line(spawn.description, 80),
      type: line(spawn.type, 40),
      status: 'running',
      startedAt: have.startedAt,
    },
  }
}

function followListing(have: OrchardAgent | undefined, listed: ListedAgent, now: number): OrchardAgent {
  const status = asStatus(listed.status)
  const { endedAt: _before, ...rest } = have ?? { agentId: listed.id, description: '', type: '', status, startedAt: now }
  const description = line(listed.description, 80)
  const type = line(listed.type, 40)
  return {
    ...rest,
    agentId: listed.id,
    description: description === '' ? rest.description : description,
    type: type === '' ? rest.type : type,
    status,
    ...(isEnded(status) ? { endedAt: have?.endedAt ?? now } : {}),
  }
}

/** The table without agents that ended more than AGENT_LINGER_MS ago. The main loop never goes. */
export function pruned(held: OrchardAgents, now: number): OrchardAgents {
  return Object.fromEntries(Object.entries(held).filter(([id, a]) => id === MAIN || a.endedAt === undefined || now - a.endedAt < AGENT_LINGER_MS))
}

/**
 * The table after looking at `$.agent.list()`: each listed agent takes its listed status (and is
 * added when the table did not know it, a forked skill or an agent from before a reload); one the
 * table held that is no longer listed was dropped by the engine, and is `lost` unless it was seen
 * to end. Those that ended long enough ago go.
 */
export function reconciled(held: OrchardAgents, listed: readonly ListedAgent[], now: number): OrchardAgents {
  const byId = new Map(listed.map(a => [a.id, a] as const))
  const next: OrchardAgents = {}
  for (const [id, agent] of Object.entries(held)) {
    const here = byId.get(id)
    if (id === MAIN) next[id] = agent
    else if (here !== undefined) next[id] = followListing(agent, here, now)
    else next[id] = isEnded(agent.status) ? agent : { ...agent, status: 'lost', endedAt: now }
  }
  for (const agent of listed) if (!(agent.id in held) && agent.id !== MAIN) next[agent.id] = followListing(undefined, agent, now)
  return pruned(next, now)
}

/** The table with `text` as the last thing `agentId` did in Orchard; unchanged when the table does not know the agent. */
export function withLastAction(held: OrchardAgents, agentId: string, text: string): OrchardAgents {
  const agent = held[agentId]
  return agent === undefined ? held : { ...held, [agentId]: { ...agent, lastAction: text } }
}

/**
 * The table with each agent's participant as `acts` has it (a subagent seen doing neither of the two
 * ways has none; the main loop's is the session's, set at start) and whether Orchard says that
 * participant is signed on, from `signOn`.
 */
export function withHandles(held: OrchardAgents, acts: ReadonlyMap<string, Shown>, signOn: ReadonlyMap<string, SignOn>): OrchardAgents {
  return Object.fromEntries(
    Object.entries(held).map(([id, agent]) => {
      const { handle: _handle, observed: _observed, sharesBase: _sharesBase, signedOn: _signedOn, lastContactAt: _lastContactAt, ...rest } = agent
      const as: Shown | undefined = id === MAIN ? (agent.handle === undefined ? undefined : { handle: agent.handle }) : acts.get(id)
      const word = as === undefined ? undefined : signOn.get(as.handle)
      return [
        id,
        {
          ...rest,
          ...as,
          ...(word === undefined ? {} : { signedOn: word.registered, ...(word.lastContactAt === undefined ? {} : { lastContactAt: word.lastContactAt }) }),
        },
      ]
    }),
  )
}

/** The subagents that ended between two looks at the table, one the first did not hold included. */
export function newlyEnded(before: OrchardAgents, after: OrchardAgents): string[] {
  return Object.values(after)
    .filter(a => a.agentId !== MAIN && isEnded(a.status) && !(before[a.agentId] !== undefined && isEnded((before[a.agentId] as OrchardAgent).status)))
    .map(a => a.agentId)
}

/** Some subagent is in a state that changes by itself. */
export const anyMoving = (held: OrchardAgents): boolean => Object.values(held).some(a => a.agentId !== MAIN && isMoving(a.status))

/**
 * When to look at the agents next, in ms: soon while one is live, otherwise when the first that
 * ended is due to leave the table, and never when there is nothing to wait for.
 */
export function nextAgentLook(held: OrchardAgents, now: number): number | null {
  if (anyMoving(held)) return AGENT_POLL_MS
  const due = Object.values(held)
    .filter(a => a.agentId !== MAIN && a.endedAt !== undefined)
    .map(a => (a.endedAt as number) + AGENT_LINGER_MS - now)
  return due.length === 0 ? null : Math.max(0, Math.min(...due))
}

// ---- the workspace around this session ----

/** The arrival times still inside the window. */
export function withinWindow(times: readonly number[], now: number): number[] {
  return times.filter(t => now - t < OTHERS_WINDOW_MS)
}

/** `ids` remembered, newest last, capped. */
export function remember(seen: readonly string[], ids: readonly string[]): string[] {
  return [...seen, ...ids].slice(-SEEN_KEEP)
}

// ---- what the plugins hold ----

/** The ids of the plugins `workspace_info` lists as attached. */
export function attachedPluginIds(info: unknown): string[] {
  const plugins = record(info).plugins
  return (Array.isArray(plugins) ? plugins : []).flatMap(p => {
    const item = record(p)
    return item.attached === true && typeof item.id === 'string' ? [item.id] : []
  })
}

/** The ids of the task stores `workspace_info` lists. */
export function taskStoreIds(info: unknown): string[] {
  const stores = record(record(info).workspace).task_stores
  return (Array.isArray(stores) ? stores : []).flatMap(s => (typeof record(s).id === 'string' ? [record(s).id as string] : []))
}

/** The rows of a `tasks_list` answer; undefined when it is not one. */
export function taskRows(json: unknown): Record<string, unknown>[] | undefined {
  const rows = record(json).tasks
  return Array.isArray(rows) ? rows.map(record) : undefined
}

/** The roles each of `handles` declared (those that declared any), from `roles_list`'s declarations, worded for a person (`code_review` is `code review`). */
export function declaredRoles(json: unknown, handles: readonly string[]): OrchardPlugins['roles'] {
  const declarations = record(json).declarations
  return (Array.isArray(declarations) ? declarations : []).flatMap(d => {
    const item = record(d)
    const participantId = item.participant_id
    const roles = Array.isArray(item.roles) ? item.roles.filter((r): r is string => typeof r === 'string').map(r => humane(plain(r, 40))) : []
    return typeof participantId === 'string' && handles.includes(participantId) && roles.length > 0 ? [{ participantId, roles }] : []
  })
}

/**
 * The markers of `state_list` that one of `handles` created, or that sit on a task one of them
 * claimed (`claimedTaskIds`). `hrefOf` says where one opens.
 */
export function stateMarkers(
  json: unknown,
  handles: readonly string[],
  claimedTaskIds: ReadonlySet<string>,
  hrefOf: (id: string) => string | null,
): OrchardPlugins['states'] {
  const markers = record(json).markers
  return (Array.isArray(markers) ? markers : []).flatMap(m => {
    const marker = record(m)
    const id = marker.id
    if (typeof id !== 'string') return []
    const subject = record(marker.subject)
    const isMine = typeof marker.created_by === 'string' && handles.includes(marker.created_by)
    const isOnMyTask = subject.kind === 'task' && typeof subject.task_id === 'string' && claimedTaskIds.has(subject.task_id)
    if (!isMine && !isOnMyTask) return []
    return [
      {
        id,
        title: plain(typeof marker.title === 'string' ? marker.title : id, 80),
        state: humane(plain(typeof marker.state === 'string' ? marker.state : '', 40)),
        href: hrefOf(id),
      },
    ]
  })
}

export const EMPTY_PLUGINS: OrchardPlugins = { attached: [], roles: [], states: [], decisions: [], tasks: [] }
