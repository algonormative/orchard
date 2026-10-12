// The /orchard pane as a pure function of its data. register.tsx resolves the element
// table (`$.ui.resolve`) and builds the handlers (they are the `$` calls), so nothing here
// touches `$`. Drawn parts (header, thread rows, section labels, footer) are Svg strings from
// svg.ts on the surfaces that draw an Svg; the terminal has none and gets the same structure
// as Text. Everything clickable is a Box/Text/Button/Select, as an Svg cannot hold a control.
// The mobile app draws no Input or Select: there the notification settings are text.
import type { Elements } from 'claude-code'

import type { OrchardCounts, OrchardPane, OrchardPaneThread, OrchardSettings, OrchardStatus } from '../types'
import { VISIBLE_THREADS, actionHref, answerLink, confirmQuestion, selectedId, shownThreads, snoozedLine, toolbarItems } from './actions'
import type { ActionLine, Verb } from './actions'
import { LEVELS } from './classify'
import { describeSettings } from './notify'
import { relativeTime } from './threads'
import { FOOTER_HEIGHT, chipOf, cut, footerSvg, footerText, headerSvg, rowHeight, rowSvg, sectionSvg, widthOf } from './svg'

export type Table = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button' | 'Markdown'> & {
  /** Absent on the terminal; the caller also leaves it out where a surface should not draw one. */
  Svg?: Elements['desktop']['Svg']
  Input?: Elements['terminal']['Input']
  Select?: Elements['terminal']['Select']
}

export type PaneView = {
  /** Shown in the header and nowhere else. */
  participantId: string
  workspaceName: string
  /** Where the header's Open in Orchard goes; null when the endpoint has no workspace in it. */
  workspaceHref: string | null
  pane: OrchardPane | null
  settings: OrchardSettings
  status: OrchardStatus | null
  counts: OrchardCounts | null
  /** The clock, for relative times and the footer. */
  nowMs: number
  /** Cells across the pane body, for sizing the drawings. */
  columns?: number
  /** The surface drawing the pane. */
  surface?: 'terminal' | 'desktop' | 'vscode' | 'mobile'
  /** Message ids with an alert waiting in the queue, and those marked "handle next". */
  pendingIds?: ReadonlySet<string>
  nextIds?: ReadonlySet<string>
}

export type PaneHandlers = {
  /** A press on one of the synthetic action links (actions.ts): remove, snooze, refresh, ... */
  act: (href: string) => void
  /** Opens an address of the browser UI in the person's browser. */
  open: (href: string) => void
  /** `channelId` null is the default level; `level` may be 'inherit' for a channel. */
  setLevel: (channelId: string | null, level: string) => void
  setRate: (which: 'batch' | 'gap', text: string) => void
  /** Opens or closes the fold of older threads. */
  toggleOlder: () => void
}

export { VISIBLE_THREADS }

const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  all: 'all: every message',
  participating: 'participating: direct messages, mentions, threads you are in',
  mentions: 'mentions: direct messages and mentions',
  nothing: 'nothing: do not disturb',
}

const LEVEL_OPTIONS = LEVELS.map(value => ({ value, label: LEVEL_LABELS[value] }))
const CHANNEL_OPTIONS = [{ value: 'inherit', label: 'default' }, ...LEVEL_OPTIONS]

/** A control opening one page of Orchard: a Button, because the surfaces draw a Link only for https and localhost, which Orchard refuses. */
function openButton(ui: Table, id: string, href: string, on: PaneHandlers, label = 'Open in Orchard ↗') {
  const { Button } = ui
  return <Button key={`open-${id}`} label={label} onPress={() => on.open(href)} />
}

const CHIP_TOKEN = { listening: 'success', waiting: 'warning', offline: 'error', error: 'error', shared: undefined, connecting: undefined } as const

