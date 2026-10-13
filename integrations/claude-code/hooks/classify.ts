// What an alert does to the session: the notification settings and the one pure function
// that applies them. Levels are Slack/GitHub-style, one default plus optional per-channel
// overrides (design.md, "Wake rule: notification settings"). No `$`, no clock.
//
//   wake  - starts a turn in an idle session (subject to the batch window and the gap)
//   quiet - counted in the band and delivered with the next delivery or the next prompt
//   drop  - a plain channel post the level does not admit: not counted, not delivered
//
// The alert reasons are the server's (resources.rs alerts_once): direct, broadcast,
// mention, reply (a thread this participant started) and channel (only because the
// listener asks for `--channels`).

import type { OrchardLevel, OrchardSettings } from '../types'

export const LEVELS = ['all', 'participating', 'mentions', 'nothing'] as const
export type Level = OrchardLevel

export const isLevel = (value: unknown): value is Level => typeof value === 'string' && (LEVELS as readonly string[]).includes(value)

export const DEFAULT_BATCH_SECONDS = 10
export const MAX_BATCH_SECONDS = 120
export const DEFAULT_GAP_SECONDS = 60
export const MAX_GAP_SECONDS = 3600

/** The gap delays a wake; it never drops one. The batch window runs from the first waking alert. */
export type Settings = OrchardSettings

export const DEFAULT_SETTINGS: Settings = {
  defaultLevel: 'participating',
  channels: {},
  batchSeconds: DEFAULT_BATCH_SECONDS,
  gapSeconds: DEFAULT_GAP_SECONDS,
}

/** What classify reads of an alert. */
export type Classifiable = {
  /** The server's reasons. */
  reasons: readonly string[]
  /** The channel the message was posted in; null for direct messages and broadcasts. */
  channelId: string | null
  /** The message this one replies to. */
  threadId: string | null
}

/** The ids of messages in threads this participant started or posted in. */
export type Participation = { has: (id: string) => boolean }

export type Verdict = 'wake' | 'quiet' | 'drop'

/** Reasons that keep an alert visible (quiet) even when its level does not wake on it. */
const SERVER_REASONS: readonly string[] = ['direct', 'mention', 'reply', 'broadcast']

/**
 * Applies the settings to one alert.
 *
 * 1. Its scope is its channel when it has one, else the default. The scope's level is
 *    the channel's override if set, else the default level.
 * 2. wake if the level admits it. `all` admits everything; `participating` admits direct
 *    messages, mentions and replies in a thread this participant started or posted in;
 *    `mentions` admits direct messages and mentions; `nothing` admits nothing, except
 *    that a channel *override* of `nothing` still lets a mention through (a Slack mute),
 *    while a *default* of `nothing` is do-not-disturb and lets nothing through.
 * 3. otherwise quiet if the server gave it a reason or it replies in a participated thread.
 * 4. otherwise drop.
 */
export function classify(alert: Classifiable, settings: Settings, participation: Participation): Verdict {
  const { reasons } = alert
  const isDirect = reasons.includes('direct')
  const isMention = reasons.includes('mention')
  const isParticipatedReply = reasons.includes('reply') || (alert.threadId !== null && participation.has(alert.threadId))

  const override = alert.channelId === null ? undefined : settings.channels[alert.channelId]
  const level = override ?? settings.defaultLevel

  let isAdmitted: boolean
  switch (level) {
    case 'all':
      isAdmitted = true
      break
    case 'participating':
      isAdmitted = isDirect || isMention || isParticipatedReply
      break
    case 'mentions':
      isAdmitted = isDirect || isMention
      break
    case 'nothing':
      // Only an explicit channel mute lets a mention through; a default of nothing is DND.
      isAdmitted = override === 'nothing' && isMention
      break
  }
  if (isAdmitted) return 'wake'
  if (reasons.some(reason => SERVER_REASONS.includes(reason)) || isParticipatedReply) return 'quiet'
  return 'drop'
}

function clampSeconds(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(0, Math.round(value)))
}

/** The stored settings, or the defaults for anything missing or malformed. */
export function parseSettings(value: unknown): Settings {
  const rec = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const channels: Record<string, Level> = {}
  const rawChannels = rec.channels
  if (rawChannels !== null && typeof rawChannels === 'object' && !Array.isArray(rawChannels)) {
    for (const [id, level] of Object.entries(rawChannels)) {
      if (isLevel(level)) channels[id] = level
    }
  }
  return {
    defaultLevel: isLevel(rec.defaultLevel) ? rec.defaultLevel : DEFAULT_SETTINGS.defaultLevel,
    channels,
    batchSeconds: clampSeconds(rec.batchSeconds, DEFAULT_BATCH_SECONDS, MAX_BATCH_SECONDS),
    gapSeconds: clampSeconds(rec.gapSeconds, DEFAULT_GAP_SECONDS, MAX_GAP_SECONDS),
  }
}

/** Settings are kept per base id, shared by every session of the project; the rest of a record is per session handle. */
export const settingsKey = (endpoint: string, baseId: string): string => `settings ${endpoint} ${baseId}`
export const participationKey = (endpoint: string, participantId: string): string => `participation ${endpoint} ${participantId}`

/** How many participation ids are kept (the most recent). */
export const PARTICIPATION_KEEP = 500

/** Adds ids, newest last, keeping the most recent PARTICIPATION_KEEP. */
export function addParticipation(current: readonly string[], ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of [...current, ...ids].reverse()) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.slice(0, PARTICIPATION_KEEP).reverse()
}

export function parseParticipation(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(-PARTICIPATION_KEEP) : []
}
