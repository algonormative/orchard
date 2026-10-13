// The /orchard pane as a pure function of its data: a read-only view of what this Claude session
// and its subagents are doing in Orchard. register.tsx resolves the element table (`$.ui.resolve`)
// and builds the handlers (they are the `$` calls), so nothing here touches `$`. The header, the
// section labels and the footer are Svg strings from svg.ts on the surfaces that draw an Svg; the
// terminal has none and gets the same structure as Text. Its only controls are Open in Orchard and
// Disconnect / Connect, both plain Buttons.
import type { Elements } from 'claude-code'

import type { OrchardActivityEntry, OrchardAgents, OrchardCounts, OrchardPlugins, OrchardStatus } from '../types'
import { MAIN } from './feed'
import { FOOTER_HEIGHT, PANE_TITLE, chipOf, footerSvg, footerText, headerSvg, sectionSvg, sublineOf, widthOf } from './svg'

export type Table = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'> & {
  /** Absent on the terminal; the caller also leaves it out where a surface should not draw one. */
  Svg?: Elements['desktop']['Svg']
}

/** An alert waiting for a wake or the next prompt, as the "now" section lists it. */
export type PendingLine = { sender: string; snippet: string }

export type PaneView = {
  /** Shown in the header and nowhere else. */
  participantId: string
  workspaceName: string
  /** Where the header's Open in Orchard goes; null when the endpoint has no workspace in it. */
  workspaceHref: string | null
  status: OrchardStatus | null
  counts: OrchardCounts | null
  pending: readonly PendingLine[]
  plugins: OrchardPlugins
  agents: OrchardAgents
  activity: readonly OrchardActivityEntry[]
  /** Clock time the alert loop last heard back; the footer shows its age. */
  lastPollAt?: number | null
  /** The clock, for relative times and the footer. */
  nowMs: number
  /** Cells across the pane body, for sizing the drawings. */
  columns?: number
  /** The surface drawing the pane. */
  surface?: 'terminal' | 'desktop' | 'vscode' | 'mobile'
}

export type PaneHandlers = {
  /** Opens an address of the browser UI in the person's browser. */
  open: (href: string) => void
  /** Disconnect this session from Orchard, or connect it again. */
  disconnect: () => void
  connect: () => void
}

/** How many activity lines the pane lists. */
export const ACTIVITY_SHOWN = 15

const CHIP_TOKEN = { listening: 'success', waiting: 'warning', offline: 'error', error: 'error', shared: undefined, connecting: undefined, disconnected: undefined, 'signed-off': undefined } as const

