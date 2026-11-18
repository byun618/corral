// LIFE-813: the registered setup command of a repo, run once in a worktree.
//
// - The command comes from one place only: the repo's `setupCommand` in repos.json, written by
//   `corral repo set-setup-command`. Nothing inside the repository (orca.yaml, conductor.json, .corral/)
//   is read here, so a repository's content never becomes a command (D1·D7).
// - It runs as a child process group, not in a pane: cwd is the worktree, stdin is closed, stdout and
//   stderr go to one log file under userData, and the caller waits for it before any later stage (D4).
// - PATH comes from the user's login shell (`$SHELL -ilc`, the agent-detection probe), because an app
//   started from Finder has the launchd PATH and would not find npm (D5). If the probe fails the
//   runtime's own PATH is used and the receipt says so.
// - It runs inside the request budget. Past it the whole process group is killed and the worktree is
//   left as it is (D3·D6). A cancelled request or a closing runtime kills the group at once, without
//   a timer, so an app that exits right after closing its runtime leaves no setup process behind.
// - The login shell probe gets at most a third of the budget (and 5 s): a hanging rc file costs that
//   share and the command still starts with the runtime PATH.
// - What it cannot reach: a child that left the group (`setsid`) and background children still
//   running after the command exited normally.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { probeLoginShellPath } from '../../main/agent-detection.js'
import { RuntimeError } from '../contracts.js'

export const SETUP_COMMAND_MAX = 4096
export type SetupPolicy = 'inherit' | 'skip' | 'run'
export const SETUP_POLICIES: SetupPolicy[] = ['inherit', 'skip', 'run']
/** Kept back from the request budget so a timed-out setup is still reported before the request itself expires. */
const RESERVE_MS = 1000
const PROBE_TIMEOUT_MS = 5_000
const TERM_GRACE_MS = 300

export type SetupRun = {
  status: 'completed' | 'failed' | 'timed_out'
  command: string
  exitCode: number | null
  signal: string | null
  durationMs: number
  logPath: string
  pathSource: 'login_shell' | 'process'
  /** The error code a failed run reports (`setup_failed`·`setup_timed_out`), the same as `stages.setup.error`; null on success. */
  error: 'setup_failed' | 'setup_timed_out' | null
  /** What happened beyond the exit status (spawn error, cancellation, budget); null when there is nothing to add. */
  detail: string | null
}
export type SetupReceipt =
  | { policy: SetupPolicy; status: 'skipped'; reason: 'policy_skip' | 'no_command'; command: null; logPath: null }
  | ({ policy: SetupPolicy } & SetupRun)

const COMMAND_RULE = `one non-blank line without NUL, at most ${SETUP_COMMAND_MAX} bytes`
const validCommand = (value: string) => !!value.trim() && !value.includes('\0') && !/[\r\n]/.test(value) && Buffer.byteLength(value) <= SETUP_COMMAND_MAX

/** `null` clears; anything else must be one non-blank line within the byte limit. */
export function readSetupCommand(value: string): string | null {
  if (value === 'null') return null
  if (!validCommand(value)) throw new RuntimeError('invalid_argument', `--command must be ${COMMAND_RULE}, or null`, undefined, undefined, 'not_started')
  return value
}

/**
 * The repo's command as it stands in repos.json when it is about to run. A hand-edited value is held to
 * the same rule as `set-setup-command`; an invalid one is refused before any effect and never run.
 */
export function registeredSetupCommand(repo: { name: string; id: string; setupCommand?: string | null }): string | null {
  const value = repo.setupCommand
  if (value === undefined || value === null) return null
  // A non-string never gets here: the registry read refuses the whole record (`isRepo`).
  if (!validCommand(value)) {
    throw new RuntimeError('setup_command_invalid', `The setup command registered for ${repo.name} in repos.json is not ${COMMAND_RULE}; it was not run. Fix it with corral repo set-setup-command`, { repo: repo.id }, undefined, 'not_started')
  }
  return value
}

export function setupLogDirectory(userData: string): string {
  return path.join(userData, 'logs', 'worktree-setup')
}

function userShell(): string {
  if (process.env.SHELL) return process.env.SHELL
  try { return os.userInfo().shell || '/bin/sh' } catch { return '/bin/sh' }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try { process.kill(-pid, signal) } catch { /* The group is already gone. */ }
}

/**
 * Runs `command` with `/bin/sh -c` in `worktreePath` and resolves when the shell exits or the budget
 * runs out. Never throws for a failing command — the result carries the status.
 */
