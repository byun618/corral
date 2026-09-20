import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
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
  it('has exactly five commands and rejects legacy/future commands and unsupported options', () => {
    const registry = new CommandRegistry()
    registry.register({ specs: foundationSpecs, validate: validateFoundation, execute: async () => null })
    expect(registry.schema().commands.map(s => s.command)).toEqual(['open','serve','status','agent-context','diagnostics memory'])
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
})
