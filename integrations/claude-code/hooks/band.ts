// What the band says, as plain data so tests can read it without drawing. One line, always
// drawn once there is a status: a connected session with nothing going on says it is connected
// (a standing sign that it is alive), and the line grows with what this session is doing:
// the message it is handling, what waits, its subagents. Never ids, request ids or paths: the
// workspace name, a fixed phrase, or an error message that orchard-cli has already stripped.
// The tones map to the theme's own colours (the band is Text-only), so it follows light/dark.
import type { OrchardAgents, OrchardCounts, OrchardNow, OrchardStatus, OrchardWorkspace } from '../types'
import { plain } from './config'
import { handlingText, subagentCounts } from './feed'

/** mark: the diamond; plain: the theme's text colour; dim; ok/warn/err: success, warning, error. */
export type BandTone = 'mark' | 'plain' | 'dim' | 'ok' | 'warn' | 'err'
export type BandSegment = { text: string; tone: BandTone }
export type BandLine = {
  /** The whole line, the segments joined. */
  text: string
  segments: BandSegment[]
  /** The line's overall mood: quiet is dimmed by the caller where a segment has no tone of its own. */
  tone: 'quiet' | 'warning' | 'error'
}

/** Everything the line is made of. */
export type BandInput = {
  status: OrchardStatus | null
  workspace: OrchardWorkspace | null
  counts: OrchardCounts
  /** The messages the main loop is handling now. */
  now?: OrchardNow | null
  agents?: OrchardAgents
}

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
const SHORT_NAME = 24

const dim = (text: string): BandSegment => ({ text, tone: 'dim' })
const line = (segments: BandSegment[], tone: BandLine['tone']): BandLine => ({ text: segments.map(s => s.text).join(''), segments, tone })
const SEP = dim(' · ')

/** The workspace name cut to fit a band; empty when it has none. */
export function shortName(workspace: OrchardWorkspace | null): string {
  const name = plain(workspace?.name ?? '', 60)
  return name.length > SHORT_NAME ? `${name.slice(0, SHORT_NAME - 1)}…` : name
}

/** `◆ Claude in <workspace>`: whose line this is. Before the workspace is known: `◆ Claude`. */
const headOf = (name: string): BandSegment[] => [
  { text: '◆ ', tone: 'mark' },
  { text: 'Claude', tone: 'plain' },
  ...(name === '' ? [] : [dim(' in '), { text: name, tone: 'plain' as const }]),
]

/** `◇ Claude is disconnected from <workspace> · /orchard connect`, all dim: the session is not in the workspace. */
const leftLine = (what: string, name: string): BandLine =>
  line([dim(`◇ Claude is ${what}${name === '' ? ' the workspace' : ` ${name}`} · /orchard connect`)], 'quiet')

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function bandLine(input: BandInput): BandLine | null {
  const { status, counts } = input
  if (status === null) return null
  const name = shortName(input.workspace)
  const head = headOf(name)

  switch (status.kind) {
    case 'connecting':
      return line([...head, dim(' · connecting…')], 'quiet')
    case 'offline':
      return line([...head, { text: ' · ○ offline', tone: 'warn' }], 'warning')
    case 'error':
      return line([...head, { text: ` · error: ${plain(status.message, 120)}`, tone: 'err' }], 'error')
    case 'shared':
      return line([...head, dim(' · another session is listening')], 'quiet')
    case 'disconnected':
      return leftLine('disconnected from', name)
    case 'signed-off':
      return leftLine('signed off from', name)
    case 'connected': {
      const unread = count(counts.unread)
      const needsYou = count(counts.needsYou)
      const isStoreFailing = status.isStoreFailing === true
      const subs = subagentCounts(input.agents ?? {})
      // A subagent run that ended cleanly is no news; one still going, or still signed on, is.
      const hasSubagents = subs.running > 0 || subs.stillOn > 0
      const now = input.now ?? null
      if (now === null && unread === 0 && needsYou === 0 && !isStoreFailing && !hasSubagents) {
        return line([{ text: '◆ ', tone: 'mark' }, dim('Claude is connected to '), { text: name === '' ? 'the workspace' : name, tone: 'plain' }], 'quiet')
      }
      const parts: BandSegment[][] = []
      if (now !== null) parts.push([{ text: handlingText(now), tone: 'plain' }])
      if (unread > 0) parts.push([{ text: `${unread} queued`, tone: 'plain' }])
      if (needsYou > 0) parts.push([{ text: `needs you ${needsYou}`, tone: 'warn' }])
      if (counts.isHeld === true && unread > 0) parts.push([dim('sends when box is empty')])
      if (hasSubagents) {
        parts.push([{ text: plural(subs.total, 'subagent'), tone: 'plain' }])
        if (subs.running > 0) parts.push([{ text: `${subs.running} running`, tone: 'ok' }])
        if (subs.stillOn > 0) parts.push([{ text: `${subs.stillOn} still signed on`, tone: 'warn' }])
      }
      if (isStoreFailing) parts.push([{ text: 'could not save its place (store write failed)', tone: 'warn' }])
      const segments = parts.reduce<BandSegment[]>((all, part) => [...all, SEP, ...part], [...head])
      return line(segments, isStoreFailing ? 'warning' : 'quiet')
    }
  }
}
