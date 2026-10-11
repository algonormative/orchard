// The connection flow without `$`: one attempt (resume, join if the participant is
// unknown, then read the workspace), the backoff schedule, and the bookkeeping the
// retry loop in register.tsx shares. Timers, state and the file system are `$` and
// live in register.tsx; see orchard-cli.ts for why.
import type { OrchardWorkspace } from '../types'
import type { Identity } from './config'
import { EXIT_CONNECTION, EXIT_OK, EXIT_TOOL, join, resume, workspaceInfo } from './orchard-cli'
import type { CliResult, Conn, Run } from './orchard-cli'

export const BACKOFF_FIRST_MS = 5_000
export const BACKOFF_MAX_MS = 300_000

/** Delay before retry number `failures` (1-based): 5 s, 10 s, 20 s … capped at 5 min. */
export function backoffDelay(failures: number): number {
  const n = Math.max(1, Math.floor(failures))
  return Math.min(BACKOFF_FIRST_MS * 2 ** (n - 1), BACKOFF_MAX_MS)
}

/** What `resume` says when the participant was never registered (MailError::NotFound in orchard-mail). */
const NOT_REGISTERED = /not found|unknown participant|not registered/i

/** What a session is connected as, once session.start has resolved it. */
export type Current = { conn: Conn; identity: Identity }

/**
 * The connection's bookkeeping, made once in register(). Every piece that retries or
 * calls the CLI shares this one object.
 */
export type Runtime = {
  current: Current | undefined
  /** The pending retry; anything with a `cancel()`. */
  timer: { cancel: () => void } | undefined
  isAttempting: boolean
  /** Consecutive failed attempts since the last exit 0. */
  failures: number
  /** Kept across attempts so a join that ended in exit 3 is retried with the same id. */
  joinRequestId: string | undefined
}

export function createRuntime(): Runtime {
  return { current: undefined, timer: undefined, isAttempting: false, failures: 0, joinRequestId: undefined }
}

export type Outcome =
  | { kind: 'connected'; workspace: OrchardWorkspace }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

/** Any exit 0 resets the backoff to its first step. Pass every CLI result through this. */
export function track(rt: Runtime, result: CliResult): CliResult {
  if (result.exitCode === EXIT_OK) rt.failures = 0
  return result
}

function failed(result: CliResult): Outcome {
  if (result.exitCode === EXIT_CONNECTION) return { kind: 'offline' }
  return { kind: 'error', message: result.message ?? 'the Orchard CLI failed' }
}

export async function connectOnce(run: Run, rt: Runtime, here: Current): Promise<Outcome> {
  const { conn, identity } = here
  const scrub = [identity.participantId]

  let first = track(rt, await resume(run, conn, identity.participantId, scrub))
  if (first.exitCode === EXIT_TOOL && NOT_REGISTERED.test(first.message ?? '')) {
    rt.joinRequestId ??= `orchard-join-${crypto.randomUUID()}`
    first = track(rt, await join(run, conn, identity.participantId, identity.name, rt.joinRequestId, scrub))
    if (first.exitCode === EXIT_OK) rt.joinRequestId = undefined
  }
  if (first.exitCode !== EXIT_OK) return failed(first)

  const info = track(rt, await workspaceInfo(run, conn, scrub))
  if (info.exitCode !== EXIT_OK) return failed(info)
  return { kind: 'connected', workspace: parseWorkspace(info.json) }
}

/** `workspace_info` → { workspace: { name }, owner_participant_id }. Missing fields stay null. */
export function parseWorkspace(json: unknown): OrchardWorkspace {
  const record = (json !== null && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const inner = record.workspace
  const name = inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>).name : undefined
  const owner = record.owner_participant_id
  return {
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null,
    ownerId: typeof owner === 'string' && owner !== '' ? owner : null,
  }
}
