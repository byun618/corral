import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { workspaceModule } from './workspace/index.js'
import { startRuntime } from './server.js'
import { localCall, request, MAX_REQUEST } from './transport.js'
import { CommandRegistry, foundationSpecs, validateFoundation } from './registry.js'
const cleanups: (() => Promise<void> | void)[] = []
const previous = { ...process.env }
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0; process.env = { ...previous } })
function fixture() {
  delete process.env.CORRAL_RUNTIME_SOCKET; delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const invocation = (command = 'status') => ({ command, flags: {}, args: [], cwd: '/tmp' })
describe('first release boundary and ownership', () => {
  it('has five foundation plus nineteen workspace commands and rejects future commands and unsupported options', () => {
    const registry = new CommandRegistry()
    registry.register({ specs: foundationSpecs, validate: validateFoundation, execute: async () => null })
    expect(registry.schema().commands.map(s => s.command)).toEqual(['open','serve','status','agent-context','diagnostics memory'])
    registry.register(workspaceModule('/tmp/metadata-only'))
    expect(registry.schema().commandCount).toBe(24)
    expect(registry.parse(['repo', 'add', '--path', '/tmp/repo'], '/tmp').command).toBe('repo add')
    for (const args of [['terminal','list'],['environment','list'],['repo','add'],['status','--host','local'],['serve','--port','0'],['status','--timeout-ms','0'],['status','--json','--json'],['status','unexpected']]) expect(() => registry.parse(args, '/tmp')).toThrow()
  })
  it('preserves runtime identity across restart, rejects another identity and a live owner', async () => {
    const dir = fixture(), socket = path.join(dir, 'runtime/rpc.sock')
    const first = await startRuntime({ userData: dir })
    cleanups.push(first.close)
    const prior = await localCall(socket, request(invocation()))
    expect(prior.ok).toBe(true)
    await expect(startRuntime({ userData: dir })).rejects.toMatchObject({ code: 'runtime_busy' })
    expect((await localCall(socket, request(invocation(), 'wrong'))).error?.code).toBe('identity_mismatch')
    expect((await localCall(socket, request(invocation('terminal list')))).ok).toBe(false)
    await first.close()
    const second = await startRuntime({ userData: dir }); cleanups.push(second.close)
    expect(second.runtimeId).toBe(first.runtimeId)
    expect(second.status().runtime.instanceId).not.toBe(first.status().runtime.instanceId)
  })
  it('rejects unsafe target sockets, bounds requests and leaves unrelated endpoints intact', async () => {
    const dir = fixture(), socket = path.join(dir, 'foreign.sock')
    const server = net.createServer(s => s.end())
    await new Promise<void>(resolve => server.listen(socket, resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    fs.chmodSync(socket, 0o666)
    await expect(localCall(socket, request(invocation()))).rejects.toMatchObject({ code: 'unsafe_permissions' })
    fs.chmodSync(socket, 0o600)
    const inode = fs.statSync(socket).ino
    process.env.CORRAL_RUNTIME_SOCKET = socket
    await expect(startRuntime({ userData: dir })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(fs.statSync(socket).ino).toBe(inode)
    await expect(localCall(socket, request({ ...invocation(), cwd: 'x'.repeat(MAX_REQUEST) }))).rejects.toMatchObject({ code: 'invalid_argument' })
  })
  it('times out lost responses and cancels connected requests without retry', async () => {
    const dir = fixture(), socket = path.join(dir, 'mock.sock'), clients = new Set<net.Socket>()
    let writes = 0
    const server = net.createServer(s => { clients.add(s); s.on('data', () => writes++); s.on('close', () => clients.delete(s)) })
    await new Promise<void>(resolve => server.listen(socket, resolve)); fs.chmodSync(socket, 0o600)
    cleanups.push(() => { for (const s of clients) s.destroy(); return new Promise<void>(resolve => server.close(() => resolve())) })
    await expect(localCall(socket, request(invocation()), 30)).rejects.toMatchObject({ code: 'outcome_unknown' })
    const abort = new AbortController(), result = localCall(socket, request(invocation()), 500, abort.signal)
    setTimeout(() => abort.abort(), 30)
    await expect(result).rejects.toMatchObject({ code: 'request_cancelled' })
    expect(writes).toBe(2)
  })
  it('rejects foreign and missing open profiles before handoff, including matching runtime IDs', async () => {
    const dir = fixture(), foreign = fixture(), socket = path.join(dir, 'runtime/rpc.sock')
    let handoffs = 0
    const runtime = await startRuntime({ userData: dir, requestDesktop: () => handoffs++ }); cleanups.push(runtime.close)
    for (const expectedRuntimeId of [undefined, runtime.runtimeId]) {
      for (const expectedUserData of [undefined, foreign]) {
        const response = await localCall(socket, { ...request(invocation('open'), expectedRuntimeId), expectedUserData })
        expect(response).toMatchObject({ ok: false, error: { code: 'profile_mismatch' }, _meta: { outcome: 'not_started' } })
      }
    }
    expect(handoffs).toBe(0)
    const response = await localCall(socket, { ...request(invocation('open'), runtime.runtimeId), expectedUserData: dir })
    expect(response.ok).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(handoffs).toBe(1)
  })
  it('focuses a hidden desktop before waiting for availability and reports uncertain effects on deadline', async () => {
    const dir = fixture(), socket = path.join(dir, 'runtime/rpc.sock')
    let visible = false, focuses = 0, allowShow = true
    const runtime = await startRuntime({ userData: dir, ui: () => visible, focus: () => { focuses++; visible = allowShow } }); cleanups.push(runtime.close)
    const call = (timeoutMs: number) => localCall(socket, { ...request(invocation('open'), runtime.runtimeId, timeoutMs), expectedUserData: dir }, 1000)
    expect((await call(500)).ok).toBe(true)
    expect(visible).toBe(true)
    visible = false; allowShow = false
    expect(await call(30)).toMatchObject({ ok: false, _meta: { outcome: 'unknown' } })
    expect(focuses).toBeGreaterThan(1)
  })

})
