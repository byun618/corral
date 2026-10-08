// LIFE-556 B6 — 설치본 동봉 바인딩이 사용자 프로필을 바꾸지 않고, 명시 바인딩·기존 프로필 규칙(backend_conflict·invalid_backend)은 그대로인가.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startRuntime } from './server.js'
import { localCall, request } from './transport.js'
import { isRecord } from '../shared/json.js'

const cleanups: (() => Promise<void> | void)[] = []
const previous = { ...process.env }
afterEach(async () => { for (const fn of cleanups.reverse()) await fn(); cleanups.length = 0; process.env = { ...previous } })
function fixture(): string {
  delete process.env.CORRAL_RUNTIME_SOCKET; delete process.env.CORRAL_BACKEND_SOCKET; delete process.env.CORRAL_SESSION
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l556-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const status = async (dir: string): Promise<unknown> => {
  const response = await localCall(path.join(dir, 'runtime/rpc.sock'), request({ command: 'status', flags: {}, args: [], cwd: '/tmp' }))
  if (!response.ok || !isRecord(response.result)) throw new Error(JSON.stringify(response))
  return response.result['backend']
}
const profile = (dir: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, 'runtime/profile.json'), 'utf8'))

describe('bundled backend binding', () => {
  it('backend 없는 프로필 — 동봉 서버를 쓰되 프로필에 쓰지 않는다', async () => {
    const dir = fixture()
    fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'runtime/profile.json'), JSON.stringify({ runtimeId: 'r-user' }))
    let attached: { socket: string; session: string } | null = null
    const runtime = await startRuntime({ userData: dir, bundledBackend: () => attached }); cleanups.push(runtime.close)
    expect(await status(dir)).toEqual({ state: 'not_connected', ownership: 'bundled' })
    attached = { socket: '/b/corral-herdr/herdr.sock', session: 'default' }
    expect(await status(dir)).toEqual({ socket: '/b/corral-herdr/herdr.sock', session: 'default', ownership: 'bundled', lifecycle: 'independent' })
    expect(profile(dir)).toEqual({ runtimeId: 'r-user' })
    expect(process.env.CORRAL_BACKEND_SOCKET).toBeUndefined()
    expect(process.env.CORRAL_SESSION).toBeUndefined()
  })
  it('명시 바인딩(env)이 있으면 종전대로 그 backend 를 저장·사용하고 동봉 서버는 무시한다', async () => {
    const dir = fixture()
    process.env.CORRAL_BACKEND_SOCKET = '/dev/guard.sock'; process.env.CORRAL_SESSION = 'life-dev'
    const runtime = await startRuntime({ userData: dir, bundledBackend: () => ({ socket: '/b/herdr.sock', session: 'default' }) }); cleanups.push(runtime.close)
    expect(await status(dir)).toEqual({ socket: '/dev/guard.sock', session: 'life-dev', ownership: 'external', lifecycle: 'independent' })
    expect(profile(dir)).toMatchObject({ backend: { socket: '/dev/guard.sock', session: 'life-dev' } })
  })
  it('프로필 backend 와 다른 명시 바인딩은 종전대로 backend_conflict, 반쪽은 invalid_backend', async () => {
    const dir = fixture()
    fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'runtime/profile.json'), JSON.stringify({ runtimeId: 'r', backend: { socket: '/a.sock', session: 'a' } }))
    process.env.CORRAL_BACKEND_SOCKET = '/other.sock'; process.env.CORRAL_SESSION = 'a'
    await expect(startRuntime({ userData: dir, bundledBackend: () => null })).rejects.toMatchObject({ code: 'backend_conflict' })
    const half = fixture()
    process.env.CORRAL_BACKEND_SOCKET = '/x.sock'; delete process.env.CORRAL_SESSION
    await expect(startRuntime({ userData: half, bundledBackend: () => null })).rejects.toMatchObject({ code: 'invalid_backend' })
  })
  it('개발 실행(bundledBackend 없음)은 종전 not_configured', async () => {
    const dir = fixture()
    const runtime = await startRuntime({ userData: dir }); cleanups.push(runtime.close)
    expect(await status(dir)).toEqual({ state: 'not_configured' })
  })
})
