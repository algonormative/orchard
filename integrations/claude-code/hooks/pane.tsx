// The /orchard pane as a pure function of its data. register.tsx resolves the element
// table (`$.ui.resolve`) and builds the handlers (they are the `$` calls), so nothing here
// touches `$`. Drawn parts (header, thread rows, section labels, footer) are Svg strings from
// svg.ts on the surfaces that draw an Svg; the terminal has none and gets the same structure
// as Text. Everything clickable is a Box/Text/Button/Select, as an Svg cannot hold a control.
// The mobile app draws no Input or Select: there the notification settings are text.
import type { Elements } from 'claude-code'

import type { OrchardCounts, OrchardPane, OrchardPaneThread, OrchardSettings, OrchardStatus } from '../types'
import { actionHref, answerLink, detailActions, headerActions, rowActions, snoozedLine } from './actions'
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
  /** The surface drawing the pane: the row actions show on hover only where there is a pointer to hover. */
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

/** The overlay covers the time the card draws; no theme token is the card's green, 'subtle' is the closest neutral. */
const OVERLAY_BG = 'subtle'

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
  // Only a surface with a pointer can hover; the terminal and the phone show the dim line below the card, always.
  const isHoverSurface = view.surface === 'desktop' || view.surface === 'vscode'
  // The overlay needs both a pointer and a drawn card to sit on.
  const isOverlay = isHoverSurface && Svg !== undefined
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

  /**
   * The row's quick actions as the dim Markdown line below the card: the terminal and the phone, which
   * have no pointer to hover (the phone has no absolute overlay worth trusting either), so it is simply there.
   */
  const actionLine = (thread: OrchardPaneThread, isOpen: boolean) => {
    const key = thread.replyToId
    const confirm = pane?.confirm?.id === key ? pane.confirm.verb : null
    return (
      <Box>
        {links(`actions-${key}`, rowActions({ id: key, isPending: pendingIds.has(key), isNext: nextIds.has(key), isOpen, confirm }), confirm === null)}
      </Box>
    )
  }

  /** One single-glyph control of the overlay: a plain Button, answered by the same `act` the links use. */
  const glyph = (verb: Verb, id: string, label: string) => (
    <Button key={`btn-${verb}-${id}`} plain label={label} onPress={() => on.act(actionHref(verb, id))} />
  )

  /**
   * The row's quick actions on a surface with a pointer: a compact group of glyph Buttons laid over the
   * card's top-right corner, where the relative time is drawn, so nothing in the flow moves. Drawn
   * `display: none` and revealed while the pointer is over the row (the row's keyed Box is the hover scope).
   * While the row asks "remove?" / "interrupt?" it is not hover-gated, or the question would vanish with the pointer.
   */
  const overlayOf = (thread: OrchardPaneThread, isOpen: boolean) => {
    const id = thread.replyToId
    const confirm = pane?.confirm?.id === id ? pane.confirm.verb : null
    const isPending = pendingIds.has(id)
    const common = { position: 'absolute', top: 0, right: 1, backgroundColor: OVERLAY_BG, flexDirection: 'row' } as const
    if (confirm !== null) {
      return (
        <Box {...common}>
          <Text>{confirm === 'remove' ? 'remove? ' : 'interrupt? '}</Text>
          {glyph(confirm === 'remove' ? 'remove-yes' : 'interrupt-yes', id, '✓')}
          <Text> </Text>
          {glyph('cancel', id, '✗')}
        </Box>
      )
    }
    // No key on this Box: a keyed Box is its own hover scope, and a Box that is not drawn cannot be hovered.
    return (
      <Box {...common} display="none" hover={{ display: 'flex' }}>
        {glyph('remove', id, '✕')}
        {isPending ? <Text> </Text> : null}
        {isPending ? glyph('snooze', id, '◷') : null}
        {isPending ? <Text> </Text> : null}
        {isPending ? (nextIds.has(id) ? <Text>⇡✓</Text> : glyph('next', id, '⇡')) : null}
        {isPending ? <Text> </Text> : null}
        {isPending ? glyph('interrupt', id, '⚡') : null}
        <Text> </Text>
        {glyph('more', id, isOpen ? '▴' : '▾')}
      </Box>
    )
  }

  const row = (thread: OrchardPaneThread) => {
    const key = thread.replyToId
    const isOpen = expanded.has(key)
    const { last } = thread
    const age = relativeTime(last.sentAt, nowMs) + (thread.size > 1 ? ` · ${thread.size}` : '')
    const card =
      Svg === undefined ? (
        <Box flexDirection="column">
          <Text dimColor={!thread.isUnread} bold={thread.isUnread}>
            {thread.isUnread ? '● ' : '  '}
            {last.senderName} [{thread.reason}] · {age}
          </Text>
          <Text dimColor>{'  '}{cut(last.snippet, 80)}</Text>
        </Box>
      ) : (
        picture(`thread-svg-${key}`, rowSvg(w, thread, nowMs), `${last.senderName}, ${thread.reason}${thread.isUnread ? ', new' : ''}: ${last.snippet}`, rowHeight(thread))
      )
    return (
      <Box key={`thread-${key}`} flexDirection="column">
        {isOverlay ? (
          <Box position="relative">
            {card}
            {overlayOf(thread, isOpen)}
          </Box>
        ) : (
          card
        )}
        {isOverlay ? null : actionLine(thread, isOpen)}
        {isOpen ? (
          <Box flexDirection="column">
            <Text>{last.snippet}</Text>
            <Text dimColor>
              {thread.size > 1 ? `${thread.size} messages` : '1 message'} · {relativeTime(last.sentAt, nowMs)} ago
            </Text>
            {links(`detail-${key}`, detailActions(key, thread.href !== null))}
          </Box>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {links('header-actions', headerActions(view.workspaceHref !== null))}

      {section('section-inbox', 'INBOX', pill)}
      {pane === null || pane.state === 'loading' ? <Text dimColor>Loading…</Text> : null}
      {pane?.state === 'failed' ? <Text color="error">{pane.error ?? 'could not read the workspace'}</Text> : null}
      {snoozed === null ? null : <Text dimColor>{snoozed}</Text>}
      {pane?.state === 'ready' && threads.length === 0 ? <Text dimColor>Nothing in Claude's inbox.</Text> : null}
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
