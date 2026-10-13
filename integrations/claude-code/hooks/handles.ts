// What a session's agents are seen acting as in Orchard, as pure functions. The mod creates no
// identity for an agent and keeps no lease or timer for one: an agent signs itself on and off (the
// orchard skill, through the Orchard CLI), or uses this mod's tools, which act as the session's own
// participant. The mod writes down what it saw and shows it beside what Orchard says of each
// participant (signed on or not). No `$` here: register.tsx watches the calls and reads Orchard's
// participant list; this module decides what they mean.
import { PROJECT_ID_PREFIX, RESERVED_IDS } from './config'

/** How many agents the book remembers; the oldest are forgotten past it. */
const MAX_AGENTS = 64
/** How many participants it remembers for one agent. */
export const MAX_OBSERVED = 4

/** What Orchard says of a participant: whether it is signed on, and when it last made contact (clock ms). */
export type SignOn = { registered: boolean; lastContactAt?: number }

/** What the book knows of one agent that used Orchard. */
export type AgentHandles = {
  /** Participants it signed on as or acted as through the Orchard CLI, oldest first. */
  observed: string[]
  /** It used this mod's tools, which act as the session's own participant. */
  usedTools: boolean
}

export type HandleBook = {
  /** By agent id (`main` for the session's own loop). */
  agents: Map<string, AgentHandles>
  /** Orchard's word on each participant of the session, from the last participant list. */
  signOn: Map<string, SignOn>
}

export const createBook = (): HandleBook => ({ agents: new Map(), signOn: new Map() })

function entryOf(book: HandleBook, agentId: string): AgentHandles {
  const have = book.agents.get(agentId)
  if (have !== undefined) return have
  const entry: AgentHandles = { observed: [], usedTools: false }
  book.agents.set(agentId, entry)
  for (const old of [...book.agents.keys()].slice(0, Math.max(0, book.agents.size - MAX_AGENTS))) book.agents.delete(old)
  return entry
}

/**
 * A name a command carries counts as this session's only when it is Claude-style: like a
 * participantId in .orchard.json, never a human's or the system's, so a command cannot make
 * someone else's activity the session's.
 */
export const isClaudeId = (id: string): boolean => id.startsWith(PROJECT_ID_PREFIX) && !RESERVED_IDS.includes(id.toLowerCase())

/**
 * Records that `agentId` signed on as, or acted as, `id` through the Orchard CLI. The session's own
 * participant (`base`) is the one this mod's tools act as. True when the book learned something.
 */
export function observe(book: HandleBook, agentId: string, id: string, base: string): boolean {
  if (id === base) return useTools(book, agentId)
  if (!isClaudeId(id)) return false
  const entry = entryOf(book, agentId)
  if (entry.observed.includes(id)) return false
  entry.observed.push(id)
  if (entry.observed.length > MAX_OBSERVED) entry.observed.shift()
  return true
}

/** Records that `agentId` used this mod's tools, which act as the session's own participant. True when that was not known. */
export function useTools(book: HandleBook, agentId: string): boolean {
  const entry = entryOf(book, agentId)
  if (entry.usedTools) return false
  entry.usedTools = true
  return true
}

/** The agent was seen acting as a participant of its own through the CLI. */
export const hasObserved = (book: HandleBook, agentId: string): boolean => (book.agents.get(agentId)?.observed.length ?? 0) > 0

/** Every participant of this session: its own, and each one its agents were seen acting as. */
export function ownHandles(base: string, book: HandleBook): string[] {
  const all = [base]
  for (const entry of book.agents.values()) all.push(...entry.observed)
  return [...new Set(all)]
}

/** What the agents table shows an agent acting as: the participant, and which way it was seen. */
export type Shown = { handle: string; observed?: true; sharesBase?: true }

/**
 * The participant the table shows for each agent: the one it was last seen signing on as through the
 * CLI, else the session's own when it used this mod's tools. An agent seen doing neither has none.
 */
export function shownBy(base: string, book: HandleBook): Map<string, Shown> {
  const shown = new Map<string, Shown>()
  for (const [agentId, entry] of book.agents) {
    const seen = entry.observed.at(-1)
    if (seen !== undefined) shown.set(agentId, { handle: seen, observed: true })
    else if (entry.usedTools) shown.set(agentId, { handle: base, sharesBase: true })
  }
  return shown
}

/**
 * What a `mail_participants` answer says of each of `handles`: signed on (`registered`) or not, and
 * its last contact. A participant the list does not carry has no entry. Undefined when the answer is
 * not a participant list.
 */
