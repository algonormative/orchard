// Options and the per-project override.
//
// endpoint and credentialFile come from userConfig ALONE. A `.orchard.json` in the
// working directory can override participantId and name and nothing else, because the
// model can write files in the working directory and must not be able to point the
// mod at another workspace, another credential file or another executable.
import type { PluginOptions } from 'claude-code'

import { DEFAULT_BIN } from './orchard-cli'
import type { Conn } from './orchard-cli'

export const PROJECT_FILE = '.orchard.json'

/** The workspace owner and its system participant: a project file may not become either. */
export const RESERVED_IDS = ['owner', 'orchard']

const ID = /^[A-Za-z0-9._-]{1,128}$/
const MAX_NAME = 80

export type Options = {
  bin: string
  endpoint: string
  credentialFile: string
  participantId: string
  name: string
}

export type Identity = { participantId: string; name: string }

/** What a participantId in a `.orchard.json` must start with: it cannot name a human participant. */
export const PROJECT_ID_PREFIX = 'claude-'

/** What a `.orchard.json` may override. Anything else in the file is ignored. */
export type ProjectOverrides = {
  participantId?: string
  name?: string
  /** True when the file named a participantId that does not start with `claude-` and it was left out. */
  isIdIgnored?: true
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const fail = (message: string): Parsed<never> => ({ ok: false, message })

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readOptions(options: PluginOptions): Options {
  return {
    bin: text(options.orchardBin) || DEFAULT_BIN,
    endpoint: text(options.endpoint),
    credentialFile: text(options.credentialFile),
    participantId: text(options.participantId),
    name: text(options.name),
  }
}

/** The connection, or why it cannot be made. The message never holds the path. */
export function checkConn(options: Options): Parsed<Conn> {
  if (options.credentialFile === '') return fail('credentialFile is not set')
  if (!options.credentialFile.startsWith('/')) return fail('credentialFile must be an absolute path')
  return ok({ bin: options.bin, endpoint: options.endpoint, credentialFile: options.credentialFile })
}

export function parseProjectFile(source: string): Parsed<ProjectOverrides> {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return fail(`${PROJECT_FILE} is not valid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(`${PROJECT_FILE} must be a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const out: ProjectOverrides = {}

  for (const key of ['participantId', 'name'] as const) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return fail(`${PROJECT_FILE}: ${key} must be a string`)
    if (value.trim() !== '') out[key] = value.trim()
  }

  if (out.participantId !== undefined) {
    if (!ID.test(out.participantId)) {
      return fail(`${PROJECT_FILE}: participantId must be 1-128 letters, digits, . _ -`)
    }
    if (RESERVED_IDS.includes(out.participantId.toLowerCase())) {
      return fail(`${PROJECT_FILE}: that participantId is reserved`)
    }
    // The model can write this file: it must not be able to speak as a human participant.
    if (!out.participantId.startsWith(PROJECT_ID_PREFIX)) {
      delete out.participantId
      out.isIdIgnored = true
    }
  }
  return ok(out)
}

/** The last segment of a directory path. */
export function baseName(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function defaultParticipantId(cwd: string): string {
  const slug = baseName(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
  return slug === '' ? 'claude-session' : `claude-${slug}`
}

/** One printable line: control characters out, spaces collapsed, cut to `max`. */
export function plain(value: string, max = MAX_NAME): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function defaultName(cwd: string): string {
  const base = plain(baseName(cwd), 60)
  return base === '' ? 'Claude' : `Claude (${base})`
}

/** Project file over option over default. */
export function resolveIdentity(options: Options, cwd: string, project: ProjectOverrides): Parsed<Identity> {
  const participantId = project.participantId ?? (options.participantId || defaultParticipantId(cwd))
  if (!ID.test(participantId)) return fail('participantId must be 1-128 letters, digits, . _ -')
  const name = plain(project.name ?? (options.name || defaultName(cwd)))
  return ok({ participantId, name: name === '' ? 'Claude' : name })
}
