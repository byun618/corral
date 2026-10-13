// LIFE-590 E5 — 열린 파일 탭 감시(단위). 실제 파일 시스템 + 짧은 안전망 주기. ⓐ 내용 변경 ⓒ 삭제·다시 생김 ⓓ 감시 유실 주입(폴더 감시가 이벤트를 안 내도
// 안전망 주기 안에 맞는다 — 양성 대조: 같은 시험에서 감시를 끊지 않으면 주기보다 빨리 온다) ⓔ 집합을 비우면 폴더 감시 0 · dispose 뒤 0.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFileWatch, type FileWatch } from './file-watch.js'
import type { FileWatchPush } from '../shared/file-view.js'

let base = ''
let root = ''
let watch: FileWatch | null = null

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l590-fw-')))
  root = path.join(base, 'wt')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'one\n')
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n')
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
afterEach(() => {
  watch?.dispose()
  watch = null
})

function recorder(): {
  pushes: FileWatchPush[]
  add: (push: FileWatchPush) => void
  next: (predicate: (push: FileWatchPush) => boolean, timeoutMs: number) => Promise<{ push: FileWatchPush; ms: number }>
} {
  const pushes: FileWatchPush[] = []
  let waiters: { predicate: (push: FileWatchPush) => boolean; resolve: (push: FileWatchPush) => void }[] = []
  return {
    pushes,
    add: (push) => {
      pushes.push(push)
      const hit = waiters.filter((waiter) => waiter.predicate(push))
      waiters = waiters.filter((waiter) => !hit.includes(waiter))
      for (const waiter of hit) waiter.resolve(push)
    },
    next: (predicate, timeoutMs) => {
      const startedAt = Date.now()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('push 없음')), timeoutMs)
        waiters.push({ predicate, resolve: (push) => { clearTimeout(timer); resolve({ push, ms: Date.now() - startedAt }) } })
      })
    },
  }
}

