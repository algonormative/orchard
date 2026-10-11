// The only module that runs the Orchard agent CLI. Every later piece (the alert
// listener, the model tools, the pane) goes through runOrchard so the rules live
// in one place:
//
//   - the endpoint and the credential FILE PATH travel in the child's environment
//     (ORCHARD_AGENT_ENDPOINT, ORCHARD_AGENT_CREDENTIAL_FILE), never in argv, and the
//     file itself is never read here: the CLI does that;
//   - every run has an explicit timeoutMs;
//   - a run that rejects (timeout, cannot start) comes back as exit 3, the same as
//     the CLI's own connection failure, with `rejected: true`;
//   - stderr never leaves this module raw: a failure carries `message`, with the
//     credential path, the endpoint, request ids, other ids and file paths stripped.
//
// This module never touches `$`. `claude plugin validate` follows `$` only into
// functions declared in the hooks module's own file, never across an import, so the
// wrapper takes a `Run` port instead: register.tsx hands it
// `(argv, init) => $.process.run(argv, init)`, which keeps the `$.process.run` call
// spelled where the validator can see it. Later pieces do the same.
//
// Exit codes (docs/agent-cli.md in orchard-workspace): 0 ok, 2 usage or a local
// precondition failed, 3 connection or timeout, 4 the workspace tool reported an error.
import type { ProcessRunInit, ProcessRunResult } from 'claude-code'

/** `$.process.run`, as a function the caller supplies. */
export type Run = (argv: readonly string[], init: ProcessRunInit) => Promise<ProcessRunResult>

export const DEFAULT_BIN = '/Applications/Orchard.app/Contents/MacOS/Orchard'

/**
 * The CLI bounds itself at about 36 s (15 s to connect, 15 s for the call, 6 s to
 * close); this leaves it room to answer before the host kills it.
 */
export const CLI_TIMEOUT_MS = 45_000

export const EXIT_OK = 0
export const EXIT_USAGE = 2
export const EXIT_CONNECTION = 3
export const EXIT_TOOL = 4

export type Conn = {
  /** The Orchard executable; its `agent` command is run. */
  bin: string
  /** Loopback workspace MCP URL. */
  endpoint: string
  /** Absolute path of the credential file. Only ever placed in the child's env. */
  credentialFile: string
}

/**
 * What a run came to. Switch on `exitCode`: a rejected run (timeout, cannot start) is
 * reported as 3 with `rejected: true`, so "exit 3 or rejected" is one case.
 */
export type CliResult = {
  exitCode: number
  /** The parsed stdout of an exit 0, when it was JSON. */
  json?: unknown
  /** True when `$.process.run` rejected instead of returning an exit code. */
  rejected?: true
  /**
   * Exits 2, 4 and unexpected codes only: a short, safe description. Never raw stderr.
   */
  message?: string
}

export type CliInit = {
  /** Text written to the child's stdin (for `call TOOL stdin`). */
  stdin?: string
  /** Defaults to CLI_TIMEOUT_MS. Longer waits (alerts --wait N) pass (N + 15) * 1000 or more. */
  timeoutMs?: number
  /** Further literals to strip from any message (a participant id, a request id). */
  scrub?: readonly (string | undefined)[]
}

