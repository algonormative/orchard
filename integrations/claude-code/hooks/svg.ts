// The drawn parts of the /orchard pane as SVG strings (Orchard x LEMON: ink, neon citron, leaf,
// cream; monospace labels, small ASCII motifs). Pure functions of plain data, no `$`.
//
// The colours are CSS variables on :root, redefined under `prefers-color-scheme: dark`; the
// desktop draws an Svg in the app's page, so the media query follows Claude's own light/dark
// theme. Svg cannot hold controls: everything clickable is built from Box/Text/Button
// in pane.tsx, and these strings are only the decoration around it.
import type { OrchardCounts, OrchardStatus } from '../types'

export const MIN_WIDTH = 300
export const MAX_WIDTH = 560
const DEFAULT_WIDTH = 440
const PX_PER_COLUMN = 8

/** The drawing width for a pane `columns` cells across (about 8 px a column, less a margin). */
export function widthOf(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns) * PX_PER_COLUMN - 8))
}

const STYLE = `:root{--bg:#f8faef;--card:#e5ecca;--text:#070b08;--dim:#465349;--accent:#3f4a00;--leaf:#1d5c27;--leafbg:#cfe6cb;--rule:#b4c194;--chip:#ebf1d4;--chipline:#a9b88a;--grain:#dde5c3;--badge:#e6ff68;--onbadge:#0d140f;--peach:#ffcfad;--dot:#8aa000;--err:#8f1d1d;--errbg:#f6d3cf;--warn:#7a4a00;--warnbg:#f7e2b0;--red:#b3261e;--onred:#ffffff}@media (prefers-color-scheme: dark){:root{--bg:#070c0a;--card:#18251d;--text:#f6fae8;--dim:#a5b5a7;--accent:#ecff7a;--leaf:#93f09b;--leafbg:#2c4a32;--rule:#3f5548;--chip:#1b281f;--chipline:#46604f;--grain:#1f2e25;--badge:#e6ff68;--onbadge:#090f0d;--peach:#ffcfad;--dot:#e6ff68;--err:#ff9d94;--errbg:#4a2220;--warn:#ffd37a;--warnbg:#4a3a14;--red:#ff6b5e;--onred:#1a0605}}.mono{font-family:ui-monospace,'SF Mono',Menlo,monospace}.bg{fill:var(--bg)}.card{fill:var(--card)}.text{fill:var(--text)}.dim{fill:var(--dim)}.accent{fill:var(--accent)}.leaf{fill:var(--leaf)}.leafbg{fill:var(--leafbg)}.rule{fill:var(--rule)}.grain{fill:var(--grain)}.badge{fill:var(--badge)}.onbadge{fill:var(--onbadge)}.peach{fill:var(--peach)}.dot{fill:var(--dot)}.err{fill:var(--err)}.errbg{fill:var(--errbg)}.warn{fill:var(--warn)}.warnbg{fill:var(--warnbg)}.red{fill:var(--red)}.onred{fill:var(--onred)}.chip{fill:var(--chip);stroke:var(--chipline)}.outline{fill:none;stroke:var(--dim)}.sel{fill:none;stroke:var(--dot);stroke-width:2}.bar{fill:var(--dot)}`

/** Escapes text for XML after dropping control characters. */
export function esc(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Cut to `max` characters, with an ellipsis. */
export function cut(value: string, max: number): string {
  const chars = [...value]
  if (max < 1) return ''
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : value
}

function svg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `font-family="-apple-system, 'SF Pro Text', Helvetica, sans-serif"><defs><style>${STYLE}</style></defs>${body}</svg>`
  )
}

// ---- the status chip ----

export type ChipKind = 'listening' | 'working' | 'waiting' | 'offline' | 'connecting' | 'error' | 'disconnected' | 'signed-off'
export type Chip = { kind: ChipKind; label: string }

/** green listening or working / amber waiting for you / red offline (or error) / grey another session is listening, disconnected, signed off, or connecting. `isBusy`: a message is being handled or a subagent runs. */
export function chipOf(status: OrchardStatus | null, counts: OrchardCounts | null, isBusy = false): Chip {
  switch (status?.kind) {
    case 'connected':
      if ((counts?.needsYou ?? 0) > 0 || counts?.isHeld === true) return { kind: 'waiting', label: 'waiting for you' }
      return isBusy ? { kind: 'working', label: 'working' } : { kind: 'listening', label: 'listening' }
    case 'offline':
      return { kind: 'offline', label: 'offline' }
    case 'error':
      return { kind: 'error', label: 'error' }
    case 'disconnected':
      return { kind: 'disconnected', label: 'disconnected' }
    case 'signed-off':
      return { kind: 'signed-off', label: 'signed off' }
    default:
      return { kind: 'connecting', label: 'connecting' }
  }
}

const CHIP_CLASS: Record<ChipKind, { bg: string; fg: string }> = {
  listening: { bg: 'leafbg', fg: 'leaf' },
  working: { bg: 'leafbg', fg: 'leaf' },
  waiting: { bg: 'warnbg', fg: 'warn' },
  offline: { bg: 'errbg', fg: 'err' },
  error: { bg: 'errbg', fg: 'err' },
  connecting: { bg: 'chip', fg: 'dim' },
  disconnected: { bg: 'chip', fg: 'dim' },
  'signed-off': { bg: 'chip', fg: 'dim' },
}

