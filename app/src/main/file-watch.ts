// 열린 파일 탭 감시 (LIFE-590 E5) — 탐색기 감시(F1 `explorer-hub`)와 따로 둔다: 그쪽은 「패널 열림 + 활성 worktree」·폴더 단위라
// 패널을 닫았거나 탭이 비활성일 때의 변경(E5ⓑ)을 못 본다. 여기는 **열린 파일 탭 집합**만 본다(렌더러가 집합을 통째로 준다 — `set`).
//
// 두 겹: ① 파일의 부모 폴더 `fs.watch`(폴더당 하나, 그 폴더의 열린 파일이 0 이 되면 닫는다) — 변경을 빨리 본다 ② `pollMs`(1 s) 마다 전부 stat — 감시가
// 이벤트를 놓치거나(rename·편집기 원자적 저장·FSEvents 유실) 감시가 끊겨도 안전망 주기 안에 맞는다(E5ⓓ). 판정은 늘 stat 정체(dev:ino:size:mtime)
// 비교라 이벤트 종류를 믿지 않는다 — `file-read.ts` 의 `stamp` 와 같은 글이어서 렌더러가 「마지막으로 읽은 것과 다른가」를 그대로 비교한다.
// 경로는 매번 `confine`(F1 읽기 가둠)으로 다시 가둔다 — 루트가 닫혔거나 밖으로 새는 링크가 되면 `exists: false`(삭제됨 표시)로 본다.
import fs, { type FSWatcher } from 'node:fs'
import path from 'node:path'
import { confine } from './explorer-fs.js'
import type { FileWatchPush } from '../shared/file-view.js'

export const FILE_WATCH_POLL_MS = 1000
/** 한 번에 보는 파일 수 상한 — 열린 탭이 이보다 많으면 앞에서부터만(로그로 남긴다). */
export const FILE_WATCH_MAX = 200

type Entry = { root: string; rel: string; stamp: string | null; dir: string | null }

export type FileWatch = {
  /** 감시할 파일 집합을 통째로 바꾼다. 새로 들어온 파일은 바로 한 번 상태를 민다(복원 때 없는 파일 = 삭제됨, E3ⓔ). */
  set: (input: { root: unknown; rels: unknown }) => Promise<{ ok: boolean; count: number }>
  /** 폴더 감시를 전부 끊는다 — 감시 유실 주입(E5ⓓ). 안전망 주기는 계속 돈다. 다음 `set` 이 다시 붙인다. */
  dropWatchers: () => void
  stats: () => { files: number; dirWatchers: number }
  dispose: () => void
}

