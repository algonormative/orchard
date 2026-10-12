// The drawn parts of the /orchard pane as SVG strings (Orchard x LEMON: ink, neon citron, leaf,
// cream; monospace labels, small ASCII motifs). Pure functions of plain data, no `$`.
//
// The colours are CSS variables on :root, redefined under `prefers-color-scheme: dark`; the
// desktop draws an Svg in the app's page, so the media query follows Claude's own light/dark
// theme. Svg cannot hold controls: everything clickable is built from Box/Text/Button/Select
// in pane.tsx, and these strings are only the decoration around it.
import type { OrchardPaneThread } from '../types'
import type { OrchardCounts, OrchardStatus } from '../types'
import { relativeTime } from './threads'

export const MIN_WIDTH = 300
export const MAX_WIDTH = 560
const DEFAULT_WIDTH = 440
const PX_PER_COLUMN = 8

/** The drawing width for a pane `columns` cells across (about 8 px a column, less a margin). */
export function widthOf(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return DEFAULT_WIDTH
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(columns) * PX_PER_COLUMN - 8))
}

const STYLE = `:root{--bg:#f8faef;--card:#e5ecca;--text:#070b08;--dim:#465349;--accent:#3f4a00;--leaf:#1d5c27;--leafbg:#cfe6cb;--rule:#b4c194;--chip:#ebf1d4;--chipline:#a9b88a;--grain:#dde5c3;--badge:#e6ff68;--onbadge:#0d140f;--peach:#ffcfad;--dot:#8aa000;--err:#8f1d1d;--errbg:#f6d3cf;--warn:#7a4a00;--warnbg:#f7e2b0}@media (prefers-color-scheme: dark){:root{--bg:#070c0a;--card:#18251d;--text:#f6fae8;--dim:#a5b5a7;--accent:#ecff7a;--leaf:#93f09b;--leafbg:#2c4a32;--rule:#3f5548;--chip:#1b281f;--chipline:#46604f;--grain:#1f2e25;--badge:#e6ff68;--onbadge:#090f0d;--peach:#ffcfad;--dot:#e6ff68;--err:#ff9d94;--errbg:#4a2220;--warn:#ffd37a;--warnbg:#4a3a14}}.mono{font-family:ui-monospace,'SF Mono',Menlo,monospace}.bg{fill:var(--bg)}.card{fill:var(--card)}.text{fill:var(--text)}.dim{fill:var(--dim)}.accent{fill:var(--accent)}.leaf{fill:var(--leaf)}.leafbg{fill:var(--leafbg)}.rule{fill:var(--rule)}.grain{fill:var(--grain)}.badge{fill:var(--badge)}.onbadge{fill:var(--onbadge)}.peach{fill:var(--peach)}.dot{fill:var(--dot)}.err{fill:var(--err)}.errbg{fill:var(--errbg)}.warn{fill:var(--warn)}.warnbg{fill:var(--warnbg)}.chip{fill:var(--chip);stroke:var(--chipline)}.outline{fill:none;stroke:var(--dim)}.sel{fill:none;stroke:var(--dot);stroke-width:2}.bar{fill:var(--dot)}`

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

export type ChipKind = 'listening' | 'waiting' | 'offline' | 'shared' | 'connecting' | 'error'
export type Chip = { kind: ChipKind; label: string }

/** green listening / amber waiting for you / red offline (or error) / grey another session is listening (or connecting). */
export function chipOf(status: OrchardStatus | null, counts: OrchardCounts | null): Chip {
  switch (status?.kind) {
    case 'connected':
      return (counts?.needsYou ?? 0) > 0 || counts?.isHeld === true ? { kind: 'waiting', label: 'waiting for you' } : { kind: 'listening', label: 'listening' }
    case 'offline':
      return { kind: 'offline', label: 'offline' }
    case 'error':
      return { kind: 'error', label: 'error' }
    case 'shared':
      return { kind: 'shared', label: 'another session is listening' }
    default:
      return { kind: 'connecting', label: 'connecting' }
  }
}

