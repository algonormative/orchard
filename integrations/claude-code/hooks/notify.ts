// `/orchard notify ...` as pure functions: reading the command, applying it to the
// settings, and saying what the settings are. No `$`.
import type { OrchardSettings } from '../types'
import { LEVELS, MAX_BATCH_SECONDS, MAX_GAP_SECONDS, isLevel } from './classify'
import type { Level } from './classify'

export type ChannelRef = { id: string; name: string }

export type NotifyCommand =
  | { kind: 'show' }
  /** `channel` null is the default level; `level` 'inherit' clears a channel's override. */
  | { kind: 'level'; channel: ChannelRef | null; level: Level | 'inherit' }
  | { kind: 'rate'; which: 'batch' | 'gap'; seconds: number }
  | { kind: 'error'; message: string }

export const NOTIFY_USAGE =
  'Usage: /orchard notify  (show) · /orchard notify <default|#channel> <all|participating|mentions|nothing> ' +
  '(for a channel, "default" clears its override) · /orchard notify batch|gap <seconds>'

const channelWord = (ref: ChannelRef) => `#${ref.name}`

/** A number of seconds for the batch window or the gap. */
export function parseRate(which: 'batch' | 'gap', text: string): Extract<NotifyCommand, { kind: 'rate' | 'error' }> {
  const max = which === 'batch' ? MAX_BATCH_SECONDS : MAX_GAP_SECONDS
  const value = text.trim()
  const seconds = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(seconds) || seconds > max) {
    return { kind: 'error', message: `${which} is a whole number of seconds from 0 to ${max}` }
  }
  return { kind: 'rate', which, seconds }
}

/** `rest` is what follows `notify`. `channels` is what the participant can see. */
export function parseNotify(rest: string, channels: readonly ChannelRef[]): NotifyCommand {
  const words = rest.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: 'show' }
  const [what = '', value = ''] = words
  if (what === 'batch' || what === 'gap') return parseRate(what, words.length === 2 ? value : '')
  if (words.length !== 2) return { kind: 'error', message: NOTIFY_USAGE }

  const isChannelSetting = what.startsWith('#')
  if (what !== 'default' && !isChannelSetting) return { kind: 'error', message: NOTIFY_USAGE }
  if (what === 'default' && value === 'default') return { kind: 'error', message: 'the default level is one of ' + LEVELS.join(', ') }
  if (!isLevel(value) && !(isChannelSetting && value === 'default')) {
    return { kind: 'error', message: `level is one of ${LEVELS.join(', ')}${isChannelSetting ? ', or default to clear the override' : ''}` }
  }
  const level: Level | 'inherit' = value === 'default' ? 'inherit' : (value as Level)
  if (what === 'default') return { kind: 'level', channel: null, level }

  const wanted = what.slice(1).toLowerCase()
  const channel = channels.find(c => c.name.toLowerCase() === wanted || c.id.toLowerCase() === wanted)
  if (channel === undefined) {
    const known = channels.map(channelWord).join(', ')
    return { kind: 'error', message: `no channel named ${what}${known === '' ? '' : `; the channels are ${known}`}` }
  }
  return { kind: 'level', channel, level }
}

/** The settings with one command applied. */
export function applyNotify(settings: OrchardSettings, command: Exclude<NotifyCommand, { kind: 'show' | 'error' }>): OrchardSettings {
  if (command.kind === 'rate') {
    return command.which === 'batch' ? { ...settings, batchSeconds: command.seconds } : { ...settings, gapSeconds: command.seconds }
  }
  if (command.channel === null) {
    return command.level === 'inherit' ? settings : { ...settings, defaultLevel: command.level }
  }
  const channels = { ...settings.channels }
  if (command.level === 'inherit') delete channels[command.channel.id]
  else channels[command.channel.id] = command.level
  return { ...settings, channels }
}

/** One short paragraph of what is set. Channel overrides are shown by name; an id with no known name by itself. */
export function describeSettings(settings: OrchardSettings, channels: readonly ChannelRef[]): string {
  const names = new Map(channels.map(c => [c.id, c.name]))
  const overrides = Object.entries(settings.channels).map(([id, level]) => `#${names.get(id) ?? id} ${level}`)
  return [
    `Orchard notifications: default ${settings.defaultLevel}`,
    overrides.length > 0 ? `channels ${overrides.join(', ')}` : 'no channel overrides',
    `batch window ${settings.batchSeconds} s`,
    `minimum gap ${settings.gapSeconds} s`,
  ].join(' · ')
}
