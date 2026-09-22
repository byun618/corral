import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CommandRegistry, foundationSpecs, validateFoundation } from './registry.js'
import { RuntimeError, stringFlag, type Invocation, type RpcResponse } from './contracts.js'
import { defaultUserData, privateDirectory } from './storage.js'
import { localCall, request, socketPath } from './transport.js'
import { workspaceModule } from './workspace/index.js'
import { terminalModule, MAX_INPUT } from './terminal/index.js'
import { orchestrationModule } from './orchestration/index.js'
import { randomUUID } from 'node:crypto'
import { startRuntime } from './server.js'
import { isRecord } from '../shared/json.js'
const registry = new CommandRegistry()
registry.register({ specs: foundationSpecs, validate: validateFoundation, execute: async () => { throw new Error('Client metadata') } })
registry.register(workspaceModule(defaultUserData()))
registry.register(terminalModule(defaultUserData()))
registry.register(orchestrationModule(defaultUserData()))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function print(response: RpcResponse, json: boolean): void {
  if (json) console.log(JSON.stringify(response))
  else if (response.ok) {
    console.log(JSON.stringify(response.result, null, 2))
    if (isRecord(response.result) && isRecord(response.result.hostScope)) {
      console.log('scope: local')
      if (response.result.truncated) console.log(`truncated: showing ${Array.isArray(response.result.worktrees) ? response.result.worktrees.length : 0} of ${String(response.result.totalCount)}`)
    }
  }
  else console.error(`${response.error?.code}: ${response.error?.message}`)
  process.exitCode = response.ok ? 0 : 1
}
async function open(userData: string, inv: Invocation, signal: AbortSignal): Promise<RpcResponse> {
  const endpoint = socketPath(userData), budget = Number(inv.flags['timeout-ms'] ?? 20000), deadline = Date.now() + budget
  let expectedRuntimeId = stringFlag(inv.flags, 'instance'), effectsStarted = false
  const call = (command: string) => localCall(endpoint, { ...request({ ...inv, command }, expectedRuntimeId, Math.max(1, deadline - Date.now())), expectedUserData: path.resolve(userData) }, Math.max(1, deadline - Date.now()), signal)
  try {
    let handed = false
    try {
      const prior = await call('open')
      if (!prior.ok) return prior
      handed = isRecord(prior.result) && prior.result.handoff === 'desktop'
      if (handed) { effectsStarted = true; expectedRuntimeId = prior._meta.runtimeId }
      if (!handed) return prior
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== 'runtime_unavailable') throw error
      if (inv.flags.instance || process.env.CORRAL_RUNTIME_SOCKET) throw new RuntimeError('runtime_unavailable', 'Selected runtime is not reachable; no desktop launched')
    }
    if (handed) {
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        try { const status = await call('status'); if (!status.ok) throw new RuntimeError('identity_mismatch', status.error?.message ?? 'Handoff identity check failed') } catch (error) {
          if (error instanceof RuntimeError && error.code === 'runtime_unavailable') break
          if (!(error instanceof RuntimeError && error.code === 'outcome_unknown')) throw error
        }
        await pause(30)
      }
    }
    signal.throwIfAborted()
    if (Date.now() >= deadline) throw new RuntimeError('outcome_unknown', 'Handoff deadline exceeded')
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const electron = process.env.CORRAL_ELECTRON ?? path.join(root, 'node_modules/electron', process.platform === 'darwin' ? 'dist/Electron.app/Contents/MacOS/Electron' : 'dist/electron')
    if (!fs.existsSync(path.join(root, 'out/main/index.js'))) throw new RuntimeError('build_required', 'Run npm run build first')
    privateDirectory(path.join(userData, 'runtime'))
    const logfile = fs.openSync(path.join(userData, 'runtime/desktop.log'), 'a', 0o600)
    const env: NodeJS.ProcessEnv = { ...process.env, CORRAL_USER_DATA: userData }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [root, `--user-data-dir=${userData}`], { env, detached: true, stdio: ['ignore', logfile, logfile] })
    effectsStarted ||= child.pid !== undefined
    fs.closeSync(logfile)
    let failure: Error | undefined
    child.once('error', error => { failure = error }); child.unref()
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (failure) throw new RuntimeError('launch_failed', failure.message)
      try {
        const response = await call('status')
        if (!response.ok) return { ...response, _meta: { ...response._meta, outcome: effectsStarted ? 'unknown' : response._meta.outcome } }
        if (isRecord(response.result) && isRecord(response.result.ui) && response.result.ui.available === true) return response
      } catch (error) { if (!(error instanceof RuntimeError) || error.code !== 'runtime_unavailable') throw error }
      await pause(50)
    }
    throw new RuntimeError('outcome_unknown', 'Desktop launch deadline exceeded; inspect runtime/desktop.log before retrying')
  } catch (error) {
    if (effectsStarted && !(error instanceof RuntimeError && error.code === 'request_cancelled')) throw new RuntimeError('outcome_unknown', `Desktop handoff/launch may have taken effect: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}
export async function runCli(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const controller = new AbortController()
  const cancel = () => controller.abort(new RuntimeError('request_cancelled', 'CLI cancelled; accepted effects may already have occurred'))
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  let recovery: { requestId: string; terminal: string | boolean | null; command: string; action: string } | undefined
  try {
    const inv = registry.parse(argv, process.cwd())
    if (inv.flags.help) {
      const commands = inv.command ? [registry.spec(inv.command)!] : registry.schema().commands
      console.log(json ? JSON.stringify({ ok: true, commands }) : 'Local Unix socket commands (no remote/environment support):\n' + commands.map(s => s.usage).join('\n')); return
    }
    if (inv.command === 'agent-context') { console.log(JSON.stringify(registry.schema(), null, json ? 0 : 2)); return }
    if (inv.flags.stdin) {
      const abortStdin = () => process.stdin.destroy()
      controller.signal.addEventListener('abort', abortStdin, { once: true })
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of process.stdin) {
        controller.signal.throwIfAborted()
        const data = Buffer.from(chunk); size += data.length
        if (size > MAX_INPUT) throw new RuntimeError('invalid_argument', `stdin exceeds ${MAX_INPUT} bytes`)
        chunks.push(data)
      }
      controller.signal.removeEventListener('abort', abortStdin)
      controller.signal.throwIfAborted()
      try { inv.stdin = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)) }
      catch { throw new RuntimeError('invalid_argument', 'stdin must contain valid UTF-8') }
      registry.validate(inv)
    }
    if (['terminal create', 'terminal send'].includes(inv.command)) {
      inv.flags['request-id'] ??= `r1.${Date.now()}.${randomUUID()}`
      recovery = { requestId: String(inv.flags['request-id']), terminal: inv.flags.terminal ?? null, command: inv.command, action: 'Retry with the same request ID and input; inspect terminal list/read if unknown' }
    }
    if (inv.flags.socket) process.env.CORRAL_RUNTIME_SOCKET = String(inv.flags.socket)
    const userData = defaultUserData()
    if (inv.command === 'serve') {
      let finish = () => {}
      const serving = new Promise<void>(resolve => { finish = resolve })
      controller.signal.addEventListener('abort', finish, { once: true })
      const runtime = await startRuntime({ userData, requestDesktop: finish })
      try {
        print({ id: 'local', ok: true, result: runtime.status(), _meta: { runtimeId: runtime.runtimeId } }, json)
        if (!controller.signal.aborted) await serving
      } finally { await runtime.close() }
      return
    }
    const response = inv.command === 'open' ? await open(userData, inv, controller.signal) : await localCall(socketPath(userData), request(inv, stringFlag(inv.flags, 'instance'), Number(inv.flags['timeout-ms'] ?? 10000)), inv.command === 'terminal wait' ? Number(inv.flags['timeout-ms'] ?? 10000) + 500 : undefined, controller.signal)
    print(response, json)
  } catch (error) {
    print({ id: 'local', ok: false, error: { code: error instanceof RuntimeError ? error.code : 'operation_failed', message: error instanceof Error ? error.message : String(error), resources: error instanceof RuntimeError ? error.resources ?? recovery : recovery, stage: error instanceof RuntimeError ? error.stage : undefined }, _meta: { runtimeId: 'unknown', outcome: error instanceof RuntimeError && ['outcome_unknown', 'request_cancelled'].includes(error.code) ? 'unknown' : 'not_started' } }, json)
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
}
