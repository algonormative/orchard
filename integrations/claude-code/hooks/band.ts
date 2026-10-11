// What the band says, as plain data so tests can read it without drawing.
// Never ids, request ids or paths: the workspace name, or a fixed phrase, or an
// error message that orchard-cli has already stripped. Connected and quiet (nothing
// pending, nothing waiting on the owner) draws nothing at all.
import type { OrchardCounts, OrchardStatus, OrchardWorkspace } from '../types'
import { plain } from './config'

export type BandLine = { text: string; tone: 'quiet' | 'warning' | 'error' }

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

export function bandLine(
  status: OrchardStatus | null,
  workspace: OrchardWorkspace | null,
  counts: OrchardCounts,
): BandLine | null {
  if (status === null) return null

  switch (status.kind) {
    case 'connecting':
      return { text: 'Orchard · connecting…', tone: 'quiet' }
    case 'offline':
      return { text: 'Orchard · offline', tone: 'warning' }
    case 'error':
      return { text: `Orchard · error: ${plain(status.message, 120)}`, tone: 'error' }
    case 'shared':
      return { text: 'Orchard · another session is listening', tone: 'quiet' }
    case 'connected': {
      const unread = count(counts.unread)
      const forYou = count(counts.forYou)
      const needsYou = count(counts.needsYou)
      const isStoreFailing = status.isStoreFailing === true
      if (unread === 0 && forYou === 0 && needsYou === 0 && !isStoreFailing) return null
      let text = `Orchard · ${plain(workspace?.name ?? '', 60) || 'connected'}`
      if (unread > 0) text += ` · ${unread} new${forYou > 0 ? ` (${forYou} for you)` : ''}`
      if (needsYou > 0) text += ` · needs-you ${needsYou}`
      if (isStoreFailing) text += ' · could not save its place (store write failed)'
      return { text, tone: isStoreFailing ? 'warning' : 'quiet' }
    }
  }
}
