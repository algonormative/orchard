// What the mod shows of the workspace, without `$`: where each kind of item opens in the browser
// UI, one-line snippets, relative times, and the two kinds of alert that mean something happened
// (a task receipt, a decision). The activity feed and the pane draw from these.
import type { OrchardAlert } from '../types'
import { plain } from './config'
import { workspaceIdOf } from './orchard-cli'

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

export const stateHref = (endpoint: string, id: string) => uiHref(endpoint, () => `/states/${encodeURIComponent(id)}`)
export const agentHref = (endpoint: string, participantId: string) => uiHref(endpoint, () => `/agents/${encodeURIComponent(participantId)}`)

/** An alert's own address (the path below the workspace it carries, such as `/messages/<id>`), or the message's address when it carries none. */
export const alertHref = (endpoint: string, alert: Pick<OrchardAlert, 'id' | 'href'>): string | null =>
  alert.href === undefined ? messageHref(endpoint, alert.id) : uiHref(endpoint, () => alert.href as string)

/** "now", "2m", "3h", "4d", "2w": how long ago; anything unreadable or in the future is "now". */
export function relativeTime(sentAt: string, nowMs: number): string {
  const at = Date.parse(sentAt)
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return 'now'
  const s = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  if (s < 14 * 86_400) return `${Math.floor(s / 86_400)}d`
  return `${Math.floor(s / (7 * 86_400))}w`
}

/** The channel Orchard posts task intents and outcomes to; its messages are receipts, not mail. */
export const RECEIPTS_CHANNEL = 'task-receipts'

/** A task receipt (`task_intent`, `task_result`, `task_unknown`) in the receipts channel. */
export const isReceipt = (alert: OrchardAlert): boolean => alert.channelId === RECEIPTS_CHANNEL || /^task_/.test(alert.kind)

/** A message that may change what waits on the owner: a decision, or an owner's reply inside a thread. */
export const isDecisionRelated = (alert: OrchardAlert, ownerId: string | null): boolean =>
  alert.kind === 'decision' || (ownerId !== null && alert.senderId === ownerId && alert.threadId !== null)