export function createFileWatch(input: {
  roots: () => readonly string[]
  push: (event: FileWatchPush) => void
  log?: (tag: string, data: Record<string, unknown>) => void
  pollMs?: number
  /** 시험이 바꿔 끼운다. */
  watchDir?: (dir: string, onEvent: () => void) => { close: () => void }
}): FileWatch {
  const entries = new Map<string, Entry>()
  const dirs = new Map<string, { watcher: { close: () => void }; count: number }>()
  const watchDir =
    input.watchDir ??
    ((dir: string, onEvent: () => void) => {
      const watcher: FSWatcher = fs.watch(dir, { persistent: false }, () => onEvent())
      watcher.on('error', () => undefined)
      return watcher
    })
  let disposed = false
  let checking = false
  let again = false

  const stampOf = async (entry: Entry): Promise<{ stamp: string | null; abs: string | null }> => {
    const confined = await confine({ roots: input.roots(), root: entry.root, rel: entry.rel })
    if (!confined.ok) return { stamp: null, abs: null }
    try {
      const stat = await fs.promises.stat(confined.abs)
      return stat.isFile() ? { stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, abs: confined.abs } : { stamp: null, abs: confined.abs }
    } catch {
      return { stamp: null, abs: confined.abs }
    }
  }

  const attach = (entry: Entry, abs: string | null): void => {
    // 가둔 실경로가 있을 때만 붙인다. 파일이 없으면 가둠(realpath)이 안 돼 감시를 떼고, 같은 경로에 다시 생기는 것(E5ⓒ)은 안전망 주기가 본다.
    const dir = abs === null ? null : path.dirname(abs)
    if (dir === entry.dir) return
    detach(entry)
    if (dir === null) return
    const existing = dirs.get(dir)
    if (existing !== undefined) existing.count += 1
    else {
      try {
        dirs.set(dir, { watcher: watchDir(dir, () => void check(dir)), count: 1 })
      } catch {
        return // 폴더가 없으면 안전망 주기가 본다
      }
    }
    entry.dir = dir
  }

  const detach = (entry: Entry): void => {
    const dir = entry.dir
    if (dir === null) return
    entry.dir = null
    const row = dirs.get(dir)
    if (row === undefined) return
    row.count -= 1
    if (row.count <= 0) {
      row.watcher.close()
      dirs.delete(dir)
    }
  }

  /** 한 폴더(또는 전부)의 파일을 다시 stat 해 바뀐 것만 민다. 겹쳐 돌지 않는다 — 돌던 중 온 요청은 끝난 뒤 전부 한 번 더 본다. */
  const check = async (dir: string | null): Promise<void> => {
    if (disposed) return
    if (checking) {
      again = true
      return
    }
    checking = true
    try {
      for (const entry of [...entries.values()]) {
        if (dir !== null && entry.dir !== dir) continue
        const next = await stampOf(entry)
        if (!entries.has(keyOf(entry))) continue
        attach(entry, next.abs)
        if (next.stamp === entry.stamp) continue
        entry.stamp = next.stamp
        input.push({ root: entry.root, rel: entry.rel, exists: next.stamp !== null, stamp: next.stamp })
      }
    } finally {
      checking = false
    }
    if (again) {
      again = false
      await check(null)
    }
  }

  const timer = setInterval(() => void check(null), input.pollMs ?? FILE_WATCH_POLL_MS)
  timer.unref?.()

  const keyOf = (entry: { root: string; rel: string }): string => `${entry.root}\0${entry.rel}`

  return {
    set: async ({ root, rels }) => {
      if (typeof root !== 'string' || !Array.isArray(rels)) return { ok: false, count: entries.size }
      const wanted = rels.filter((rel): rel is string => typeof rel === 'string').slice(0, FILE_WATCH_MAX)
      if (rels.length > FILE_WATCH_MAX) input.log?.('file.watch_cap', { requested: rels.length, max: FILE_WATCH_MAX })
      const keys = new Set(wanted.map((rel) => keyOf({ root, rel })))
      for (const [key, entry] of entries) {
        if (keys.has(key)) continue
        detach(entry)
        entries.delete(key)
      }
      const added: Entry[] = []
      for (const rel of wanted) {
        const key = keyOf({ root, rel })
        if (entries.has(key)) continue
        const entry: Entry = { root, rel, stamp: null, dir: null }
        entries.set(key, entry)
        added.push(entry)
      }
      for (const entry of added) {
        const next = await stampOf(entry)
        if (!entries.has(keyOf(entry))) continue
        attach(entry, next.abs)
        entry.stamp = next.stamp
        input.push({ root: entry.root, rel: entry.rel, exists: next.stamp !== null, stamp: next.stamp })
      }
      // 감시가 끊겼던(dropWatchers) 파일도 다시 붙인다.
      for (const entry of entries.values()) if (entry.dir === null && entry.stamp !== null) attach(entry, (await stampOf(entry)).abs)
      return { ok: true, count: entries.size }
    },
    dropWatchers: () => {
      for (const row of dirs.values()) row.watcher.close()
      dirs.clear()
      for (const entry of entries.values()) entry.dir = null
    },
    stats: () => ({ files: entries.size, dirWatchers: dirs.size }),
    dispose: () => {
      disposed = true
      clearInterval(timer)
      for (const row of dirs.values()) row.watcher.close()
      dirs.clear()
      entries.clear()
    },
  }
}