export async function runOrchard(
  run: Run,
  conn: Conn,
  args: readonly string[],
  init: CliInit = {},
): Promise<CliResult> {
  let ran
  try {
    ran = await run([conn.bin, 'agent', ...args], {
      env: {
        ORCHARD_AGENT_ENDPOINT: conn.endpoint,
        ORCHARD_AGENT_CREDENTIAL_FILE: conn.credentialFile,
      },
      stdin: init.stdin,
      timeoutMs: init.timeoutMs ?? CLI_TIMEOUT_MS,
    })
  } catch {
    // The error's own text is dropped: it may name the argv or the environment.
    return { exitCode: EXIT_CONNECTION, rejected: true }
  }

  if (ran.exitCode === EXIT_OK) {
    return { exitCode: EXIT_OK, json: parseJson(ran.stdout) }
  }
  if (ran.exitCode === EXIT_CONNECTION) {
    return { exitCode: EXIT_CONNECTION }
  }
  if (ran.exitCode === EXIT_USAGE || ran.exitCode === EXIT_TOOL) {
    const message = sanitizeMessage(ran.stderr, [
      conn.credentialFile,
      conn.endpoint,
      workspaceIdOf(conn.endpoint),
      ...(init.scrub ?? []),
    ])
    return { exitCode: ran.exitCode, message }
  }
  return { exitCode: ran.exitCode, message: `the Orchard CLI exited with code ${ran.exitCode}` }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The workspace id in `http://127.0.0.1:PORT/workspaces/<id>/mcp`, or undefined. */
export function workspaceIdOf(endpoint: string): string | undefined {
  const match = /\/workspaces\/([^/?#]+)/.exec(endpoint)
  return match?.[1]
}

const MAX_MESSAGE = 100

/**
 * Turns the CLI's stderr into a line safe for the band: the credential path,
 * the endpoint, request ids, other ids and file paths removed, the JSON detail the
 * CLI wraps tool errors in unwrapped, cut to one short line. Never returns raw stderr.
 */
export function sanitizeMessage(raw: string, scrub: readonly (string | undefined)[] = []): string {
  let text = raw.trim()

  // "Orchard agent: MCP tool "mail_send" returned an error: {"error":"..."}"
  text = text.replace(/^Orchard agent:\s*/, '')
  const wrapped = /returned an error:\s*([\s\S]*)$/.exec(text)
  if (wrapped?.[1] !== undefined) {
    text = unwrapDetail(wrapped[1])
  }

  for (const secret of [...scrub].filter((s): s is string => !!s && s.length > 0).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join(' ')
  }

  text = text.replace(/https?:\/\/\S+/g, ' ')
  // Absolute, home-relative or dot-relative paths: after whitespace, a quote or a separator.
  text = text.replace(/(^|[\s"'(=:,])(?:~|\.{1,2})?\/[^\s"'),;}\]]*/g, '$1<path>')
  // A path with a space in it ("Application Support") continues into the next tokens that
  // still contain a separator; any other token with a separator is a path too.
  text = text.replace(/<path>(?:\s+[^\s<>]*\/[^\s<>]*)+/g, '<path>')
  text = text.replace(/[^\s<>]*\/[^\s<>]*/g, '<path>')
  text = text.replace(/(?:<path>\s*){2,}/g, '<path> ')
  // Anything that looks like an id: a long token with a digit in it (ws_0123…, m_0000…, join-9f2c…, uuids).
  text = text.replace(/[A-Za-z0-9][A-Za-z0-9._-]{7,}/g, token => {
    if (!/\d/.test(token)) return token
    const tail = /[._-]*$/.exec(token)?.[0] ?? ''
    return `<id>${tail}`
  })

  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text === '') return 'the workspace reported an error'
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text
}

/** The CLI prints the tool error as JSON: a string, {error|message}, or a content list of {text}. */
function unwrapDetail(detail: string): string {
  const trimmed = detail.trim()
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return trimmed
  }
  const found = firstText(value, 0)
  return found ?? trimmed
}

function firstText(value: unknown, depth: number): string | undefined {
  if (depth > 3) return undefined
  if (typeof value === 'string') {
    // A content text can itself be JSON.
    try {
      return firstText(JSON.parse(value), depth + 1) ?? value
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['error', 'message', 'text']) {
      const found = firstText(record[key], depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

// The three calls the connection needs. Later pieces add theirs beside these.

export function resume(run: Run, conn: Conn, participantId: string, scrub?: CliInit['scrub']) {
  return runOrchard(run, conn, ['resume', '--participant-id', participantId], { scrub })
}

/** `requestId` must be reused when retrying a join that ended in exit 3 (the CLI never retries a mutation itself). */
export function join(
  run: Run,
  conn: Conn,
  participantId: string,
  name: string,
  requestId: string,
  scrub?: CliInit['scrub'],
) {
  return runOrchard(run, conn, ['join', '--participant-id', participantId, '--name', name, '--request-id', requestId], {
    scrub: [requestId, ...(scrub ?? [])],
  })
}

/** `workspace_info` has no arguments; `call TOOL stdin` reads them as JSON from stdin. */
export function workspaceInfo(run: Run, conn: Conn, scrub?: CliInit['scrub']) {
  return runOrchard(run, conn, ['call', 'workspace_info', 'stdin'], { stdin: '{}', scrub })
}
