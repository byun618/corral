import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { RuntimeError, type RpcResponse } from './contracts.js'
import { CommandRegistry, foundationSpecs, validateFoundation } from './registry.js'
import { atomicWrite, privateDirectory, readFile, recoverLock } from './storage.js'
import { serveSocket, socketPath } from './transport.js'
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
    const status = () => ({ target: { kind: 'local', socket: endpoint }, runtime: { state: 'ready', reachable: true, runtimeId, instanceId, pid: process.pid, mode: options.ui ? 'desktop' : 'headless', capabilities: foundationSpecs.map(s => s.command) }, ui: { available: options.ui?.() ?? false }, backend: profile.backend ? { ...profile.backend, ownership: 'external', lifecycle: 'independent' } : { state: 'not_configured' } })
    const registry = new CommandRegistry()
    registry.register({ specs: foundationSpecs, validate: validateFoundation, execute: async (inv, ctx) => {
      if (inv.command === 'status') return status()
      if (inv.command === 'diagnostics memory') return memorySnapshot(options.appProcessRoles?.(), ctx.signal)
      if (inv.command === 'open') {
        if (options.ui) {
          while (!options.ui()) await delay(25, undefined, { signal: ctx.signal })
          options.focus?.(); return status()
        }
        if (!options.requestDesktop) throw new RuntimeError('ui_unavailable', 'Desktop handoff unavailable')
        return { handoff: 'desktop', runtimeId, instanceId }
      }
      throw new RuntimeError('client_command', 'This command must execute in the CLI client')
    } })
    stopSocket = await serveSocket(endpoint, async (req, cancelled): Promise<RpcResponse> => {
      const signal = AbortSignal.any([controller.signal, cancelled, AbortSignal.timeout(req.timeoutMs ?? 10000)])
      const meta = { runtimeId, instanceId }
      try {
        if (req.expectedRuntimeId && req.expectedRuntimeId !== runtimeId) throw new RuntimeError('identity_mismatch', 'Request addresses a different runtime')
        registry.validate(req.invocation)
        signal.throwIfAborted()
        const result = await registry.module(req.invocation.command)!.execute(req.invocation, { ...meta, userData: options.userData, signal, remote: false, deadlineAt: Date.now() + (req.timeoutMs ?? 10000) })
        signal.throwIfAborted()
        return { id: req.id, ok: true, result, _meta: { ...meta, outcome: 'completed' } }
      } catch (error) {
        return { id: req.id, ok: false, error: { code: signal.aborted ? 'request_cancelled' : error instanceof RuntimeError ? error.code : 'operation_failed', message: error instanceof Error ? error.message : String(error) }, _meta: { ...meta, outcome: 'not_started' } }
      }
    }, (req, response) => { if (req.invocation.command === 'open' && response.ok && !options.ui) options.requestDesktop?.() })
    atomicWrite(lock, { pid: process.pid, instanceId, socket: endpoint, socketInode: fs.lstatSync(endpoint).ino })
    return { runtimeId, status, close: cleanup }
  } catch (error) { await cleanup(); throw error }
}
