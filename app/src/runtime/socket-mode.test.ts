import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { localCall, request, serveSocket } from './transport.js'
import type { RpcRequest } from './contracts.js'

// LIFE-519: bind happens synchronously inside listen(), so lstat right after it returns sees the mode the
// socket was created with — the mode a polling client could meet before the runtime finishes starting.
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0; vi.restoreAllMocks() })
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l519-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, endpoint: path.join(dir, 'rpc.sock') }
}
const handle = async (req: RpcRequest) => ({ id: req.id, ok: true, result: null, _meta: { runtimeId: 'x', outcome: 'completed' as const } })
function looseUmask() {
  const prior = process.umask(0o022)
  cleanups.push(() => { process.umask(prior) })
}
function modesAfterBind(endpoint: string): string[] {
  const seen: string[] = []
  const listen = net.Server.prototype.listen
  vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: Parameters<typeof listen>) {
    const server = listen.apply(this, args)
    try { seen.push((fs.lstatSync(endpoint).mode & 0o777).toString(8)) } catch (error) { seen.push(error instanceof Error && 'code' in error ? String(error.code) : 'error') }
    return server
  })
  return seen
}
describe('control socket permissions (LIFE-519)', () => {
  it('never shows group or other bits at the endpoint, from bind to ready, and restores the umask', async () => {
    looseUmask()
    const { endpoint } = fixture()
    const seen = modesAfterBind(endpoint)
    const stop = await serveSocket(endpoint, handle); cleanups.push(stop)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter(mode => mode !== 'ENOENT' && (parseInt(mode, 8) & 0o077))).toEqual([])
    expect((fs.lstatSync(endpoint).mode & 0o777).toString(8)).toBe('600')
    expect(process.umask(0o022)).toBe(0o022)
  })
  it('keeps the umask and a live foreign socket when the endpoint is taken', async () => {
    looseUmask()
    const { endpoint } = fixture()
    const foreign = net.createServer(s => s.end())
    await new Promise<void>(resolve => foreign.listen(endpoint, resolve))
    cleanups.push(() => new Promise<void>(resolve => foreign.close(() => resolve())))
    const inode = fs.lstatSync(endpoint).ino
    await expect(serveSocket(endpoint, handle)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(fs.lstatSync(endpoint).ino).toBe(inode)
    expect(process.umask(0o022)).toBe(0o022)
  })
  it('still makes the client refuse a loose socket, a symlinked socket, a loose parent and a symlinked parent', async () => {
    const { dir, endpoint } = fixture()
    fs.chmodSync(dir, 0o700)
    const stop = await serveSocket(endpoint, handle); cleanups.push(stop)
    const status = (target: string) => localCall(target, request({ command: 'status', flags: {}, args: [], cwd: '/tmp' }))
    expect((await status(endpoint)).ok).toBe(true)
    fs.chmodSync(endpoint, 0o666)
    await expect(status(endpoint)).rejects.toMatchObject({ code: 'unsafe_permissions' })
    fs.chmodSync(endpoint, 0o600)
    const link = path.join(dir, 'link.sock'); fs.symlinkSync(endpoint, link)
    await expect(status(link)).rejects.toMatchObject({ code: 'unsafe_permissions' })
    fs.chmodSync(dir, 0o755)
    await expect(status(endpoint)).rejects.toMatchObject({ code: 'unsafe_permissions' })
    fs.chmodSync(dir, 0o700)
    const parentLink = fs.mkdtempSync(path.join(os.tmpdir(), 'l519p-')); cleanups.push(() => fs.rmSync(parentLink, { recursive: true, force: true }))
    fs.chmodSync(parentLink, 0o700); fs.symlinkSync(dir, path.join(parentLink, 'via'))
    await expect(status(path.join(parentLink, 'via', 'rpc.sock'))).rejects.toMatchObject({ code: 'unsafe_permissions' })
    expect((await status(endpoint)).ok).toBe(true)
  })
})