describe('E5 열린 파일 탭 감시', () => {
  it('처음 넣은 파일은 바로 상태를 민다 — 있는 파일 exists, 없는 파일(복원 때 지워진 파일)은 exists:false', async () => {
    const rec = recorder()
    watch = createFileWatch({ roots: () => [root], push: rec.add, pollMs: 60_000 })
    await watch.set({ root, rels: ['src/a.ts', 'gone.ts'] })
    expect(rec.pushes.map((push) => [push.rel, push.exists])).toEqual([['src/a.ts', true], ['gone.ts', false]])
    // 없는 파일은 가둠(realpath)이 안 돼 폴더 감시를 못 붙인다 — 다시 생기는 것은 안전망 주기가 본다.
    expect(watch.stats()).toEqual({ files: 2, dirWatchers: 1 })
  })

  it('ⓐ 내용이 바뀌면 stamp 가 바뀐 push — 폴더 감시로 주기(60 s)보다 빨리', async () => {
    const rec = recorder()
    watch = createFileWatch({ roots: () => [root], push: rec.add, pollMs: 60_000 })
    await watch.set({ root, rels: ['src/a.ts'] })
    // macOS FSEvents 는 감시를 붙인 직후의 쓰기를 가끔 놓친다(이 시험을 반복해 15회 중 1회 확인 — 2026-10-13). 제품에서는 그 틈을 안전망 주기(1 s)가
    // 맞춘다(ⓓ). 여기서는 폴더 감시 자체를 재므로 자리 잡을 시간을 준다.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const before = rec.pushes[0]?.stamp
    const waiting = rec.next((push) => push.rel === 'src/a.ts' && push.stamp !== before, 3000)
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'two two\n')
    const { push, ms } = await waiting
    expect(push.exists).toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('ⓒ 지우면 exists:false, 같은 경로에 다시 생기면 exists:true', async () => {
    const rec = recorder()
    watch = createFileWatch({ roots: () => [root], push: rec.add, pollMs: 200 })
    await watch.set({ root, rels: ['b.txt'] })
    const gone = rec.next((push) => push.rel === 'b.txt' && !push.exists, 3000)
    fs.rmSync(path.join(root, 'b.txt'))
    await gone
    const back = rec.next((push) => push.rel === 'b.txt' && push.exists, 3000)
    fs.writeFileSync(path.join(root, 'b.txt'), 'again\n')
    await back
  })

  it('ⓓ 감시 유실 주입 — 폴더 감시가 이벤트를 안 내도 안전망 주기(300 ms) 안에 맞는다', async () => {
    const rec = recorder()
    const silent = { opened: 0 }
    watch = createFileWatch({
      roots: () => [root],
      push: rec.add,
      pollMs: 300,
      watchDir: () => {
        silent.opened += 1
        return { close: () => undefined }
      },
    })
    await watch.set({ root, rels: ['src/a.ts'] })
    watch.dropWatchers()
    expect(watch.stats().dirWatchers).toBe(0)
    const before = rec.pushes[0]?.stamp
    const waiting = rec.next((push) => push.rel === 'src/a.ts' && push.stamp !== before, 3000)
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'three three three\n')
    const { ms } = await waiting
    expect(ms).toBeLessThan(300 + 400)
    expect(silent.opened).toBeGreaterThan(0)
  })

  it('ⓔ 집합을 비우면 폴더 감시 0, 같은 폴더 파일 둘은 감시 하나를 나눠 쓴다', async () => {
    watch = createFileWatch({ roots: () => [root], push: () => undefined, pollMs: 60_000 })
    fs.writeFileSync(path.join(root, 'src', 'c.ts'), 'c\n')
    await watch.set({ root, rels: ['src/a.ts', 'src/c.ts'] })
    expect(watch.stats()).toEqual({ files: 2, dirWatchers: 1 })
    await watch.set({ root, rels: ['src/c.ts'] })
    expect(watch.stats()).toEqual({ files: 1, dirWatchers: 1 })
    await watch.set({ root, rels: [] })
    expect(watch.stats()).toEqual({ files: 0, dirWatchers: 0 })
  })

  it('가둠 — 등록 안 된 루트·`..` 탈출은 exists:false 이고 폴더 감시를 붙이지 않는다', async () => {
    const rec = recorder()
    watch = createFileWatch({ roots: () => [root], push: rec.add, pollMs: 60_000 })
    await watch.set({ root, rels: ['../outside.txt'] })
    await watch.set({ root: base, rels: ['wt/b.txt'] })
    expect(rec.pushes.every((push) => !push.exists)).toBe(true)
    expect(watch.stats().dirWatchers).toBe(0)
  })
})

describe('수정 r1 R1-E 감시 목록 교체와 이전 조회가 겹쳐도 감시가 남지 않는다', () => {
  it('리뷰 watch-race 조건 — A 조회 중 빈 집합 → A → 조회 완료 → 빈 집합이면 파일 0·폴더 감시 0', async () => {
    const original = fs.promises.realpath.bind(fs.promises)
    let release = (): void => undefined
    let entered = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const seen = new Promise<void>((resolve) => (entered = resolve))
    let blocked = false
    const spy = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (target) => {
      if (String(target) === root && !blocked) {
        blocked = true
        entered()
        await gate
      }
      return original(target)
    })
    let opened = 0
    let closed = 0
    try {
      watch = createFileWatch({
        roots: () => [root],
        pollMs: 60_000,
        push: () => undefined,
        watchDir: () => {
          opened += 1
          return { close: () => void (closed += 1) }
        },
      })
      const first = watch.set({ root, rels: ['b.txt'] })
      await seen
      await watch.set({ root, rels: [] })
      await watch.set({ root, rels: ['b.txt'] })
      release()
      await first
      expect(watch.stats()).toEqual({ files: 1, dirWatchers: 1 })
      await watch.set({ root, rels: [] })
      expect(watch.stats()).toEqual({ files: 0, dirWatchers: 0 })
      expect({ opened, closed }).toEqual({ opened: 1, closed: 1 })
    } finally {
      spy.mockRestore()
    }
  })
})
