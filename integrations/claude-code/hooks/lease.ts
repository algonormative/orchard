// Two things kept in `$.store` beside the per-(endpoint, participant) records: the in-flight
// claims that keep two module instances of one session from delivering the same alert twice, and
// the recency index that keeps the store from growing a record for every session ever started.
// (There is no lease: every session has a handle of its own, so none contends for one.)
// Pure functions, no `$`.
import { storeKey } from './alerts'
import { participationKey, settingsKey } from './classify'

/** Records (endpoint, participant) kept in the store; the least recently used go past this. */
export const MAX_RECORDS = 50
/** Where the recency index lives. */
export const RECENT_KEY = 'recent records'

/** A delivery that has not resolved is claimed this long; a claim older than that was left by a dead instance. */
export const CLAIM_TTL_MS = 10 * 60_000
/** How soon a session looks again when what is pending sits in another instance's delivery. */
export const CLAIM_RECHECK_MS = 15_000

/** Where earlier versions kept a lease. Nothing reads it any more; it is only so eviction forgets it with its record. */
export const legacyLeaseKey = (endpoint: string, participantId: string): string => `lease ${endpoint} ${participantId}`

/** One module instance's delivery that has not resolved: the alert ids it handed to the prompt queue. */
export type Claim = { owner: string; at: number; ids: string[] }

export const inflightKey = (endpoint: string, participantId: string): string => `inflight ${endpoint} ${participantId}`

export function parseClaims(value: unknown): Claim[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const { owner, at, ids } = (item ?? {}) as Partial<Claim>
    return typeof owner === 'string' && typeof at === 'number' && Number.isFinite(at) && Array.isArray(ids)
      ? [{ owner, at, ids: ids.filter((id): id is string => typeof id === 'string') }]
      : []
  })
}

export const liveClaims = (claims: readonly Claim[], now: number): Claim[] => claims.filter(c => Math.abs(now - c.at) < CLAIM_TTL_MS)

/** The claims with `ids` taken out of `owner`'s, an emptied claim dropped. */
export function withoutIds(claims: readonly Claim[], owner: string, ids: readonly string[]): Claim[] {
  const gone = new Set(ids)
  return claims.flatMap(c => {
    if (c.owner !== owner) return [c]
    const left = c.ids.filter(id => !gone.has(id))
    return left.length === 0 ? [] : [{ ...c, ids: left }]
  })
}

export type RecordRef = { endpoint: string; participantId: string }
type Recent = RecordRef & { at: number }

/** The keys one record keeps. */
export const recordKeys = (endpoint: string, participantId: string): string[] => [
  storeKey(endpoint, participantId),
  settingsKey(endpoint, participantId),
  participationKey(endpoint, participantId),
  legacyLeaseKey(endpoint, participantId),
  inflightKey(endpoint, participantId),
]

const PREFIXES = ['inbox ', 'settings ', 'participation ', 'lease ', 'inflight ']

function refOfKey(key: string): RecordRef | undefined {
  const prefix = PREFIXES.find(p => key.startsWith(p))
  if (prefix === undefined) return undefined
  const rest = key.slice(prefix.length)
  const at = rest.lastIndexOf(' ')
  return at <= 0 ? undefined : { endpoint: rest.slice(0, at), participantId: rest.slice(at + 1) }
}

export function parseRecent(value: unknown): Recent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const { endpoint, participantId, at } = (item ?? {}) as Partial<Recent>
    return typeof endpoint === 'string' && typeof participantId === 'string' && typeof at === 'number' ? [{ endpoint, participantId, at }] : []
  })
}

/**
 * Marks `current` (one record, or several: a session's handle and its base) used now and picks the records past `max` to forget, least recently used first
 * out. A record the index does not know (written before it existed) counts as oldest, the later
 * key of two such as the newer.
 */
export function planEviction(keys: readonly string[], recent: readonly Recent[], current: RecordRef | readonly RecordRef[], now: number, max = MAX_RECORDS) {
  const id = (r: RecordRef) => `${r.endpoint} ${r.participantId}`
  const seen = new Map<string, { ref: RecordRef; at: number; order: number }>()
  const known = new Map(recent.map(r => [id(r), r.at]))
  keys.forEach((key, order) => {
    const ref = refOfKey(key)
    if (ref !== undefined && !seen.has(id(ref))) seen.set(id(ref), { ref, at: known.get(id(ref)) ?? 0, order })
  })
  const currents = new Set(([] as RecordRef[]).concat(current).map(id))
  ;([] as RecordRef[]).concat(current).forEach((ref, i) => seen.set(id(ref), { ref, at: now, order: keys.length + i }))
  const isCurrent = (r: { ref: RecordRef }) => currents.has(id(r.ref))
  const ranked = [...seen.values()].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)) || b.at - a.at || b.order - a.order)
  const kept = ranked.slice(0, max)
  const dropped = ranked.slice(max)
  const present = new Set(keys)
  return {
    index: kept.filter(r => r.at > 0).map(r => ({ ...r.ref, at: r.at })),
    evict: dropped.flatMap(r => recordKeys(r.ref.endpoint, r.ref.participantId)).filter(k => present.has(k)),
  }
}