const CHIP_CLASS: Record<ChipKind, { bg: string; fg: string }> = {
  listening: { bg: 'leafbg', fg: 'leaf' },
  waiting: { bg: 'warnbg', fg: 'warn' },
  offline: { bg: 'errbg', fg: 'err' },
  error: { bg: 'errbg', fg: 'err' },
  shared: { bg: 'chip', fg: 'dim' },
  connecting: { bg: 'chip', fg: 'dim' },
}

// ---- header ----

export const HEADER_HEIGHT = 90

/** The pane is one Claude session's view of the workspace: its title says so, its subline says which session and where. */
export const PANE_TITLE = "Claude's view of Orchard"
export const sublineOf = (participantId: string, workspaceName: string) => `this session · as ${participantId} · ${workspaceName || 'workspace'}`

export function headerSvg(w: number, args: { workspaceName: string; participantId: string; chip: Chip }): string {
  const { bg, fg } = CHIP_CLASS[args.chip.kind]
  const label = esc(args.chip.label)
  const chipW = Math.ceil(args.chip.label.length * 6.4 + 36)
  const chipX = Math.max(18, w - 18 - chipW)
  const nameMax = Math.max(8, Math.floor((w - 56 - 18) / 8.6))
  const idMax = Math.max(6, Math.floor((w - 56 - 18) / 6.2))
  const pulse = args.chip.kind === 'listening' ? '<animate attributeName="opacity" values="1;.35;1" dur="2.4s" repeatCount="indefinite"/>' : ''
  const body =
    `<rect width="${w}" height="${HEADER_HEIGHT}" class="bg"/>` +
    `<text x="${w - 140}" y="30" class="mono grain" font-size="9">· . ✿ . · ˚ . ·</text>` +
    `<text x="${w - 110}" y="46" class="mono grain" font-size="9">˚ · . ✿ ·</text>` +
    `<g transform="translate(18,20)"><circle cx="14" cy="14" r="13" class="badge"/>` +
    `<ellipse cx="18" cy="5" rx="5" ry="3" fill="#81e78a" transform="rotate(-30 18 5)"/>` +
    `<text x="9" y="19" class="mono onbadge" font-size="12" font-weight="700">◕‿◕</text>` +
    `<text x="38" y="11" class="mono accent" font-size="10" letter-spacing="1.5">ORCHARD //</text>` +
    `<text x="38" y="27" class="text" font-size="15" font-weight="700">${esc(cut(PANE_TITLE, nameMax))}</text></g>` +
    `<text x="56" y="82" class="mono dim" font-size="10">${esc(cut(sublineOf(args.participantId, args.workspaceName), idMax))}</text>` +
    `<g transform="translate(${chipX},52)"><rect width="${chipW}" height="22" rx="11" class="${bg}"/>` +
    `<circle cx="14" cy="11" r="4" class="${fg}">${pulse}</circle>` +
    `<text x="25" y="15" class="mono ${fg}" font-size="10.5">${label}</text></g>`
  return svg(w, HEADER_HEIGHT, body)
}

// ---- section labels ----

export const SECTION_HEIGHT = 30

/** A rule and a small caps label, with an optional "N NEW" pill. */
export function sectionSvg(w: number, label: string, pill?: string): string {
  const pillW = pill === undefined ? 0 : Math.ceil(pill.length * 6 + 14)
  const pillX = 18 + label.length * 8.4 + 8
  const body =
    `<rect x="18" y="2" width="${w - 36}" height="1" class="rule"/>` +
    `<text x="18" y="22" class="mono accent" font-size="10" letter-spacing="1.5">${esc(label)}</text>` +
    (pill === undefined
      ? ''
      : `<g transform="translate(${pillX.toFixed(0)},11)"><rect width="${pillW}" height="15" rx="7.5" class="badge"/>` +
        `<text x="${pillW / 2}" y="11" class="mono onbadge" font-size="9" font-weight="700" text-anchor="middle">${esc(pill)}</text></g>`)
  return svg(w, SECTION_HEIGHT, body)
}

// ---- thread rows ----

export const UNREAD_ROW_HEIGHT = 58
export const READ_ROW_HEIGHT = 46

