// The /orchard pane as a pure function of its data: a read-only view of what this Claude session
// and its subagents are doing in Orchard. It is quiet when nothing is going on (one sentence and two
// buttons) and grows with activity: each section appears only when it has something to say.
// register.tsx resolves the element table (`$.ui.resolve`) and builds the handlers (they are the `$`
// calls), so nothing here touches `$`. The header, the section labels and the footer are Svg strings
// from svg.ts on the surfaces that draw an Svg; the terminal has none and gets the same structure as
// Text. The controls are big actions only (Open in Orchard, Disconnect / Connect, and the activity
// toggle) and, on an item, open-in-Orchard and copy-link; steering stays in the prompt box.
import type { Elements, UiPressArgument } from 'claude-code'

import type { OrchardActivityEntry, OrchardAgent, OrchardAgents, OrchardCounts, OrchardNow, OrchardPlugins, OrchardStatus, OrchardView } from '../types'
import { MAIN, RECENT_MS, agentColor, agentState, isEnded, shortHandle } from './feed'
import { PANE_TITLE, SECTION_HEIGHT, chipOf, footerText, headerHeight, headerSvg, sectionSvg, sublineOf, widthOf } from './svg'

export type Table = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'> & {
  /** Absent on the terminal; the caller also leaves it out where a surface should not draw one. */
  Svg?: Elements['desktop']['Svg']
}

export type PaneView = {
  /** Shown in the header and nowhere else. */
  participantId: string
  workspaceName: string
  /** Where the header's Open in Orchard goes; null when the endpoint has no workspace in it. */
  workspaceHref: string | null
  status: OrchardStatus | null
  counts: OrchardCounts | null
  /** The messages the main loop is handling this turn. */
  now: OrchardNow | null
  /** Alerts waiting for a wake or the next prompt. */
  queued: number
  plugins: OrchardPlugins
  agents: OrchardAgents
  activity: readonly OrchardActivityEntry[]
  /** What the person toggled (this session only). */
  view: OrchardView
  /** Where a participant's page opens in Orchard; null where it has none. */
  agentHref: (handle: string) => string | null
  /** Clock time the alert loop last heard back; the footer shows its age. */
  lastPollAt?: number | null
  /** The clock, for relative times, the fade and the footer. */
  nowMs: number
  /** Cells across the pane body, for sizing the drawings. */
  columns?: number
  /** The surface drawing the pane. */
  surface?: 'terminal' | 'desktop' | 'vscode' | 'mobile'
  /** False for a session nobody connected to Orchard: the pane is the prompt to connect and nothing else. */
  isConnected?: boolean
}

export type PaneHandlers = {
  /** Opens an address of the browser UI in the person's browser. */
  open: (href: string) => void
  /** Copies an address to the clipboard of the surface the press came from. */
  copy: (href: string, surface: UiPressArgument['surface']) => void
  /** Disconnect was pressed: ask first. */
  disconnect: () => void
  /** The question was answered yes / no. */
  confirmDisconnect: () => void
  cancelDisconnect: () => void
  connect: () => void
  /** The activity list shows this agent's entries only (false) or the subagents' too (true). */
  showSubagents: (isShown: boolean) => void
}

/** Cells of gutter either side of the pane body, and the pixels the drawings count a cell as. */
const GUTTER = 2
const PX_PER_CELL = 8

/** How many activity lines the pane lists. */
export const ACTIVITY_SHOWN = 15

/** Theme keys the Text rows paint with; they follow the person's light/dark theme. */
const CHIP_TOKEN = { listening: 'success', working: 'success', waiting: 'warning', offline: 'error', error: 'error', connecting: undefined, disconnected: undefined, 'signed-off': undefined } as const
const TONE = { ok: 'success', warn: 'warning', dim: undefined } as const

