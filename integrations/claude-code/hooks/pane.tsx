// The /orchard pane as a pure function of its data. register.tsx resolves the element
// table (`$.ui.resolve`) and builds the handlers (they are the `$` calls), so nothing here
// touches `$`. The mobile app draws no Input or Select: there the notification settings
// are text.
import type { Elements } from 'claude-code'

import type { OrchardPane, OrchardPaneThread, OrchardSettings } from '../types'
import { LEVELS } from './classify'
import { describeSettings } from './notify'
import { whenOf } from './threads'

export type Table = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'> & {
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
}

const LEVEL_LABELS: Record<(typeof LEVELS)[number], string> = {
  all: 'all: every message',
  participating: 'participating: direct messages, mentions, threads you are in',
  mentions: 'mentions: direct messages and mentions',
  nothing: 'nothing: do not disturb',
}

const LEVEL_OPTIONS = LEVELS.map(value => ({ value, label: LEVEL_LABELS[value] }))
const CHANNEL_OPTIONS = [{ value: 'inherit', label: 'default' }, ...LEVEL_OPTIONS]

/** "Open in Orchard": a Button, because the surfaces draw a Link only for https and localhost, which Orchard refuses. */
function openButton(ui: Table, id: string, href: string, on: PaneHandlers) {
  const { Button } = ui
  return <Button key={`open-${id}`} label="Open in Orchard" onPress={() => on.open(href)} />
}

export function renderPane(ui: Table, view: PaneView, on: PaneHandlers) {
  const { Box, Text, Button, Input, Select } = ui
  const { pane, settings } = view

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Orchard · {view.workspaceName || 'workspace'}</Text>
        <Text dimColor> · as {view.participantId}</Text>
      </Box>
      <Box>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={on.refresh} />
        {view.workspaceHref === null ? null : openButton(ui, 'workspace', view.workspaceHref, on)}
      </Box>

      <Text> </Text>
      <Text bold>Inbox</Text>
      {pane === null || pane.state === 'loading' ? <Text dimColor>Loading…</Text> : null}
      {pane?.state === 'failed' ? <Text color="error">{pane.error ?? 'could not read the workspace'}</Text> : null}
      {pane?.state === 'ready' && pane.threads.length === 0 ? <Text dimColor>Nothing in your inbox.</Text> : null}
      {(pane?.threads ?? []).map(thread => (
        <Box key={`thread-${thread.replyToId}`} flexDirection="column">
          <Text>
            {thread.last.senderName}
            {thread.last.isOwner ? ' (owner)' : ''} · {whenOf(thread.last.sentAt)}
            {thread.size > 1 ? ` · ${thread.size} messages` : ''}
          </Text>
          <Text dimColor>{thread.last.snippet}</Text>
          <Box>
            <Button key={`reply-${thread.replyToId}`} label="Reply…" onPress={() => on.reply(thread)} />
            {thread.href === null ? null : openButton(ui, `thread-${thread.replyToId}`, thread.href, on)}
          </Box>
        </Box>
      ))}

      <Text> </Text>
      <Text bold>Needs you</Text>
      {pane?.state === 'ready' && pane.decisions.length === 0 ? <Text dimColor>No open decisions.</Text> : null}
      {(pane?.decisions ?? []).map(decision => (
        <Box key={`decision-${decision.id}`}>
          <Text>{decision.snippet}</Text>
          <Text dimColor> {whenOf(decision.sentAt)} </Text>
          {decision.href === null ? null : openButton(ui, `decision-${decision.id}`, decision.href, on)}
        </Box>
      ))}

      <Text> </Text>
      <Text bold>Claimed tasks</Text>
      {pane?.state === 'ready' && pane.tasks.length === 0 ? <Text dimColor>No claimed tasks.</Text> : null}
      {(pane?.tasks ?? []).map(task => (
        <Box key={`task-${task.id}`}>
          <Text>{task.title}</Text>
          <Text dimColor> {task.status} </Text>
          {task.href === null ? null : openButton(ui, `task-${task.id}`, task.href, on)}
        </Box>
      ))}

      <Text> </Text>
      <Text bold>Notifications</Text>
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
    </Box>
  )
}
