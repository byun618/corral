// LIFE-600 C8 — 연결 저장 파일: 바꾸기 전엔 안 만든다 · 0600 · 원자 쓰기 · 망가진 행만 버린다 · 쓰기 실패면 메모리도 그대로.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkConnectionStore } from './store.js'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l600-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// LIFE-605 C1⑥ — 이전 판(LIFE-600) 행은 `account` 칸이 없다. 읽으면 빈 객체로 무손실.
const legacyRow = { id: 'c1', sourceId: 'la', addedAt: 1, tokenTail: 'abcd', sealed: 'c2VhbGVk', hiddenSpaceKeys: ['s1'] }
const row = { ...legacyRow, account: {} }

describe('WorkConnectionStore', () => {
  it('바꾸기 전에는 파일이 없다 · 쓰면 0600 · 다시 읽힌다', () => {
    const dir = tempDir()
    const store = new WorkConnectionStore(dir)
    store.load()
    expect(fs.existsSync(store.file)).toBe(false)
    expect(store.write({ connections: [row], repoDefaults: { r1: { connectionId: 'c1', spaceKey: 's1' } } })).toEqual({ ok: true })
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)
    const again = new WorkConnectionStore(dir)
    again.load()
    expect(again.get()).toEqual({ connections: [row], repoDefaults: { r1: { connectionId: 'c1', spaceKey: 's1' } } })
  })

  it('망가진 행만 버린다', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'work-connections.json'), JSON.stringify({ version: 1, connections: [legacyRow, { id: 'bad' }, { ...legacyRow, id: 'c2', tokenTail: 'toolong' }], repoDefaults: { r1: 'x' } }))
    const store = new WorkConnectionStore(dir)
    store.load()
    expect(store.get()).toEqual({ connections: [row], repoDefaults: {} })
  })

  it('쓰기 실패면 메모리 값도 그대로', () => {
    const dir = tempDir()
    const store = new WorkConnectionStore(dir)
    fs.chmodSync(dir, 0o500)
    const result = store.write({ connections: [row], repoDefaults: {} })
    expect(result.ok).toBe(false)
    expect(store.get()).toEqual({ connections: [], repoDefaults: {} })
  })
})
