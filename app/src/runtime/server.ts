import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { RuntimeError, type RpcResponse } from './contracts.js'
import { CommandRegistry, foundationSpecs, validateFoundation } from './registry.js'
import { atomicWrite, privateDirectory, readFile, recoverLock } from './storage.js'
import { serveSocket, socketPath } from './transport.js'
import { workspaceModule } from './workspace/index.js'
import type { WorkspaceDesktop } from './workspace/model.js'
import { terminalModule, type TerminalDesktop } from './terminal/index.js'
import { isRecord } from '../shared/json.js'
import { memorySnapshot } from './memory.js'

interface Profile { runtimeId: string; backend?: { socket: string; session: string } }
export function restoreBackend(userData: string): void {
  const profile = readFile<Profile | null>(path.join(userData, 'runtime/profile.json'), () => null)
  if (!profile?.backend) return
  if ((process.env.CORRAL_BACKEND_SOCKET && process.env.CORRAL_BACKEND_SOCKET !== profile.backend.socket) ||
      (process.env.CORRAL_SESSION && process.env.CORRAL_SESSION !== profile.backend.session))
    throw new RuntimeError('backend_conflict', 'Profile belongs to a different backend/session')
  process.env.CORRAL_BACKEND_SOCKET = profile.backend.socket
  process.env.CORRAL_SESSION = profile.backend.session
}
export async function startRuntime(options: {
  userData: string
  workspaceDesktop?: WorkspaceDesktop
  terminalDesktop?: TerminalDesktop
  requestDesktop?: () => void
  ui?: () => boolean
  focus?: () => void
  appProcessRoles?: () => Map<number, string>
}) {
  const directory = path.join(options.userData, 'runtime')
  privateDirectory(directory)
  const endpoint = socketPath(options.userData)
  privateDirectory(path.dirname(endpoint))
  const lock = path.join(directory, 'owner.json')
  let fd: number
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch {
    fd = recoverLock(lock, () => {
      const owner = readFile<{ pid: number; socket?: string; socketInode?: number }>(lock, () => ({ pid: 0 }))
      let dead = false
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0) } catch (error) { dead = error instanceof Error && 'code' in error && error.code === 'ESRCH' }
      }
      if (!dead) throw new RuntimeError('runtime_busy', 'Runtime owner is alive or still initializing')
      // Only the dead owner's recorded inode is ours to reclaim.
      if (owner.socket === endpoint && fs.existsSync(endpoint) && fs.lstatSync(endpoint).isSocket() && fs.lstatSync(endpoint).ino === owner.socketInode) fs.unlinkSync(endpoint)
      fs.unlinkSync(lock)
      return fs.openSync(lock, 'wx', 0o600)
    })
  }
  const instanceId = randomUUID()
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, instanceId })); fs.closeSync(fd)
  let stopSocket: (() => Promise<void>) | undefined
  const controller = new AbortController()
  const cleanup = async () => {
    controller.abort()
    await stopSocket?.()
    const owner = readFile<{ instanceId: string } | null>(lock, () => null)
    if (owner?.instanceId === instanceId) fs.unlinkSync(lock)
  }
  try {
    restoreBackend(options.userData)
    const profileFile = path.join(directory, 'profile.json')
    const profile = readFile<Profile>(profileFile, () => ({ runtimeId: randomUUID() }))
    if (typeof profile.runtimeId !== 'string' || !profile.runtimeId) throw new RuntimeError('storage_corrupt', 'Invalid runtime profile')
    if (!!process.env.CORRAL_BACKEND_SOCKET !== !!process.env.CORRAL_SESSION) throw new RuntimeError('invalid_backend', 'Set both CORRAL_BACKEND_SOCKET and CORRAL_SESSION')
    if (process.env.CORRAL_BACKEND_SOCKET && process.env.CORRAL_SESSION) profile.backend = { socket: process.env.CORRAL_BACKEND_SOCKET, session: process.env.CORRAL_SESSION }
    atomicWrite(profileFile, profile)
    const { runtimeId } = profile
    const status = () => ({ target: { kind: 'local', socket: endpoint }, runtime: { state: 'ready', reachable: true, runtimeId, instanceId, pid: process.pid, mode: options.ui ? 'desktop' : 'headless', capabilities: registry.schema().commands.map(s => s.command) }, ui: { available: options.ui?.() ?? false }, backend: profile.backend ? { ...profile.backend, ownership: 'external', lifecycle: 'independent' } : { state: 'not_configured' } })
    const registry = new CommandRegistry()
    registry.register({ specs: foundationSpecs, validate: validateFoundation, execute: async (inv, ctx) => {
      if (inv.command === 'status') return status()
      if (inv.command === 'diagnostics memory') return memorySnapshot(options.appProcessRoles?.(), ctx.signal)
      if (inv.command === 'open') {
        if (options.ui) {
          options.focus?.()
          while (!options.ui()) {
            await delay(25, undefined, { signal: ctx.signal })
            options.focus?.()
          }
          return status()
        }
        if (!options.requestDesktop) throw new RuntimeError('ui_unavailable', 'Desktop handoff unavailable')
        return { handoff: 'desktop', runtimeId, instanceId }
      }
      throw new RuntimeError('client_command', 'This command must execute in the CLI client')
    } })
    registry.register(workspaceModule(options.userData, options.workspaceDesktop))
    registry.register(terminalModule(options.userData, options.terminalDesktop))
    const lanes = new Map<string, Promise<unknown>>()
    stopSocket = await serveSocket(endpoint, async (req, cancelled): Promise<RpcResponse> => {
      const signal = AbortSignal.any([controller.signal, cancelled, AbortSignal.timeout(req.timeoutMs ?? 10000)])
      const meta = { runtimeId, instanceId }
      let effectsStarted = false
      const deadlineAt = Date.now() + (req.timeoutMs ?? 10000)
      try {
        if (req.expectedRuntimeId && req.expectedRuntimeId !== runtimeId) throw new RuntimeError('identity_mismatch', 'Request addresses a different runtime')
        if (req.invocation.command === 'open') {
          let matches = false
          try { matches = !!req.expectedUserData && fs.realpathSync(req.expectedUserData) === fs.realpathSync(options.userData) } catch { /* Missing profile cannot own this runtime. */ }
          if (!matches) throw new RuntimeError('profile_mismatch', 'Selected runtime belongs to another profile; set CORRAL_USER_DATA to its owner before open')
        }
        registry.validate(req.invocation)
        signal.throwIfAborted()
        const module = registry.module(req.invocation.command)!
        const execute = async () => {
          signal.throwIfAborted()
          effectsStarted = (req.invocation.command === 'open' && !!options.ui) || (!module.tracksEffects && !!module.isMutation?.(req.invocation))
          return module.execute(req.invocation, { ...meta, userData: options.userData, signal, remote: false, deadlineAt, onEffect: () => { effectsStarted = true } })
        }
        const key = module.serialKey?.(req.invocation)
        const pending = key ? (lanes.get(key) ?? Promise.resolve()).catch(() => {}).then(execute) : execute()
        if (key) lanes.set(key, pending)
        let result: unknown
        try { result = await pending } finally { if (key && lanes.get(key) === pending) lanes.delete(key) }
        signal.throwIfAborted()
        return { id: req.id, ok: true, result, _meta: { ...meta, outcome: 'completed' } }
      } catch (error) {
        const terminal = req.invocation.command.startsWith('terminal ')
        const waitTimeout = req.invocation.command === 'terminal wait' && !cancelled.aborted && !controller.signal.aborted && (signal.aborted || error instanceof RuntimeError && ['wait_timeout', 'backend_timeout', 'deadline_exceeded'].includes(error.code))
        const detail = error instanceof RuntimeError ? error.resources : undefined
        const resources = terminal ? { ...(isRecord(detail) ? detail : {}), terminal: req.invocation.flags.terminal ?? null,
          requestId: req.invocation.flags['request-id'] ?? null, recovery: 'Inspect terminal list/show/read; retry mutations only with the same request ID' } : detail
        const stage = error instanceof RuntimeError && error.stage ? error.stage : terminal ? (effectsStarted ? 'backend' : 'preflight') : undefined
        return { id: req.id, ok: false, error: { code: waitTimeout ? 'wait_timeout' : signal.aborted ? 'request_cancelled' : error instanceof RuntimeError ? error.code : 'operation_failed', message: error instanceof Error ? error.message : String(error), resources, stage }, _meta: { ...meta, outcome: error instanceof RuntimeError && error.outcome ? error.outcome : effectsStarted ? 'unknown' : 'not_started' } }
      }
    }, (req, response) => { if (req.invocation.command === 'open' && response.ok && !options.ui) options.requestDesktop?.() })
    atomicWrite(lock, { pid: process.pid, instanceId, socket: endpoint, socketInode: fs.lstatSync(endpoint).ino })
    return { runtimeId, status, close: cleanup }
  } catch (error) { await cleanup(); throw error }
}