/** "now", "3m", "2h": how long before `nowMs` an entry happened. */
export function ago(at: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

const humane = (word: string) => word.replace(/_/g, ' ')

/** What the person has had in view lately: entries newer than the fade. */
export function recentActivity(activity: readonly OrchardActivityEntry[], nowMs: number): OrchardActivityEntry[] {
  return activity.filter(entry => nowMs - entry.at <= RECENT_MS)
}

/** The agents of the AGENTS section: main first, then the subagents in the order they started. Empty without a subagent. */
export function agentRows(agents: OrchardAgents): OrchardAgent[] {
  const subs = Object.values(agents)
    .filter(a => a.agentId !== MAIN)
    .sort((a, b) => a.startedAt - b.startedAt)
  const main = agents[MAIN]
  return subs.length === 0 ? [] : main === undefined ? subs : [main, ...subs]
}

/** Nothing is going on: the pane shows its quiet view. */
export function isQuiet(view: PaneView): boolean {
  const { plugins } = view
  const hasPlugins = plugins.roles.length > 0 || plugins.states.length > 0 || plugins.decisions.length > 0
  return view.now === null && view.queued === 0 && plugins.tasks.length === 0 && !hasPlugins && agentRows(view.agents).length === 0 && recentActivity(view.activity, view.nowMs).length === 0
}

export function renderPane(ui: Table, view: PaneView, on: PaneHandlers) {
  const { Box, Text, Button, Svg } = ui
  const { plugins, nowMs, participantId: me } = view
  type Part = string | ReturnType<typeof Text>
  type Node = ReturnType<typeof Box> | ReturnType<typeof Text> | ReturnType<typeof Button> | null
  if (view.isConnected === false) {
    return (
      <Box key="unconnected" flexDirection="column" paddingX={GUTTER}>
        <Text bold>{`This session isn't connected to ${view.workspaceName || 'Orchard'}`}</Text>
        <Box key="connect-actions" marginTop={1}>
          <Button key="connect" label="Connect" onPress={on.connect} />
        </Box>
      </Box>
    )
  }
  const w = widthOf(view.columns)
  const kind = view.status?.kind
  const isDisconnected = kind === 'disconnected' || kind === 'signed-off'
  const isConnected = kind === 'connected'
  const isConfirming = view.view.isConfirming && !isDisconnected
  const rows = agentRows(view.agents)
  const isBusy = view.now !== null || rows.some(a => a.agentId !== MAIN && !isEnded(a.status) && a.status !== 'idle')
  const chip = chipOf(view.status, view.counts, isBusy)
  const isQuietView = isConnected && isQuiet(view) && !isConfirming

  // One gutter for the whole body: labels, rows, rules and buttons all start at the same edge, and
  // the drawings are narrower by the two gutters so their rules end where the rows do.
  const bodyW = Math.max(200, w - 2 * GUTTER * PX_PER_CELL)

  // Every picture is static: an interactive Svg is a frame the desktop reloads, with a visible flash, on each redraw.
  const picture = (key: string, source: string, alt: string, height: number, width = bodyW) =>
    Svg === undefined ? null : <Svg key={key} source={source} alt={alt} width={width} height={height} />

  /** A section: its label (the drawn rule and caps on Svg surfaces, a Text line elsewhere) and its rows, one marginTop above. */
  const block = (key: string, label: string, rowsOf: Node[], head?: Node) => (
    <Box key={key} flexDirection="column" marginTop={1}>
      {head ?? sectionLabel(`${key}-label`, label)}
      {rowsOf}
    </Box>
  )
  const sectionLabel = (key: string, label: string) =>
    Svg === undefined ? (
      <Box key={key}>
        <Text bold color="warning">{label}</Text>
      </Box>
    ) : (
      picture(key, sectionSvg(bodyW, label), label, SECTION_HEIGHT)
    )

  const asText = (part: Part) => (typeof part === 'string' ? <Text>{part}</Text> : part)

  /**
   * One row: `left` grows and truncates, `right` is a dim column that keeps its width, and the copy
   * slot is one cell wide on every row (empty where the row has no address) so the ⧉ never moves.
   * With an address the left side is a plain Button that opens it. `parts` are strings and Text.
   */
  const item = (key: string, href: string | null | undefined, raw: Part[], right?: Part, indent = 0) => {
    const parts = raw.map((part, i) => (typeof part === 'string' ? <Text wrap={i === raw.length - 1 ? 'truncate-end' : undefined}>{part}</Text> : part))
    const hasHref = href !== null && href !== undefined
    return (
      <Box key={key} flexDirection="row" paddingLeft={indent} columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          {hasHref ? (
            <Button key={`${key}-open`} plain onPress={() => on.open(href)}>
              {parts}
            </Button>
          ) : (
            <Text>{parts}</Text>
          )}
        </Box>
        {right === undefined ? null : (
          <Box flexShrink={0}>
            {typeof right === 'string' ? <Text dimColor>{right}</Text> : right}
          </Box>
        )}
        <Box width={1} flexShrink={0}>
          {hasHref ? <Button key={`${key}-copy`} plain dimColor label="⧉" onPress={press => on.copy(href, press.surface)} /> : null}
        </Box>
      </Box>
    )
  }

  /** The dim second line of a row, under its title. */
  const subline = (key: string, text: string, indent: number) => (
    <Box key={key} paddingLeft={indent}>
      <Text dimColor wrap="truncate-end">{text}</Text>
    </Box>
  )

  const dim = (text: string) => <Text dimColor>{text}</Text>

  // ---- the header, the one sentence and the two buttons ----

  const name = view.workspaceName || 'the workspace'
  const hasDetail = !isQuietView && !isConfirming
  const header =
    Svg === undefined ? (
      <Box key="header" flexDirection="column">
        <Box>
          <Text bold color={isConfirming ? 'error' : undefined}>◆ {isConfirming ? 'ORCHARD // DISCONNECT?' : PANE_TITLE}</Text>
        </Box>
        <Text bold>{view.workspaceName || 'Orchard'}</Text>
        {hasDetail ? <Text dimColor>{sublineOf(me)}</Text> : null}
        {hasDetail ? <Text color={CHIP_TOKEN[chip.kind]} dimColor={CHIP_TOKEN[chip.kind] === undefined}>● {chip.label}</Text> : null}
      </Box>
    ) : (
      picture(
        'header',
        headerSvg(bodyW, { workspaceName: view.workspaceName, participantId: me, ...(hasDetail ? { chip } : {}), mood: isConfirming ? 'confirm' : 'normal' }),
        `${isConfirming ? 'Disconnect?' : PANE_TITLE}, workspace ${view.workspaceName || ''}${hasDetail ? `, ${chip.label}` : ''}`.replace(/\s+,/, ','),
        headerHeight(hasDetail ? { chip } : {}),
      )
    )

  const statement: string[] = isConfirming
    ? [`Stop Claude listening to ${name}?`, `this session only · ${me} stays signed on`, '/orchard connect brings it back']
    : kind === 'disconnected'
      ? [`Claude is disconnected from ${name}`, 'Not listening, and nothing wakes this session. Connect to listen again.']
      : kind === 'signed-off'
        ? [`Claude has signed off from ${name}`, 'Its participant left Orchard, so nothing wakes this session. Connect signs it on again.']
        : kind === 'offline'
          ? [`Claude cannot reach ${name}`, 'Retrying. Nothing is lost while it is away.']
          : view.status?.kind === 'error'
            ? ['Claude could not connect to Orchard', view.status.message]
            : kind === 'connecting' || view.status === null
              ? [`Connecting to ${name}…`]
              : isQuietView
                ? [`Claude is connected to ${name}`, `as ${me} · nothing in flight · steer from the prompt box`]
                : []

  const buttons = (
    <Box key="header-actions" flexDirection="row" flexWrap="wrap" columnGap={1}>
      {isConfirming ? (
        <Button key="confirm-disconnect" variant="primary" label="Yes, disconnect" onPress={on.confirmDisconnect}>
          <Text bold color="error">Yes, disconnect</Text>
        </Button>
      ) : view.workspaceHref === null ? null : (
        <Button key="open-workspace" label="Open in Orchard ↗" onPress={() => on.open(view.workspaceHref as string)} />
      )}
      {isConfirming ? (
        <Button key="cancel-disconnect" label="Cancel" onPress={on.cancelDisconnect} />
      ) : isDisconnected ? (
        <Button key="connect" label="Connect" onPress={on.connect} />
      ) : (
        <Button key="disconnect" label="Disconnect" onPress={on.disconnect}>
          <Text color="error">Disconnect</Text>
        </Button>
      )}
    </Box>
  )

  const top = (
    <Box key="top" flexDirection="column" backgroundColor={isConfirming ? 'diffRemovedDimmed' : undefined} paddingX={isConfirming ? 1 : undefined}>
      {header}
      {statement.length === 0 ? null : (
        <Box key="statement" flexDirection="column" alignItems={isConfirming || isQuietView ? 'center' : undefined}>
          {statement.map((line, i) => (
            <Text key={`statement-${i}`} bold={i === 0} dimColor={i > 0}>
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Box key="header-buttons" marginTop={1}>
        {buttons}
      </Box>
    </Box>
  )

  // ---- NOW ----

  const now = view.now
  const nowSection =
    now === null && view.queued === 0
      ? null
      : block('now', 'NOW', [
          ...(now?.items ?? []).flatMap((m, i) => [
            item(`now-${i}`, m.href, [<Text bold>{m.sender}</Text>, <Text dimColor>{` · ${m.how}`}</Text>], i === 0 ? 'handling now' : undefined),
            m.snippet === '' ? null : subline(`now-${i}-snippet`, `“${m.snippet}”`, 0),
          ]),
          ...(now !== null && now.total > now.items.length ? [<Text key="now-more" dimColor>{`+ ${now.total - now.items.length} more in this batch`}</Text>] : []),
          view.queued === 0 ? null : (
            <Text key="now-queued" color="warning">
              {`${view.queued} ${now === null ? '' : 'more '}queued · ${view.counts?.isHeld === true ? 'sends when the prompt box is empty' : 'waiting to be sent'}`}
            </Text>
          ),
        ])

  // ---- TASKS ----

  const tasksSection =
    plugins.tasks.length === 0
      ? null
      : block('tasks', 'TASKS', plugins.tasks.map(task => item(`task-${task.id}`, task.href, [<Text color="success">◐ </Text>, task.title], humane(task.status))))

  // ---- AGENTS ----

  // Line 1: dot, description (truncated) and the state at the right. Line 2, dim and indented under the
  // description: where it is signed on, and its last action. Subagents sit one step under main.
  const agentLine = (agent: OrchardAgent) => {
    const state = agentState(agent)
    const href = agent.handle !== undefined && agent.sharesBase !== true ? view.agentHref(agent.handle) : null
    const isMain = agent.agentId === MAIN
    const indent = isMain ? 0 : 2
    const where = agent.sharesBase === true ? `shares ${me}` : agent.handle === undefined ? 'not on Orchard' : agent.handle
    const last = agent.lastAction === undefined || isEnded(agent.status) ? '' : ` · ${agent.lastAction}`
    return (
      <Box key={`agent-${agent.agentId}`} flexDirection="column">
        {item(
          `agent-row-${agent.agentId}`,
          href,
          [<Text color={isMain ? 'suggestion' : agentColor(agent.agentId)}>● </Text>, <Text bold={isMain}>{isMain ? 'main' : agent.description === '' ? agent.type : agent.description}</Text>],
          <Text color={TONE[state.tone]} dimColor={state.tone === 'dim'}>{state.text}</Text>,
          indent,
        )}
        {subline(`agent-last-${agent.agentId}`, `${where}${last}`, indent + 2)}
      </Box>
    )
  }
  const agentsSection = rows.length === 0 ? null : block('agents', 'AGENTS', rows.map(agentLine))

  // ---- PLUGINS ----

  const hasPlugins = plugins.roles.length > 0 || plugins.states.length > 0 || plugins.decisions.length > 0
  const pluginsSection = !hasPlugins
    ? null
    : block('plugins', 'PLUGINS', [
        ...plugins.roles.map(role => item(`role-${role.participantId}`, null, [<Text dimColor>ROLES </Text>, role.roles.join(', ')], shortHandle(role.participantId, me))),
        ...plugins.states.map(marker => item(`state-${marker.id}`, marker.href, [<Text dimColor>STATE </Text>, marker.title], marker.state)),
        ...plugins.decisions.map(decision => item(`decision-${decision.id}`, decision.href, [<Text dimColor>ASKED </Text>, <Text color="warning">{`◆ ${decision.snippet}`}</Text>])),
      ])

  // ---- ACTIVITY ----

  const recent = recentActivity(view.activity, nowMs)
  const hasSubActivity = recent.some(entry => entry.agentId !== MAIN)
  const isAll = view.view.showSubagents && hasSubActivity
  const listed = (isAll ? recent : recent.filter(entry => entry.agentId === MAIN)).slice(-ACTIVITY_SHOWN).reverse()
  const labelOf = (entry: OrchardActivityEntry) => (entry.agentId === MAIN ? 'main' : view.agents[entry.agentId]?.description || shortHandle(entry.handle, me))
  /** What the agent did reads as a verb after its arrow: "replied to Bram", not "Replied to Bram". */
  const verbed = (text: string) => (text === '' ? text : text.charAt(0).toLowerCase() + text.slice(1))
  const activitySection =
    recent.length === 0
      ? null
      : block(
          'activity',
          'ACTIVITY',
          [
            hasSubActivity ? (
              <Box key="activity-scope" flexDirection="row" justifyContent="flex-end" columnGap={1}>
                <Button key="scope-this" variant={isAll ? 'secondary' : 'primary'} label="this agent" onPress={() => on.showSubagents(false)} />
                <Button key="scope-all" variant={isAll ? 'primary' : 'secondary'} label="+ subagents" onPress={() => on.showSubagents(true)} />
              </Box>
            ) : null,
            ...(listed.length === 0 ? [<Text key="activity-none" dimColor>Nothing from this agent lately.</Text>] : []),
            ...listed.map((entry, i) => {
              const isOut = entry.direction === 'out'
              return item(
                `activity-${i}`,
                entry.href,
                [
                  ...(isAll ? [<Text color={entry.agentId === MAIN ? 'suggestion' : agentColor(entry.agentId)}>● </Text>, dim(`${labelOf(entry)} `)] : []),
                  <Text color={isOut ? 'suggestion' : undefined} dimColor={!isOut}>{isOut ? '→ ' : '← '}</Text>,
                  <Text dimColor={!isOut}>{isOut ? verbed(entry.text) : entry.text}</Text>,
                ],
                ago(entry.at, nowMs),
              )
            }),
          ],
        )

  return (
    <Box flexDirection="column" paddingX={GUTTER}>
      {top}
      {nowSection}
      {tasksSection}
      {agentsSection}
      {pluginsSection}
      {activitySection}
      {isQuietView ? null : (
        <Box key="footer" marginTop={1} justifyContent="center">
          {Svg === undefined ? <Text dimColor>{footerText(view.lastPollAt, nowMs)}</Text> : <Text key="footer" dimColor>{footerText(view.lastPollAt, nowMs)}</Text>}
        </Box>
      )}
    </Box>
  )
}
