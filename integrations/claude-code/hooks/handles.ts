// Subagent handles, as pure functions: the pool of ids a session's subagents act as in Orchard, the
// book of who holds which slot, and the rules for taking, sharing and giving one back. A subagent that
// uses Orchard gets a participant of its own (`<base>.sub1` ...) at its first Orchard tool call, so the
// workspace's participant list and the pane can line agents up. No `$` here: register.tsx reads the
// store, makes the CLI calls and keeps the timers; this module decides.
//
// A slot, from this session's side (the lease is lease.ts's, one per slot's participant id):
//
//   FREE         no agent here has it. Its lease may be absent, stale, or this session's own (all usable),
//                or fresh and another session's (skipped).
//   RESERVED     an agent claimed it, before anything was awaited; its lease is checked, written, read back.
//   ENTERING     the lease is this session's; resume, and join the first time.
//   HELD         the agent's calls are pinned to it; the beat renews the lease.
//   GIVING BACK  `pooled` is already cleared (no call is pinned to the slot any more); the lease is deleted
//                if it is still this session's; only then is the slot FREE for another agent here, since one
//                that took it sooner would have its fresh lease deleted.
//
//   FREE -> RESERVED         a claim; slots already reserved here are passed over
//   RESERVED -> FREE         a fresh lease of another session, or a write that did not read back as ours
//   RESERVED -> ENTERING     the lease is verified
//   ENTERING -> HELD         resume (join first if never registered) succeeded
//   ENTERING -> GIVING BACK  it failed, or the session started over / disconnected meanwhile
//   HELD -> GIVING BACK      its agent ended (or went quiet, if the table does not know it), session.end
//                            (not after /clear), Disconnect, a start over
//   HELD -> FREE             a beat finds a fresh lease of another session (two wrote together): that lease
//                            is left alone and the agent acts as the session's own participant
//   GIVING BACK -> FREE
//
// An agent, from the book's side:
//
//   (none) -> CLAIMING       its first Orchard tool call
//   CLAIMING -> HELD         a slot was entered
//   CLAIMING -> SHARING      no slot was free, or entering it failed: it acts as the session's participant
//   HELD -> SHARING          its lease was lost to another session
//   SHARING -> CLAIMING      a call after SHARE_RETRY_MS, never sooner
//   any -> forgotten         it ended in the agents table (but not while its last Orchard call is newer than the
//                            row's end: it ran again and nothing has listed it since), or the table never knew it
//                            and it was quiet for UNTRACKED_IDLE_MS
import type { OrchardAgent, OrchardAgents } from '../types'
import { MAX_NAME, plain } from './config'
import { isEnded } from './feed'

/** How many subagent handles a session can hold at once. */
export const POOL_SIZE = 8
/** An agent that fell back to the session's own participant tries for a handle again no sooner than this. */
export const SHARE_RETRY_MS = 60_000
/** An agent the table does not list (a workflow's, an engine fork) is let go this long after its last Orchard call. */
export const UNTRACKED_IDLE_MS = 60_000
/** Handles a subagent joined as on its own that the book remembers per agent. */
export const MAX_OBSERVED = 4
/** A handle that was given back still counts as this session's for this long: its last message may still be arriving. */
export const RELEASED_LINGER_MS = 2 * 60_000
/** How many given-back handles the book remembers. */
const RELEASED_KEEP = 32

/** Orchard's limit on a participant id. */
const MAX_ID = 128
/** What a pooled id ends in. lease.ts keeps these keys out of its record eviction: a slot another session holds must never be forgotten. */
export const POOL_SUFFIX = /\.sub[1-9]\d*$/

/** Slot `n`'s participant id. The base is cut when the whole would pass Orchard's limit. */
export function subHandle(base: string, n: number): string {
  const suffix = `.sub${n}`
  return `${base.slice(0, MAX_ID - suffix.length)}${suffix}`
}

/** Slot `n`'s display name: the session's, then which subagent. */
export function subName(name: string, n: number): string {
  const tail = ` · subagent ${n}`
  return `${plain(name, MAX_NAME - tail.length)}${tail}`
}

/** What entering a handle keeps between attempts: a join that ended in exit 3 is retried as the same request (connect.ts). */
export type Entering = { failures: number; joinRequestId: string | undefined }

/** What the book knows of one agent that has used Orchard. */
export type AgentHandle = {
  /** The pooled handle this session owns for it (its lease is held). */
  pooled: { slot: number; handle: string } | undefined
  /** Handles it joined as on its own through the CLI (seen in a Bash command). Nothing is registered or leased for them. */
  observed: string[]
  /** It acts as the session's own participant; no new attempt for a handle before this time. */
  sharedUntil: number | undefined
  /** The note that it shares the session's participant is written once per stretch of sharing. */
  isNoted: boolean
  /** Its last Orchard call. */
  lastCallAt: number
}

export type HandleBook = {
  agents: Map<string, AgentHandle>
  /** Slots this session has reserved or holds, by the agent they are for. */
  slots: Map<number, string>
  /** Handles given back, newest last. */
  released: { handle: string; at: number }[]
  /** The join of each handle this session entered, by handle. */
  entering: Map<string, Entering>
  /** Bumped when every handle is let go (a reconnect, the end of the session): a claim that started before it undoes itself. */
  epoch: number
}

export const createBook = (): HandleBook => ({ agents: new Map(), slots: new Map(), released: [], entering: new Map(), epoch: 0 })