/** "now", "3m", "2h": how long before `nowMs` an entry happened. */
export function ago(at: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

export function renderPane(ui: Table, view: PaneView, on: PaneHandlers) {
  const { Box, Text, Button, Svg } = ui
  const { plugins, nowMs } = view
  const w = widthOf(view.columns)
  const chip = chipOf(view.status, view.counts)
  const isSignedOff = view.status?.kind === 'signed-off'
  const isDisconnected = view.status?.kind === 'disconnected' || isSignedOff

  const picture = (key: string, source: string, alt: string, height: number, isInteractive = false, width = w) =>
    Svg === undefined ? null : <Svg key={key} source={source} alt={alt} width={width} height={height} isInteractive={isInteractive} />

  /** A section label: the drawn rule and caps on Svg surfaces, a Text line elsewhere. */
  const section = (key: string, label: string) =>
    Svg === undefined ? (
      <Box key={key}>
        <Text bold color="warning">{label}</Text>
      </Box>
    ) : (
      picture(key, sectionSvg(w, label), label, 30)
    )

  const header =
    Svg === undefined ? (
      <Box key="header" flexDirection="column">
        <Box>
          <Text bold>◆ {PANE_TITLE}</Text>
        </Box>
        <Text dimColor>{sublineOf(view.participantId, view.workspaceName)}</Text>
        <Text color={CHIP_TOKEN[chip.kind]} dimColor={CHIP_TOKEN[chip.kind] === undefined}>● {chip.label}</Text>
      </Box>
    ) : (
      picture(
        'header',
        headerSvg(w, { workspaceName: view.workspaceName, participantId: view.participantId, chip }),
        `${PANE_TITLE}, workspace ${view.workspaceName || ''}, ${chip.label}`.replace(/\s+,/, ','),
        90,
        true,
      )
    )

  const subagents = Object.values(view.agents)
    .filter(a => a.agentId !== MAIN)
    .sort((a, b) => a.startedAt - b.startedAt)
  const main = view.agents[MAIN]
  const recent = view.activity.slice(-ACTIVITY_SHOWN).reverse()
  const tasks = plugins.tasks
  const waiting = plugins.decisions
  const hasPlugins = plugins.roles.length > 0 || plugins.states.length > 0
  const hasContent = view.pending.length + waiting.length + tasks.length + subagents.length + recent.length > 0 || hasPlugins

  return (
    <Box flexDirection="column">
      {header}
      <Box key="header-actions" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {view.workspaceHref === null ? null : <Button key="open-workspace" label="Open in Orchard ↗" onPress={() => on.open(view.workspaceHref as string)} />}
        {isDisconnected ? (
          <Button key="connect" label="Connect" onPress={on.connect} />
        ) : (
          <Button key="disconnect" label="Disconnect" onPress={on.disconnect} />
        )}
      </Box>
      {isSignedOff ? <Text dimColor>Signed off: this session left Orchard, so it is not listening and nothing wakes it. Connect to sign it on again.</Text> : null}
      {isDisconnected && !isSignedOff ? <Text dimColor>Disconnected: not listening, and nothing wakes this session. Connect to listen again.</Text> : null}

      {view.pending.length === 0 ? null : section('section-now', 'NOW')}
      {view.pending.map((line, i) => (
        <Text key={`now-${i}`}>
          {line.sender}: {line.snippet}
        </Text>
      ))}
      {view.pending.length > 0 && view.counts?.isHeld === true ? <Text dimColor>sends when the prompt box is empty</Text> : null}

      {waiting.length === 0 ? null : section('section-waiting', 'WAITING ON YOU')}
      {waiting.map(decision => (
        <Text key={`decision-${decision.id}`} color="warning">
          ◆ {decision.snippet}
        </Text>
      ))}

      {tasks.length === 0 ? null : section('section-tasks', 'TASKS')}
      {tasks.map(task => (
        <Text key={`task-${task.id}`}>
          {task.title} <Text dimColor>{task.status}</Text>
        </Text>
      ))}

      {subagents.length === 0 ? null : section('section-agents', 'AGENTS')}
      {main !== undefined && subagents.length > 0 ? (
        <Text key="agent-main">
          main{' '}
          <Text dimColor>
            {main.status}
            {main.lastAction === undefined ? '' : ` · ${main.lastAction}`}
          </Text>
        </Text>
      ) : null}
      {subagents.map(agent => (
        <Text key={`agent-${agent.agentId}`}>
          {agent.description === '' ? agent.type : agent.description}{' '}
          <Text dimColor>
            {agent.status} · {agent.handle ?? 'not connected'}
            {agent.lastAction === undefined ? '' : ` · ${agent.lastAction}`}
          </Text>
        </Text>
      ))}

      {hasPlugins ? section('section-plugins', 'PLUGINS') : null}
      {plugins.roles.map(role => (
        <Text key={`role-${role.participantId}`}>
          roles <Text dimColor>{role.roles.join(', ')}</Text>
        </Text>
      ))}
      {plugins.states.map(marker => (
        <Text key={`state-${marker.id}`}>
          {marker.title} <Text dimColor>{marker.state}</Text>
        </Text>
      ))}

      {recent.length === 0 ? null : section('section-activity', 'ACTIVITY')}
      {recent.map((entry, i) => (
        <Text key={`activity-${i}`} dimColor={entry.direction === 'in'}>
          {entry.direction === 'in' ? '←' : '→'} {entry.text} <Text dimColor>{ago(entry.at, nowMs)}</Text>
        </Text>
      ))}

      {!hasContent && !isDisconnected ? <Text dimColor>Claude is connected to {view.workspaceName || 'the workspace'}. Nothing is going on yet.</Text> : null}
      {Svg === undefined ? (
        <Text dimColor>{footerText(view.lastPollAt, nowMs)}</Text>
      ) : (
        picture('footer', footerSvg(w, footerText(view.lastPollAt, nowMs)), 'Tending the grove', FOOTER_HEIGHT)
      )}
    </Box>
  )
}
