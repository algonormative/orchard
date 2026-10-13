// The status line the mod keeps up while it is connected: what the workspace is doing outside this
// agent (alerts from others in the last ten minutes, open tasks). Plain text, no ids or paths: the
// workspace name and counts. A held wake's notice (listener.ts) takes its place while it lasts.
import type { OrchardStatus, OrchardWorkspace, OrchardWorkspaceActivity } from '../types'
import { plain } from './config'
import { shortName } from './band'

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** `orchard · Plotter Art · ● 4 in 10m · 12 open tasks`, or what the connection is when it is not up. Undefined: nothing to say yet. */
export function statusLine(status: OrchardStatus | null, workspace: OrchardWorkspace | null, activity: OrchardWorkspaceActivity): string | undefined {
  switch (status?.kind) {
    case undefined:
      return undefined
    case 'connecting':
      return 'orchard · connecting…'
    case 'offline':
      return 'orchard · offline'
    case 'error':
      return 'orchard · error'
    case 'disconnected':
      return 'orchard · disconnected'
    case 'signed-off':
      return 'orchard · signed off'
    case 'connected': {
      const name = shortName(workspace)
      const recent = count(activity.recentFromOthers)
      const parts = ['orchard', ...(name === '' ? [] : [plain(name, 40)]), recent === 0 ? 'quiet' : `● ${recent} in 10m`]
      if (activity.openTasks !== null) parts.push(`${count(activity.openTasks)} open task${activity.openTasks === 1 ? '' : 's'}`)
      return parts.join(' · ')
    }
  }
}