export function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(word => word !== '')
  if (words.length === 0) return '?'
  const first = [...(words[0] as string)][0] as string
  const second = words.length > 1 ? [...(words[1] as string)][0] : [...(words[0] as string)][1]
  return `${first}${second ?? ''}`.toUpperCase()
}

/** Badge classes: citron filled for DM and MENTION, leaf for OWNER, an outline for the rest. */
function badge(reason: string, x: number, y: number): string {
  const width = Math.ceil(reason.length * 5.8 + 14)
  const kind = reason === 'DM' || reason === 'MENTION' ? 'fill' : reason === 'OWNER' ? 'leaf' : 'outline'
  const rect = `<rect width="${width}" height="15" rx="4" class="${kind === 'fill' ? 'badge' : kind === 'leaf' ? 'leafbg' : 'outline'}"/>`
  const text = `<text x="${width / 2}" y="11" class="mono ${kind === 'fill' ? 'onbadge' : kind === 'leaf' ? 'leaf' : 'dim'}" font-size="9"${kind === 'fill' ? ' font-weight="700"' : ''} text-anchor="middle">${esc(reason)}</text>`
  return `<g transform="translate(${x.toFixed(0)},${y})">${rect}${text}</g>`
}

export function rowHeight(thread: OrchardPaneThread): number {
  return thread.isUnread ? UNREAD_ROW_HEIGHT : READ_ROW_HEIGHT
}

/** How wide the drawn mark of a row is: an edge bar and the avatar. The words beside it are a Markdown link. */
export const MARK_WIDTH = 52

/**
 * The small drawing at the left of a thread row: an avatar, a citron edge bar when the thread is
 * unread, and a thicker outlined bar plus ring when it is selected. Svg cannot take a press, so the
 * words of the row (sender, badge, age, preview) are a Markdown link beside it (pane.tsx).
 */
export function rowMarkSvg(thread: OrchardPaneThread, selected = false): string {
  const h = rowHeight(thread)
  const mid = (h - 4) / 2
  const avatar = thread.last.isOwner ? 'badge' : 'peach'
  const r = thread.isUnread ? 15 : 13
  const body =
    `<g${thread.isUnread ? '' : ' opacity=".8"'}>` +
    (thread.isUnread ? `<rect x="2" y="8" width="3" height="${h - 20}" rx="1.5" class="dot"/>` : '') +
    (selected ? `<rect x="0" y="4" width="5" height="${h - 12}" rx="2.5" class="bar"/><circle cx="30" cy="${mid}" r="${r + 3}" class="sel"/>` : '') +
    `<circle cx="30" cy="${mid}" r="${r}" class="${avatar}"/>` +
    `<text x="30" y="${mid + 4.5}" class="mono onbadge" font-size="${thread.isUnread ? 12 : 11}" font-weight="700" text-anchor="middle">${esc(initialsOf(thread.last.senderName))}</text>` +
    '</g>'
  return svg(MARK_WIDTH, h, body)
}

/** Backslash-escapes what Markdown would read as markup, so a name or a preview stays plain text inside a link. */
export function mdEscape(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+!|~&]/g, ch => `\\${ch}`)
}

/** The row's words as one Markdown link: `[**Sender** · DM · 2m — preview](href)`. `mark` leads it where no drawing does. */
export function rowLinkText(thread: OrchardPaneThread, nowMs: number, href: string, mark = ''): string {
  const { last } = thread
  const age = relativeTime(last.sentAt, nowMs) + (thread.size > 1 ? ` · ${thread.size}` : '')
  return `[${mark}**${mdEscape(cut(last.senderName, 22))}** · ${thread.reason} · ${age} — ${mdEscape(cut(last.snippet, 80))}](${href})`
}

// ---- footer ----

export const FOOTER_HEIGHT = 28

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

export function footerSvg(w: number, text: string): string {
  return svg(w, FOOTER_HEIGHT, `<text x="${w / 2}" y="18" class="mono dim" font-size="9.5" text-anchor="middle">${esc(text)}</text>`)
}
