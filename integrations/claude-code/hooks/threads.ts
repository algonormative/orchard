// What the pane lists, from one window of history: the threads this participant is in, the
// decisions it raised that wait on the owner, and where each opens in the browser UI. No `$`.
import type { OrchardPaneThread } from '../types'
import { plain } from './config'
import type { HistoryMessage } from './history'
import { parentsOf, rootOf } from './history'
import { workspaceIdOf } from './orchard-cli'

export const MAX_THREADS = 12
const SNIPPET = 140

export function snippetOf(body: string): string {
  const first = body.split('\n').find(line => line.trim() !== '') ?? ''
  return plain(first, SNIPPET)
}

/**
 * The browser UI's address for a message, task or channel: the endpoint's port on the loopback
 * address plus `/w/<workspace>/...`. The host is always `127.0.0.1`: Orchard's browser UI answers
 * any other Host (`localhost` included) with a 403 on `/api/session`. The desktop app draws a
 * Link only for `https:` and `http://localhost`, so these are opened with a Button that runs
 * `open` (see `openInOrchard` in register.tsx), never shown as links.
 */
export function uiHref(endpoint: string, path: (workspaceId: string) => string): string | null {
  const workspaceId = workspaceIdOf(endpoint)
  if (workspaceId === undefined) return null
  try {
    const { port } = new URL(endpoint)
    return `http://127.0.0.1${port === '' ? '' : `:${port}`}/w/${encodeURIComponent(workspaceId)}${path(workspaceId)}`
  } catch {
    return null
  }
}

/** Where the workspace opens when nothing in particular is picked: its general channel. */
export const workspaceHref = (endpoint: string) => uiHref(endpoint, () => '/channels/general')

export const messageHref = (endpoint: string, id: string) => uiHref(endpoint, () => `/messages/${encodeURIComponent(id)}`)
export const taskHref = (endpoint: string, storeId: string, taskId: string) =>
  uiHref(endpoint, () => `/tasks/${encodeURIComponent(storeId)}/${encodeURIComponent(taskId)}`)

export type ThreadContext = {
  me: string
  ownerId: string
  endpoint: string
  /** Display names by participant id. */
  names: ReadonlyMap<string, string>
}

/**
 * Threads that hold a message delivered to `me` or sent by `me`, newest activity first.
 * A reply answers the newest message in the thread that `me` did not send.
 */
export function buildThreads(messages: readonly HistoryMessage[], ctx: ThreadContext): OrchardPaneThread[] {
  const parents = parentsOf(messages)
  const groups = new Map<string, HistoryMessage[]>()
  for (const m of messages) {
    if (m.senderId !== ctx.me && !m.recipients.includes(ctx.me)) continue
    const root = rootOf(m.id, parents)
    groups.set(root, [...(groups.get(root) ?? []), m])
  }
  const threads = [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => a.sequence - b.sequence)
    const newest = sorted[sorted.length - 1] as HistoryMessage
    const theirs = [...sorted].reverse().find(m => m.senderId !== ctx.me) ?? newest
    const nameOf = (m: HistoryMessage) => (m.senderId === ctx.me ? 'you' : (ctx.names.get(m.senderId) ?? 'someone'))
    return {
      sequence: newest.sequence,
      thread: {
        replyToId: theirs.id,
        last: {
          id: theirs.id,
          senderName: plain(nameOf(theirs), 60),
          isOwner: theirs.senderId === ctx.ownerId,
          isMine: theirs.senderId === ctx.me,
          snippet: snippetOf(theirs.body),
          sentAt: theirs.sentAt,
        },
        size: sorted.length,
        href: messageHref(ctx.endpoint, theirs.id),
      } satisfies OrchardPaneThread,
    }
  })
  return threads
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, MAX_THREADS)
    .map(t => t.thread)
}

/** `2026-10-10T12:00:00Z` as `2026-10-10 12:00`; anything else is shown as it came, cut short. */
export function whenOf(sentAt: string): string {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(sentAt)
  return match === null ? plain(sentAt, 20) : `${match[1]} ${match[2]}`
}
