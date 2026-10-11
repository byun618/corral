// R1-A6 — 계측 소켓이 비밀(페어링 코드)을 줄 수 있는 조건: 폴더가 이 사용자 소유·심링크 아님·0700, 소켓 0600(생성 시 강제).
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listenPrivateSocket, privateSocketDirectory } from './control-socket.js'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l577c-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('계측 소켓 폴더·소켓 권한', () => {
  it('0700·내 소유 폴더만 비공개로 본다 — 0755·심링크·없음은 아니다', () => {
    const root = tmp()
    const open = path.join(root, 'open')
    fs.mkdirSync(open, { mode: 0o755 })
    fs.chmodSync(open, 0o755)
    const closed = path.join(root, 'closed')
    fs.mkdirSync(closed, { mode: 0o700 })
    const link = path.join(root, 'link')
    fs.symlinkSync(closed, link)
    expect(privateSocketDirectory(closed)).toBe(true)
    expect(privateSocketDirectory(open)).toBe(false)
    expect(privateSocketDirectory(link)).toBe(false)
    expect(privateSocketDirectory(path.join(root, 'missing'))).toBe(false)
  })

  it('umask 000 에서도 소켓은 0600 으로 생긴다', async () => {
    const dir = path.join(tmp(), 's')
    fs.mkdirSync(dir, { mode: 0o700 })
    const socketPath = path.join(dir, 'c.sock')
    const server = net.createServer()
    const previous = process.umask(0)
    try {
      await listenPrivateSocket({ server, socketPath })
    } finally {
      process.umask(previous)
    }
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600)
  })
})