export function enteringOf(book: HandleBook, handle: string): Entering {
  const have = book.entering.get(handle)
  const entering = have ?? { failures: 0, joinRequestId: undefined }
  book.entering.set(handle, entering)
  return entering
}

/** The agent's entry, made at its first call; its last call is now. */
export function touch(book: HandleBook, agentId: string, now: number): AgentHandle {
  const have = book.agents.get(agentId)
  const entry = have ?? { pooled: undefined, observed: [], sharedUntil: undefined, isNoted: false, lastCallAt: now }
  entry.lastCallAt = now
  book.agents.set(agentId, entry)
  return entry
}

/**
 * What a call of this agent does about its handle: it has one, it shares the session's for now, or it
 * should try for one. A clock that moved back does not extend the wait past SHARE_RETRY_MS.
 */
export function stanceOf(entry: AgentHandle, now: number): 'have' | 'share' | 'try' {
  if (entry.pooled !== undefined) return 'have'
  const wait = entry.sharedUntil === undefined ? 0 : entry.sharedUntil - now
  return wait > 0 && wait <= SHARE_RETRY_MS ? 'share' : 'try'
}

/** The participant an agent acts as: its pooled handle, else the session's own. A handle it only joined as on its own is not pinned to. */
export function actorOf(base: string, book: HandleBook, agentId: string | undefined): string {
  return (agentId === undefined ? undefined : book.agents.get(agentId)?.pooled?.handle) ?? base
}

/** Every participant that is this session's: its own, the pooled handles held, the ones agents joined as. */
export function ownHandles(base: string, book: HandleBook): string[] {
  const all = [base]
  for (const entry of book.agents.values()) {
    if (entry.pooled !== undefined) all.push(entry.pooled.handle)
    all.push(...entry.observed)
  }
  return [...new Set(all)]
}

/** Handles given back at `now`. */
export function markReleased(book: HandleBook, handles: readonly string[], now: number): void {
  book.released = [...book.released, ...handles.map(handle => ({ handle, at: now }))].slice(-RELEASED_KEEP)
}

/** The handles given back not long ago: still this session's for what is in flight. Forgets the older ones. */
export function lingering(book: HandleBook, now: number): string[] {
  book.released = book.released.filter(r => Math.abs(now - r.at) < RELEASED_LINGER_MS)
  return book.released.map(r => r.handle)
}

/** The slots nobody in this session has, lowest first. */
export function freeSlots(book: HandleBook): number[] {
  return Array.from({ length: POOL_SIZE }, (_, i) => i + 1).filter(n => !book.slots.has(n))
}

/** What the agents table shows for the agent's handle; undefined when it has nothing to show. */
export function shown(base: string, entry: AgentHandle): { handle: string; observed?: true; sharesBase?: true } | undefined {
  if (entry.pooled !== undefined) return { handle: entry.pooled.handle }
  const seen = entry.observed.at(-1)
  if (seen !== undefined) return { handle: seen, observed: true }
  return entry.sharedUntil === undefined ? undefined : { handle: base, sharesBase: true }
}

/**
 * Which agents of the book to let go: those the table says have ended (completed, failed, killed, or
 * `lost` once they left `$.agent.list()`), and those the table does not know at all once they have been
 * quiet for UNTRACKED_IDLE_MS (nothing will ever say such an agent ended). A row that ended before the
 * agent's last Orchard call is no news: a message resumed the agent and the table has not been listed
 * since, so it is treated like an agent the table does not know.
 */
export function finished(book: HandleBook, table: OrchardAgents, now: number): string[] {
  return [...book.agents.entries()]
    .filter(([id, entry]) => {
      const listed: OrchardAgent | undefined = table[id]
      const isQuiet = Math.abs(now - entry.lastCallAt) >= UNTRACKED_IDLE_MS
      if (listed === undefined) return isQuiet
      if (!isEnded(listed.status)) return false
      return listed.endedAt !== undefined && entry.lastCallAt > listed.endedAt ? isQuiet : true
    })
    .map(([id]) => id)
}

/** Records that the agent joined as `handle` on its own. False when it was known, or the book is full for this agent. */
export function observe(book: HandleBook, agentId: string, handle: string, now: number): boolean {
  const entry = touch(book, agentId, now)
  if (entry.observed.includes(handle)) return false
  if (entry.observed.length >= MAX_OBSERVED) entry.observed.shift()
  entry.observed.push(handle)
  return true
}

/** Why an agent shares the session's participant, in words for the feed. */
export type ShareReason = 'full' | 'failed' | 'taken'

export function shareNote(reason: ShareReason): string {
  const why =
    reason === 'full' ? 'no subagent handle was free' : reason === 'failed' ? 'its own handle could not be set up' : 'another session took its handle'
  return `Shares this session's Orchard identity: ${why}`
}

/**
 * The participant a Bash command joins or resumes as through the Orchard CLI
 * (`Orchard agent join|resume ... --participant-id X`); undefined for any other command. Global
 * options may stand between `agent` and the subcommand; the match stays inside one shell segment.
 */
export function joinedAs(command: string): string | undefined {
  const flat = command.slice(0, 20_000).replace(/\\\r?\n/g, ' ')
  const found = /\bOrchard["']?\s+agent\b[^\n;&|]{0,400}?\s(?:join|resume)\s[^\n;&|]{0,400}?--participant-id(?:=|\s+)["']?([A-Za-z0-9._-]{1,128})["']?(?=$|[\s;&|)])/i.exec(flat)
  return found?.[1]
}
