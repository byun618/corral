// LIFE-589 E4 — 감시 배치 순수 규칙: 제외 목록(ⓓ — 감시 프로세스 안에서 버림)·trailing/max 창·overflow(ⓔ).
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BATCH_MAX_MS, BATCH_OVERFLOW_DIRS, BATCH_TRAILING_MS, ChangeBatch, dirsOfChange, relOfEvent } from './explorer-watch-batch.js'

describe('E4ⓓ 제외 목록', () => {
  it('경로 어디든 제외 이름이 끼면 null', () => {
    expect(relOfEvent(['node_modules', 'x', 'y.js'].join(path.sep))).toBeNull()
    expect(relOfEvent(['app', '.git', 'index'].join(path.sep))).toBeNull()
    expect(relOfEvent(['app', 'dist', 'a.js'].join(path.sep))).toBeNull()
  })
  it('build 는 제외하지 않는다(corral app/build 는 추적 폴더)', () => {
    expect(relOfEvent(['app', 'build', 'icon.png'].join(path.sep))).toBe('app/build/icon.png')
  })
  it('바뀐 경로 → 그 경로와 부모', () => {
    expect(dirsOfChange('src/a.ts')).toEqual(['src/a.ts', 'src'])
    expect(dirsOfChange('a.ts')).toEqual(['a.ts', ''])
  })
})

describe('E4ⓔ 배치', () => {
  it('제외 이벤트는 배치에 안 들어가고 개수만 센다', () => {
    const batch = new ChangeBatch()
    batch.add({ filename: ['node_modules', 'a'].join(path.sep), now: 0 })
    expect(batch.isEmpty()).toBe(true)
    expect(batch.excludedCount).toBe(1)
    expect(batch.take()).toBeNull()
  })
  it('trailing 창 — 마지막 이벤트 뒤 150 ms', () => {
    const batch = new ChangeBatch()
    batch.add({ filename: 'a.ts', now: 0 })
    expect(batch.due(BATCH_TRAILING_MS - 1)).toBe(false)
    expect(batch.due(BATCH_TRAILING_MS)).toBe(true)
  })
  it('max 창 — 이벤트가 계속 와도 첫 것부터 500 ms 면 내보낸다', () => {
    const batch = new ChangeBatch()
    for (let t = 0; t <= BATCH_MAX_MS; t += 100) batch.add({ filename: `f${t}`, now: t })
    expect(batch.due(BATCH_MAX_MS)).toBe(true)
    const taken = batch.take()
    expect(taken).toMatchObject({ kind: 'changed' })
    expect(batch.isEmpty()).toBe(true)
  })
  it('폴더 200개 넘으면 overflow 하나', () => {
    const batch = new ChangeBatch()
    for (let i = 0; i <= BATCH_OVERFLOW_DIRS; i += 1) batch.add({ filename: ['d', `x${i}`].join(path.sep), now: 0 })
    expect(batch.take()).toEqual({ kind: 'overflow' })
  })
  it('이름 없는 이벤트는 overflow', () => {
    const batch = new ChangeBatch()
    batch.add({ filename: null, now: 0 })
    expect(batch.take()).toEqual({ kind: 'overflow' })
  })
})