export async function runSetupCommand(input: { command: string; worktreePath: string; rootPath: string; userData: string; deadlineAt: number; signal: AbortSignal }): Promise<SetupRun> {
  const started = Date.now()
  const directory = setupLogDirectory(input.userData)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stamp = new Date(started).toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(directory, `${stamp}-${path.basename(input.worktreePath)}-${randomUUID().slice(0, 8)}.log`)
  const log = fs.openSync(logPath, 'a', 0o600)
  const note = (line: string) => fs.writeSync(log, `[corral] ${line}\n`)
  const remaining = () => input.deadlineAt - RESERVE_MS - Date.now()
  type Outcome = { status: SetupRun['status']; exitCode: number | null; signal: string | null; detail: string | null }
  const finish = (run: Outcome): SetupRun => {
    const durationMs = Date.now() - started
    note(`${run.status} exit=${run.exitCode ?? 'null'} signal=${run.signal ?? 'null'} duration=${durationMs}ms${run.detail ? ` detail=${run.detail}` : ''}`)
    fs.closeSync(log)
    const error = run.status === 'completed' ? null : run.status === 'timed_out' ? 'setup_timed_out' : 'setup_failed'
    return { ...run, error, pathSource, command: input.command, logPath, durationMs }
  }
  note(`setup command: ${input.command}`)
  note(`cwd: ${input.worktreePath}`)
  const probe = await probeLoginShellPath({ shell: userShell(), timeoutMs: Math.max(1, Math.min(PROBE_TIMEOUT_MS, Math.floor(remaining() / 3))), env: process.env, signal: input.signal })
  const pathSource: SetupRun['pathSource'] = probe.pathValue === null ? 'process' : 'login_shell'
  note(probe.pathValue === null ? `login shell PATH unavailable (${probe.outcome.ok ? 'ok' : probe.outcome.reason}); using the runtime PATH` : 'PATH from the login shell')
  if (input.signal.aborted) return finish({ status: 'failed', exitCode: null, signal: null, detail: 'cancelled' })
  if (remaining() <= 0) return finish({ status: 'timed_out', exitCode: null, signal: null, detail: 'request budget exhausted before the command started' })
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: probe.pathValue ?? process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', CORRAL_WORKTREE_PATH: input.worktreePath, CORRAL_ROOT_PATH: input.rootPath }
  return await new Promise<SetupRun>((resolve) => {
    let settled = false, expired: 'timed_out' | 'cancelled' | null = null, grace: NodeJS.Timeout | undefined
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('/bin/sh', ['-c', input.command], { cwd: input.worktreePath, env, stdio: ['ignore', log, log], detached: true })
    } catch (error) {
      resolve(finish({ status: 'failed', exitCode: null, signal: null, detail: String(error) }))
      return
    }
    const settle = (run: Outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      input.signal.removeEventListener('abort', onAbort)
      resolve(finish(run))
    }
    // The whole group goes: the command's children (npm's workers, a `sleep &`) share its process group.
    const stop = (reason: 'timed_out' | 'cancelled') => {
      if (expired) return
      expired = reason
      // Past the budget: TERM, then SIGKILL after 300 ms if the leader is still there. The leader's exit
      // ends that grace — the rest of the group is SIGKILLed at once (see 'exit'), so children get no
      // more than the leader took. A cancelled request or a closing runtime (whose process may exit on
      // the next tick) gets SIGKILL now, with no timer.
      if (reason === 'cancelled') { killGroup(child.pid, 'SIGKILL'); return }
      killGroup(child.pid, 'SIGTERM')
      grace = setTimeout(() => killGroup(child.pid, 'SIGKILL'), TERM_GRACE_MS)
    }
    const timer = setTimeout(() => stop('timed_out'), remaining())
    const onAbort = () => stop('cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => settle({ status: 'failed', exitCode: null, signal: null, detail: String(error) }))
    child.on('exit', (code, signal) => {
      // After a kill the leader may exit before its children; finish the group before reporting.
      if (expired) {
        killGroup(child.pid, 'SIGKILL')
        settle({ status: expired === 'timed_out' ? 'timed_out' : 'failed', exitCode: code, signal, detail: expired === 'timed_out' ? 'request budget exceeded; process group killed' : 'cancelled; process group killed' })
      } else settle({ status: code === 0 ? 'completed' : 'failed', exitCode: code, signal, detail: null })
    })
  })
}

/** The error a failed or timed-out setup becomes when there is no later stage to carry it. */
export function setupError(run: SetupRun, resources: Record<string, unknown>): RuntimeError {
  const what = run.status === 'timed_out' ? 'Setup command timed out' : `Setup command failed (exit ${run.exitCode ?? run.signal ?? 'none'}${run.detail ? `; ${run.detail}` : ''})`
  return new RuntimeError(run.error ?? 'setup_failed', `${what}; worktree kept at ${String(resources.path)}; log: ${run.logPath}`, resources)
}