export function renderPane(ui: Table, view: PaneView, on: PaneHandlers) {
  const { Box, Text, Button, Markdown, Input, Select, Svg } = ui
  const { pane, settings, nowMs } = view
  const w = widthOf(view.columns)
  const chip = chipOf(view.status, view.counts)
  // Removed and snoozed messages are out of the inbox; the window is read again on Refresh, so the pane hides them itself.
  const away = new Set([...(pane?.hidden ?? []), ...(pane?.snoozed ?? []).map(s => s.id)])
  const threads = (pane?.threads ?? []).filter(t => !away.has(t.replyToId))
  const snoozed = snoozedLine(pane?.snoozed ?? [])
  const pendingIds = view.pendingIds ?? new Set<string>()
  const nextIds = view.nextIds ?? new Set<string>()
  const isOlderShown = pane?.isOlderShown === true
  const expanded = new Set(pane?.expanded ?? [])
  const shown = shownThreads({ threads, isOlderShown })
  const selectedKey = selectedId(shown, pane?.selected)
  const older = threads.length - shown.length
  const unreadCount = threads.filter(t => t.isUnread).length
  const pill = unreadCount > 0 ? `${unreadCount} NEW` : undefined

  const picture = (key: string, source: string, alt: string, height: number, isInteractive = false) =>
    Svg === undefined ? null : <Svg key={key} source={source} alt={alt} width={w} height={height} isInteractive={isInteractive} />

  /** A section label: the drawn rule and caps on Svg surfaces, a Text line elsewhere. */
  const section = (key: string, label: string, withPill?: string) =>
    Svg === undefined ? (
      <Box key={key}>
        <Text bold color="warning">{label}</Text>
        {withPill === undefined ? null : <Text bold> [{withPill}]</Text>}
      </Box>
    ) : (
      picture(key, sectionSvg(w, label, withPill), withPill === undefined ? label : `${label}, ${withPill}`, 30)
    )

  const header =
    Svg === undefined ? (
      <Box key="header" flexDirection="column">
        <Box>
          <Text bold>◆ Claude's inbox · {view.workspaceName || 'workspace'}</Text>
          <Text dimColor> · as {view.participantId}</Text>
        </Box>
        <Text color={CHIP_TOKEN[chip.kind]} dimColor={CHIP_TOKEN[chip.kind] === undefined}>● {chip.label}</Text>
      </Box>
    ) : (
      picture(
        'header',
        headerSvg(w, { workspaceName: view.workspaceName, participantId: view.participantId, chip }),
        `Claude's inbox, workspace ${view.workspaceName || ''}, ${chip.label}`.replace(/\s+,/, ','),
        90,
        true,
      )
    )

  /** One line of text links: a Markdown whose links are answered by `on.act` and nothing else. */
  const links = (key: string, action: ActionLine, isDim = true) => (
    <Markdown key={key} text={action.text} dimColor={isDim} pressableLinks={action.links} onLinkPress={link => on.act(link.href)} />
  )

  /** One standard Button; a press goes through the same `act` as every other action. */
  const press = (key: string, label: string, verb: Verb, id: string, hotkey?: string, variant?: 'primary') => (
    <Button key={key} label={label} hotkey={hotkey} variant={variant} onPress={() => on.act(actionHref(verb, id))} />
  )

  const selectedThread = shown.find(t => t.replyToId === selectedKey)

  /**
   * The one toolbar above the list. Its buttons act on the selected thread. While a question is asked
   * of that thread it gives way to the question, named for the sender, with Confirm and Cancel.
   */
  const toolbar = () => {
    if (selectedThread === undefined) return null
    const id = selectedThread.replyToId
    const confirm = pane?.confirm
    if (confirm !== null && confirm !== undefined && shown.some(t => t.replyToId === confirm.id)) {
      const asked = shown.find(t => t.replyToId === confirm.id) as OrchardPaneThread
      return (
        <Box key="toolbar" flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text bold>{confirmQuestion(confirm.verb, asked.last.senderName)}</Text>
          {press('tb-confirm', 'Confirm', confirm.verb === 'remove' ? 'remove-yes' : 'interrupt-yes', confirm.id, 'y', 'primary')}
          {press('tb-cancel', 'Cancel', 'cancel', confirm.id, 'c')}
        </Box>
      )
    }
    const items = toolbarItems({ isPending: pendingIds.has(id), isNext: nextIds.has(id), hasHref: selectedThread.href !== null })
    return (
      <Box key="toolbar" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {items.map(item => press(`tb-${item.verb}`, item.label, item.verb, item.verb === 'select-prev' || item.verb === 'select-next' ? '-' : id, item.hotkey))}
        {nextIds.has(id) && pendingIds.has(id) ? <Text dimColor>next ✓</Text> : null}
      </Box>
    )
  }

  const row = (thread: OrchardPaneThread) => {
    const key = thread.replyToId
    const isSelected = key === selectedKey
    const { last } = thread
    const age = relativeTime(last.sentAt, nowMs) + (thread.size > 1 ? ` · ${thread.size}` : '')
    const card =
      Svg === undefined ? (
        <Box flexDirection="column">
          <Text dimColor={!thread.isUnread} bold={thread.isUnread}>
            {isSelected ? '▶ ' : thread.isUnread ? '● ' : '  '}
            {last.senderName} [{thread.reason}] · {age}
          </Text>
          <Text dimColor>{'  '}{cut(last.snippet, 80)}</Text>
        </Box>
      ) : (
        picture(
          `thread-svg-${key}`,
          rowSvg(w, thread, nowMs, isSelected),
          `${last.senderName}, ${thread.reason}${thread.isUnread ? ', new' : ''}${isSelected ? ', selected' : ''}: ${last.snippet}`,
          rowHeight(thread),
        )
      )
    return (
      <Box key={`thread-${key}`} flexDirection="column">
        {card}
        {expanded.has(key) ? (
          <Box flexDirection="column">
            <Text>{last.snippet}</Text>
            <Text dimColor>
              {thread.size > 1 ? `${thread.size} messages` : '1 message'} · {relativeTime(last.sentAt, nowMs)} ago
            </Text>
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {press(`detail-reply-${key}`, 'reply…', 'reply', key)}
              {thread.href === null ? null : press(`detail-open-${key}`, 'Open thread ↗', 'open-thread', key)}
            </Box>
          </Box>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      <Box key="header-actions" flexDirection="row" flexWrap="wrap" columnGap={1}>
        {view.workspaceHref === null ? null : openButton(ui, 'workspace', view.workspaceHref, on)}
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => on.act(actionHref('refresh'))} />
      </Box>

      {section('section-inbox', 'INBOX', pill)}
      {pane === null || pane.state === 'loading' ? <Text dimColor>Loading…</Text> : null}
      {pane?.state === 'failed' ? <Text color="error">{pane.error ?? 'could not read the workspace'}</Text> : null}
      {snoozed === null ? null : <Text dimColor>{snoozed}</Text>}
      {pane?.state === 'ready' && threads.length === 0 ? <Text dimColor>Nothing in Claude's inbox.</Text> : null}
      {toolbar()}
      {shown.map(row)}
      {older > 0 ? <Button key="older-threads" label={`▸ ${older} older thread${older === 1 ? '' : 's'}`} onPress={on.toggleOlder} /> : null}
      {isOlderShown && threads.length > VISIBLE_THREADS ? <Button key="older-threads" label="▾ hide older threads" onPress={on.toggleOlder} /> : null}

      {section('section-needs', 'NEEDS YOU')}
      {pane?.state === 'ready' && pane.decisions.length === 0 ? <Text color="success">✓ no open decisions</Text> : null}
      {(pane?.decisions ?? []).map(decision => (
        <Box key={`decision-${decision.id}`}>
          <Text color="warning">◆ {decision.snippet}</Text>
          <Text dimColor> {relativeTime(decision.sentAt, nowMs)} </Text>
          {decision.href === null ? null : links(`answer-${decision.id}`, answerLink(decision.id), false)}
        </Box>
      ))}

      {section('section-tasks', 'CLAIMED TASKS')}
      {pane?.state === 'ready' && pane.tasks.length === 0 ? <Text dimColor>none — the grove is quiet</Text> : null}
      {(pane?.tasks ?? []).map(task => (
        <Box key={`task-${task.id}`}>
          <Text>{task.title}</Text>
          <Text dimColor> {task.status} </Text>
          {task.href === null ? null : openButton(ui, `task-${task.id}`, task.href, on, 'Open')}
        </Box>
      ))}

      {section('section-notify', 'NOTIFY')}
      {Select === undefined || Input === undefined ? (
        <Text>{describeSettings(settings, pane?.channels ?? [])}</Text>
      ) : (
        <Box flexDirection="column">
          <Select key="notify-default" label="Default" options={LEVEL_OPTIONS} value={settings.defaultLevel} onSelect={value => on.setLevel(null, value)} />
          {(pane?.channels ?? []).map(channel => (
            <Select
              key={`notify-channel-${channel.id}`}
              label={`#${channel.name}`}
              options={CHANNEL_OPTIONS}
              value={settings.channels[channel.id] ?? 'inherit'}
              onSelect={value => on.setLevel(channel.id, value)}
            />
          ))}
          <Input key="notify-batch" label="Batch window (seconds, 0-120)" value={String(settings.batchSeconds)} onSubmit={value => on.setRate('batch', value)} />
          <Input key="notify-gap" label="Minimum gap between wakes (seconds, 0-3600)" value={String(settings.gapSeconds)} onSubmit={value => on.setRate('gap', value)} />
        </Box>
      )}
      <Text dimColor>A wake starts a turn in an idle session. Quiet items wait for your next prompt.</Text>
      {Svg === undefined ? (
        <Text dimColor>{footerText(view.counts?.lastPollAt, nowMs)}</Text>
      ) : (
        picture('footer', footerSvg(w, footerText(view.counts?.lastPollAt, nowMs)), 'Tending the grove', FOOTER_HEIGHT)
      )}
    </Box>
  )
}
