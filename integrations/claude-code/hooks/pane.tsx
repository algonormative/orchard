// The /orchard pane as a pure function of its data. register.tsx resolves the element
// table (`$.ui.resolve`) and builds the handlers (they are the `$` calls), so nothing here
// touches `$`. Drawn parts (header, thread rows, section labels, footer) are Svg strings from
// svg.ts on the surfaces that draw an Svg; the terminal has none and gets the same structure
// as Text. Everything clickable is a Box/Text/Button/Select, as an Svg cannot hold a control.
// The mobile app draws no Input or Select: there the notification settings are text.
import type { Elements } from 'claude-code'

import type { OrchardCounts, OrchardPane, OrchardPaneThread, OrchardSettings, OrchardStatus } from '../types'
import { LEVELS } from './classify'
import { describeSettings } from './notify'
import { relativeTime } from './threads'
import { FOOTER_HEIGHT, chipOf, cut, footerSvg, footerText, headerSvg, rowHeight, rowSvg, sectionSvg, widthOf } from './svg'

export type Table = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'> & {
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
}

export type PaneHandlers = {
  refresh: () => void
  /** Opens an address of the browser UI in the person's browser. */
  open: (href: string) => void
  /** Fills the prompt with a reply draft. Never submits. */
  reply: (thread: OrchardPaneThread) => void
  /** `channelId` null is the default level; `level` may be 'inherit' for a channel. */
  setLevel: (channelId: string | null, level: string) => void
  setRate: (which: 'batch' | 'gap', text: string) => void
  /** Opens or closes the fold of older threads. */
  toggleOlder: () => void
  /** Opens or closes one thread's detail (by its reply id). */
  toggleThread: (replyToId: string) => void
}

/** How many of the newest threads show before the rest fold away. */
export const VISIBLE_THREADS = 5

const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  all: 'all: every message',
  participating: 'participating: direct messages, mentions, threads you are in',
  mentions: 'mentions: direct messages and mentions',
  nothing: 'nothing: do not disturb',
}

const LEVEL_OPTIONS = LEVELS.map(value => ({ value, label: LEVEL_LABELS[value] }))
const CHANNEL_OPTIONS = [{ value: 'inherit', label: 'default' }, ...LEVEL_OPTIONS]

/** A control opening one page of Orchard: a Button, because the surfaces draw a Link only for https and localhost, which Orchard refuses. */
function openButton(ui: Table, id: string, href: string, on: PaneHandlers, label = 'Open in Orchard') {
  const { Button } = ui
  return <Button key={`open-${id}`} label={label} onPress={() => on.open(href)} />
}

const CHIP_TOKEN = { listening: 'success', waiting: 'warning', offline: 'error', error: 'error', shared: undefined, connecting: undefined } as const

export function renderPane(ui: Table, view: PaneView, on: PaneHandlers) {
  const { Box, Text, Button, Input, Select, Svg } = ui
  const { pane, settings, nowMs } = view
  const w = widthOf(view.columns)
  const chip = chipOf(view.status, view.counts)
  const threads = pane?.threads ?? []
  const isOlderShown = pane?.isOlderShown === true
  const expanded = new Set(pane?.expanded ?? [])
  const shown = isOlderShown ? threads : threads.slice(0, VISIBLE_THREADS)
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
          <Text bold>◆ Orchard · {view.workspaceName || 'workspace'}</Text>
          <Text dimColor> · as {view.participantId}</Text>
        </Box>
        <Text color={CHIP_TOKEN[chip.kind]} dimColor={CHIP_TOKEN[chip.kind] === undefined}>● {chip.label}</Text>
      </Box>
    ) : (
      picture(
        'header',
        headerSvg(w, { workspaceName: view.workspaceName, participantId: view.participantId, chip }),
        `Orchard workspace ${view.workspaceName || ''}, ${chip.label}`.replace(/\s+,/, ','),
        90,
        true,
      )
    )

  const row = (thread: OrchardPaneThread) => {
    const key = thread.replyToId
    const isOpen = expanded.has(key)
    const { last } = thread
    const age = relativeTime(last.sentAt, nowMs) + (thread.size > 1 ? ` · ${thread.size}` : '')
    return (
      <Box key={`thread-${key}`} flexDirection="column">
        {Svg === undefined ? (
          <Box flexDirection="column">
            <Text dimColor={!thread.isUnread} bold={thread.isUnread}>
              {thread.isUnread ? '● ' : '  '}
              {last.senderName} [{thread.reason}] · {age}
            </Text>
            <Text dimColor>{'  '}{cut(last.snippet, 80)}</Text>
          </Box>
        ) : (
          picture(`thread-svg-${key}`, rowSvg(w, thread, nowMs), `${last.senderName}, ${thread.reason}${thread.isUnread ? ', new' : ''}: ${last.snippet}`, rowHeight(thread))
        )}
        <Box>
          <Button key={`reply-${key}`} label="Reply…" onPress={() => on.reply(thread)} />
          <Button key={`toggle-${key}`} label={isOpen ? '▾ less' : '▸ more'} onPress={() => on.toggleThread(key)} />
        </Box>
        {isOpen ? (
          <Box flexDirection="column">
            <Text>{last.snippet}</Text>
            <Text dimColor>
              {thread.size > 1 ? `${thread.size} messages` : '1 message'} · {relativeTime(last.sentAt, nowMs)} ago
            </Text>
            {thread.href === null ? null : openButton(ui, `thread-${key}`, thread.href, on, 'Open thread')}
          </Box>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      <Box>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={on.refresh} />
        {view.workspaceHref === null ? null : openButton(ui, 'workspace', view.workspaceHref, on)}
      </Box>

      {section('section-inbox', 'INBOX', pill)}
      {pane === null || pane.state === 'loading' ? <Text dimColor>Loading…</Text> : null}
      {pane?.state === 'failed' ? <Text color="error">{pane.error ?? 'could not read the workspace'}</Text> : null}
      {pane?.state === 'ready' && threads.length === 0 ? <Text dimColor>Nothing in your inbox.</Text> : null}
      {shown.map(row)}
      {older > 0 ? <Button key="older-threads" label={`▸ ${older} older thread${older === 1 ? '' : 's'}`} onPress={on.toggleOlder} /> : null}
      {isOlderShown && threads.length > VISIBLE_THREADS ? <Button key="older-threads" label="▾ hide older threads" onPress={on.toggleOlder} /> : null}

      {section('section-needs', 'NEEDS YOU')}
      {pane?.state === 'ready' && pane.decisions.length === 0 ? <Text color="success">✓ no open decisions</Text> : null}
      {(pane?.decisions ?? []).map(decision => (
        <Box key={`decision-${decision.id}`}>
          <Text color="warning">◆ {decision.snippet}</Text>
          <Text dimColor> {relativeTime(decision.sentAt, nowMs)} </Text>
          {decision.href === null ? null : openButton(ui, `decision-${decision.id}`, decision.href, on, 'Open')}
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
