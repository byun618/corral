// 최근 연 파일 (LIFE-593 E5 · Q5·Q6) — worktree 경로 → 루트 상대 경로 목록(최근이 앞). main(`ui-prefs.ts` 읽기 검사)·렌더러(기록)가 같이 쓴다.
import { isRecord } from './json.js'
import { isSafeRel } from './file-list.js'

/** worktree 하나당 상한(Q5) — 넘으면 오래된 것부터 버린다. */
export const RECENT_FILES_PER_ROOT = 50
/** 기억하는 worktree 수 상한 — 넘으면 가장 오래 안 쓴 worktree 부터 버린다(Orca scope 64 와 같은 결). */
export const RECENT_FILES_ROOTS = 64

export type RecentFiles = Record<string, string[]>

/** 저장된 값을 모양을 보며 읽는다 — 키 = 절대 경로, 값 = 안전한 상대 경로 목록(중복·초과 버림). 손상된 칸은 그 칸만 버린다. */
export function readRecentFiles(value: unknown): RecentFiles {
  if (!isRecord(value)) return {}
  const out: RecentFiles = {}
  const entries = Object.entries(value).filter(([root]) => root.startsWith('/') && !root.includes('\0'))
  for (const [root, list] of entries.slice(-RECENT_FILES_ROOTS)) {
    if (!Array.isArray(list)) continue
    const rels = [...new Set(list.filter((item): item is string => typeof item === 'string' && isSafeRel(item)))].slice(0, RECENT_FILES_PER_ROOT)
    if (rels.length > 0) out[root] = rels
  }
  return out
}

/** 한 파일을 그 worktree 기록 맨 앞으로. 이미 맨 앞이면 같은 객체를 돌려준다(저장 생략). worktree 는 키 순서의 끝(가장 최근)으로 옮긴다. */
export function pushRecentFile(input: { recent: RecentFiles; root: string; rel: string }): RecentFiles {
  const { recent, root, rel } = input
  if (!isSafeRel(rel)) return recent
  const current = recent[root] ?? []
  const keys = Object.keys(recent)
  if (current[0] === rel && keys[keys.length - 1] === root) return recent
  const next: RecentFiles = {}
  for (const key of keys) if (key !== root) next[key] = recent[key] ?? []
  next[root] = [rel, ...current.filter((item) => item !== rel)].slice(0, RECENT_FILES_PER_ROOT)
  const overflow = Object.keys(next).length - RECENT_FILES_ROOTS
  if (overflow > 0) for (const key of Object.keys(next).slice(0, overflow)) delete next[key]
  return next
}

/** 한 파일을 그 worktree 기록에서 뺀다(수정 r2 R2-C-03 — 열어 보니 거절된 경로). 없으면 같은 객체를 돌려준다(저장 생략). 비면 그 worktree 칸을 지운다. */
export function dropRecentFile(input: { recent: RecentFiles; root: string; rel: string }): RecentFiles {
  const current = input.recent[input.root]
  if (current === undefined || !current.includes(input.rel)) return input.recent
  const next: RecentFiles = { ...input.recent }
  const rest = current.filter((item) => item !== input.rel)
  if (rest.length === 0) delete next[input.root]
  else next[input.root] = rest
  return next
}