// ---- header ----
// The drawings have no margin of their own: pane.tsx pads the whole body with one gutter, so the
// mascot, the labels, the rules and the buttons around them all start at the same edge.

/** With the handle line and the chip, or only the title (the quiet view and the disconnect question say the rest in Text). */
export const HEADER_HEIGHT = 90
export const HEADER_HEIGHT_SHORT = 56

/** The pane is one Claude session's view of the workspace: its title says so, its subline says which session and where. */
export const PANE_TITLE = "Claude's view of Orchard"
export const sublineOf = (participantId: string) => `as ${participantId}`

export type HeaderArgs = {
  workspaceName: string
  participantId: string
  /** Absent: the short header, title only. */
  chip?: Chip
  /** `confirm`: the sleepy red mascot and "DISCONNECT?" (the Box around it is red too). */
  mood?: 'normal' | 'confirm'
}

export const headerHeight = (args: Pick<HeaderArgs, 'chip'>) => (args.chip === undefined ? HEADER_HEIGHT_SHORT : HEADER_HEIGHT)

export function headerSvg(w: number, args: HeaderArgs): string {
  const isConfirm = args.mood === 'confirm'
  const height = headerHeight(args)
  const nameMax = Math.max(8, Math.floor((w - 38) / 8.6))
  const idMax = Math.max(6, Math.floor((w - 38) / 6.2))
  const mascot = isConfirm
    ? `<circle cx="14" cy="14" r="13" class="red"/><text x="7" y="19" class="mono onred" font-size="12" font-weight="700">ᴗ﹏ᴗ</text>`
    : `<circle cx="14" cy="14" r="13" class="badge"/><ellipse cx="18" cy="5" rx="5" ry="3" fill="#81e78a" transform="rotate(-30 18 5)"/>` +
      `<text x="9" y="19" class="mono onbadge" font-size="12" font-weight="700">◕‿◕</text>`
  const label = isConfirm ? 'ORCHARD // DISCONNECT?' : "ORCHARD // CLAUDE'S VIEW"
  let body =
    `<g transform="translate(0,${isConfirm ? 12 : 20})">${mascot}` +
    `<text x="38" y="11" class="mono ${isConfirm ? 'red' : 'accent'}" font-size="10" letter-spacing="1.5">${esc(label)}</text>` +
    `<text x="38" y="27" class="text" font-size="15" font-weight="700">${esc(cut(args.workspaceName || 'Orchard', nameMax))}</text></g>`
  if (args.chip !== undefined) {
    const { bg, fg } = CHIP_CLASS[args.chip.kind]
    const chipW = Math.ceil(args.chip.label.length * 6.4 + 36)
    const chipX = Math.max(0, w - chipW)
    body +=
      `<text x="38" y="82" class="mono dim" font-size="10">${esc(cut(sublineOf(args.participantId), idMax))}</text>` +
      `<g transform="translate(${chipX},52)"><rect width="${chipW}" height="22" rx="11" class="${bg}"/>` +
      `<circle cx="14" cy="11" r="4" class="${fg}"/>` +
      `<text x="25" y="15" class="mono ${fg}" font-size="10.5">${esc(args.chip.label)}</text></g>`
  }
  return svg(w, height, body)
}

// ---- section labels ----

export const SECTION_HEIGHT = 30

/** A rule and a small caps label, with an optional "N NEW" pill. */
export function sectionSvg(w: number, label: string, pill?: string): string {
  const pillW = pill === undefined ? 0 : Math.ceil(pill.length * 6 + 14)
  const pillX = label.length * 8.4 + 8
  const body =
    `<rect x="0" y="2" width="${w}" height="1" class="rule"/>` +
    `<text x="0" y="22" class="mono accent" font-size="10" letter-spacing="1.5">${esc(label)}</text>` +
    (pill === undefined
      ? ''
      : `<g transform="translate(${pillX.toFixed(0)},11)"><rect width="${pillW}" height="15" rx="7.5" class="badge"/>` +
        `<text x="${pillW / 2}" y="11" class="mono onbadge" font-size="9" font-weight="700" text-anchor="middle">${esc(pill)}</text></g>`)
  return svg(w, SECTION_HEIGHT, body)
}

// ---- footer ----

/** "last poll 4s ago", or nothing before the first poll. */
export function pollAge(lastPollAt: number | null | undefined, nowMs: number): string | null {
  if (lastPollAt === null || lastPollAt === undefined || !Number.isFinite(lastPollAt) || !Number.isFinite(nowMs)) return null
  const s = Math.max(0, Math.floor((nowMs - lastPollAt) / 1000))
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`
}

export function footerText(lastPollAt: number | null | undefined, nowMs: number): string {
  const age = pollAge(lastPollAt, nowMs)
  return `~ ✿ tending the grove${age === null ? '' : ` · last poll ${age}`} ✿ ~`
}