export function signOnOf(json: unknown, handles: readonly string[]): Map<string, SignOn> | undefined {
  const list = json !== null && typeof json === 'object' ? (json as { participants?: unknown }).participants : undefined
  if (!Array.isArray(list)) return undefined
  const known = new Map<string, SignOn>()
  for (const item of list as unknown[]) {
    const p = item !== null && typeof item === 'object' ? (item as { id?: unknown; registered?: unknown; last_contact_at?: unknown }) : {}
    if (typeof p.id !== 'string' || !handles.includes(p.id) || typeof p.registered !== 'boolean') continue
    const at = typeof p.last_contact_at === 'string' ? Date.parse(p.last_contact_at) : Number.NaN
    known.set(p.id, { registered: p.registered, ...(Number.isFinite(at) ? { lastContactAt: at } : {}) })
  }
  return known
}

/** The Bash call finished and succeeded: the tool answered, reported no error (a non-zero exit is one), and was neither interrupted nor moved to the background, where its exit is not yet known. */
export function succeeded(call: { deny?: string; isError?: boolean; result?: unknown }): boolean {
  if (call.deny !== undefined || call.isError === true) return false
  const out = call.result !== null && typeof call.result === 'object' ? (call.result as { interrupted?: unknown; backgroundTaskId?: unknown }) : {}
  return out.interrupted !== true && out.backgroundTaskId === undefined
}

// ---- reading a Bash command ----

/** Only the start of a command is read. */
const MAX_COMMAND = 20_000
/** What may stand before the executable of a command and not change what it runs. */
const PREFIXES = new Set(['exec', 'command', 'env', 'sudo', 'time', 'nice', 'nohup'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** The CLI's commands that name the participant they are for. */
const AS_PARTICIPANT = new Set(['join', 'resume', 'call', 'ack', 'alerts'])
const PARTICIPANT_ID = /^[A-Za-z0-9._-]{1,128}$/

/**
 * A command line as the simple commands it runs, each a list of words. Quotes group a word and are
 * dropped; `;` `&` `|` `(` `)` `{` `}` a backtick and a newline end a command. Nothing is expanded, so
 * a word with a `$` in it stays as written.
 */
function simpleCommands(command: string): string[][] {
  const text = command.slice(0, MAX_COMMAND).replace(/\\\r?\n/g, ' ')
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let isWord = false
  let quote: string | undefined
  const endWord = () => {
    if (isWord) words.push(word)
    word = ''
    isWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i)
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text.charAt(++i)
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      isWord = true
    } else if (c === '\\' && i + 1 < text.length) {
      word += text.charAt(++i)
      isWord = true
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else if (';&|(){}`\n'.includes(c)) {
      endCommand()
    } else {
      word += c
      isWord = true
    }
  }
  endCommand()
  return commands
}

/** The participants one simple command names, when it runs `Orchard agent <command> --participant-id X`. */
function participantsOf(words: readonly string[]): string[] {
  let at = 0
  while (at < words.length && (PREFIXES.has(words[at] as string) || ASSIGNMENT.test(words[at] as string))) at += 1
  // The executable itself, not text that mentions it: `echo "Orchard agent join ..."` runs echo.
  if ((words[at] ?? '').split('/').at(-1)?.toLowerCase() !== 'orchard' || words[at + 1] !== 'agent') return []
  at += 2
  // Global options stand between `agent` and its command.
  while (words[at] === '--endpoint' || words[at] === '--credential-file') at += 2
  while ((words[at] ?? '').startsWith('--endpoint=') || (words[at] ?? '').startsWith('--credential-file=')) at += 1
  if (!AS_PARTICIPANT.has(words[at] ?? '')) return []
  const ids: string[] = []
  for (let i = at + 1; i < words.length; i += 1) {
    const word = words[i] as string
    const id = word === '--participant-id' ? words[i + 1] : word.startsWith('--participant-id=') ? word.slice('--participant-id='.length) : undefined
    if (id !== undefined && PARTICIPANT_ID.test(id)) ids.push(id)
  }
  return ids
}

/**
 * The participants a Bash command signs on or acts as through the Orchard CLI
 * (`Orchard agent join|resume|call|ack|alerts ... --participant-id X`), in order, once each. Only a
 * command that is that program counts; text that merely contains the words does not. Best effort: a
 * program run through a variable or `bash -c` is not seen.
 */
export function observedAs(command: string): string[] {
  return [...new Set(simpleCommands(command).flatMap(participantsOf))]
}
