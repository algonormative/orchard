// Reading `mail_history` windows: the thread structure, which threads this participant
// is in, and which of its decisions are still open. No `$`.
//
// The workspace host computes "open decisions" for its browser UI (resources.rs,
// open_decisions) but exposes it through no MCP tool, so the same rule is applied here
// to the newest window of history the CLI can read. A decision older than the window is
// not seen; the band's needs-you count is a floor for a very busy workspace.
import { MAX_BODY, clip } from './alerts'

/** How much history one read asks for: the most the tool allows. */
export const HISTORY_WINDOW = 200

export type HistoryMessage = {
  id: string
  sequence: number
  senderId: string
  kind: string
  threadId: string | null
  recipients: string[]
  body: string
  /** Characters cut from the body on the way in (it is kept to 4,000). */
  bodyCut: number
  sentAt: string
  /** `direct`, `broadcast` or `channel`. */
  destination: string
  /** The destination's id: the recipient of a direct message, the channel of a channel post. */
  destinationId: string | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export function parseHistoryMessage(raw: unknown): HistoryMessage | undefined {
  const m = record(raw)
  const id = text(m?.id)
  const senderId = text(m?.sender_id)
  if (m === undefined || id === undefined || senderId === undefined) return undefined
  const destination = record(m.destination)
  const sequence = typeof m.sequence === 'number' && Number.isFinite(m.sequence) ? Math.floor(m.sequence) : 0
  const fullBody = typeof m.body === 'string' ? m.body : ''
  const body = clip(fullBody, MAX_BODY)
  return {
    id,
    sequence,
    senderId,
    kind: text(m.kind) ?? 'message',
    threadId: text(m.thread_id) ?? null,
    recipients: Array.isArray(m.recipient_ids) ? m.recipient_ids.filter((r): r is string => typeof r === 'string') : [],
    body,
    bodyCut: fullBody.length - body.length,
    sentAt: text(m.sent_at) ?? '',
    destination: text(destination?.kind) ?? 'message',
    destinationId: text(destination?.id) ?? null,
  }
}

/** The messages of a `mail_history` / `mail_inbox` result, oldest first. */
export function parseHistory(json: unknown): HistoryMessage[] {
  const messages = record(json)?.messages
  if (!Array.isArray(messages)) return []
  const out: HistoryMessage[] = []
  for (const raw of messages) {
    const message = parseHistoryMessage(raw)
    if (message !== undefined) out.push(message)
  }
  return out.sort((a, b) => a.sequence - b.sequence)
}

/** The oldest message of `id`'s thread that the window knows (itself when it has no known parent). */
export function rootOf(id: string, parents: ReadonlyMap<string, string | null>): string {
  const seen = new Set<string>()
  let current = id
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parents.get(current)
    if (parent === undefined || parent === null) break
    current = parent
  }
  return current
}

export function parentsOf(messages: readonly HistoryMessage[]): Map<string, string | null> {
  return new Map(messages.map(m => [m.id, m.threadId]))
}

/**
 * Ids of every message in the window that belongs to a thread `me` started or posted in:
 * a reply to any of them is a reply in a participated thread. A thread whose root is
 * older than the window is known by the oldest ancestor the window holds.
 */
export function participationFrom(messages: readonly HistoryMessage[], me: string): string[] {
  const parents = parentsOf(messages)
  const mine = new Set(messages.filter(m => m.senderId === me).map(m => rootOf(m.id, parents)))
  if (mine.size === 0) return []
  return messages.filter(m => mine.has(rootOf(m.id, parents))).map(m => m.id)
}

/**
 * Decisions that any of `mine` (a session's participants: its own and the handles its subagents
 * act as) raised and no owner message has answered yet. A decision is a `kind: "decision"`
 * message delivered to the owner; an owner message answers the nearest decision up its reply
 * chain (so a reply to a follow-up inside the thread counts, while an outer decision stays open).
 */
export function openDecisions(messages: readonly HistoryMessage[], mine: readonly string[], ownerId: string): HistoryMessage[] {
  const byId = new Map(messages.map(m => [m.id, m]))
  const resolved = new Set<string>()
  for (const reply of messages.filter(m => m.senderId === ownerId)) {
    const seen = new Set<string>()
    let parent = reply.threadId
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent)
      const message = byId.get(parent)
      if (message === undefined) break
      if (message.kind === 'decision') {
        resolved.add(message.id)
        break
      }
      parent = message.threadId
    }
  }
  return messages.filter(
    m => m.kind === 'decision' && mine.includes(m.senderId) && m.senderId !== ownerId && m.recipients.includes(ownerId) && !resolved.has(m.id),
  )
}
