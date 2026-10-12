// What the band says, as plain data so tests can read it without drawing. One line, always
// drawn once there is a status: a connected session with nothing pending still says it is
// listening (a standing sign that it is alive). Never ids, request ids or paths: the
// workspace name, a fixed phrase, or an error message that orchard-cli has already stripped.
// The tones map to the theme's own colours (the band is Text-only), so it follows light/dark.
import type { OrchardCounts, OrchardStatus, OrchardWorkspace } from '../types'
import { plain } from './config'

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

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
const SHORT_NAME = 24

const line = (segments: BandSegment[], tone: BandLine['tone']): BandLine => ({ text: segments.map(s => s.text).join(''), segments, tone })
const head: BandSegment[] = [
  { text: '◆ ', tone: 'mark' },
  { text: 'orchard', tone: 'plain' },
]
const dim = (text: string): BandSegment => ({ text, tone: 'dim' })

/** The workspace name cut to fit a band; empty when it has none. */
export function shortName(workspace: OrchardWorkspace | null): string {
  const name = plain(workspace?.name ?? '', 60)
  return name.length > SHORT_NAME ? `${name.slice(0, SHORT_NAME - 1)}…` : name
}

export function bandLine(
  status: OrchardStatus | null,
  workspace: OrchardWorkspace | null,
  counts: OrchardCounts,
): BandLine | null {
  if (status === null) return null

  switch (status.kind) {
    case 'connecting':
      return line([...head, dim(' · connecting…')], 'quiet')
    case 'offline':
      return line([...head, { text: ' · ○ offline', tone: 'warn' }], 'warning')
    case 'error':
      return line([...head, { text: ` · error: ${plain(status.message, 120)}`, tone: 'err' }], 'error')
    case 'shared':
      return line([...head, dim(' · another session is listening')], 'quiet')
    case 'connected': {
      const unread = count(counts.unread)
      const forYou = count(counts.forYou)
      const needsYou = count(counts.needsYou)
      const isStoreFailing = status.isStoreFailing === true
      const name = shortName(workspace)
      const segments: BandSegment[] = [...head]
      if (unread === 0 && forYou === 0 && needsYou === 0 && !isStoreFailing) {
        if (name !== '') segments.push(dim(` · ${name}`))
        segments.push(dim(' · '), { text: '● listening', tone: 'ok' })
        return line(segments, 'quiet')
      }
      if (unread > 0) {
        segments.push(dim(' · '), { text: `${unread} new`, tone: 'plain' })
        if (forYou > 0) segments.push(dim(' · '), { text: `${forYou} for you`, tone: 'plain' })
      } else if (name !== '') {
        segments.push(dim(` · ${name}`))
      }
      if (needsYou > 0) segments.push(dim(' · '), { text: `needs you ${needsYou}`, tone: 'warn' })
      if (counts.isHeld === true && unread > 0) segments.push(dim(' · sends when box is empty'))
      if (isStoreFailing) segments.push({ text: ' · could not save its place (store write failed)', tone: 'warn' })
      return line(segments, isStoreFailing ? 'warning' : 'quiet')
    }
  }
}
