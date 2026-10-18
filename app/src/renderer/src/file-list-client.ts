// 전체 파일 목록 요청 (LIFE-593 F5) — ⌘P 대화상자·탐색기 이름 필터가 같이 쓴다. main `corral:fileList` 를 부르고, (루트, 무시 파일 포함)마다 마지막 목록을 기억한다.
//
// 다시 열 때는 기억한 목록을 바로 보이고 새로 읽는다(목록은 열 때마다 다시 읽는다 — Q8, 열린 동안 실시간 갱신은 하지 않는다). 새 목록이 같으면 같은 객체를 돌려줘
// 색인을 다시 만들지 않는다. 요청마다 id 를 붙이고, 부르는 쪽이 닫히면(대화상자 닫기·worktree 전환) `cancel` 로 main 의 git 자식을 끝낸다(E7ⓓ).
// 수정 r1 — 응답 경로는 NUL 로 이은 문자열이라 여기서 나눈다(R1-C-10). 취소한 요청은 늦게 ok 가 와도 `cancelled` 이고, 같은 키의 더 새 요청이 이미 넣은 목록을
// 앞 요청이 덮지 않는다(R1-G-02 — 요청 순번). 기억하는 목록은 최근 `CACHE_MAX` 개뿐이다(R1-C-07 — 닫은 worktree 의 20만 목록을 계속 쥐지 않게).
import type { FileListResult } from '../../shared/file-list.js'

export type FileListOk = { ok: true; root: string; includeIgnored: boolean; files: string[]; truncated: boolean; ms: number }
export type FileListResponse = FileListOk | Extract<FileListResult, { ok: false }>

const CACHE_MAX = 3
/** 최근 쓴 것이 뒤(Map 삽입 순서 = LRU). */
const cache = new Map<string, FileListOk>()
/** 키별로 목록을 넣은 마지막 요청 순번. */
const applied = new Map<string, number>()
let sequence = 0

const keyOf = (root: string, includeIgnored: boolean): string => `${includeIgnored ? '1' : '0'}\0${root}`

const sameFiles = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

const remember = (key: string, list: FileListOk): void => {
  cache.delete(key)
  cache.set(key, list)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function cachedFileList(input: { root: string; includeIgnored: boolean }): FileListOk | null {
  return cache.get(keyOf(input.root, input.includeIgnored)) ?? null
}

/** 목록을 새로 읽는다. 돌려주는 `cancel` 은 진행 중이면 main 의 자식을 끝낸다(끝난 뒤 부르면 아무것도 안 한다). */
export function requestFileList(input: { root: string; includeIgnored: boolean }): { result: Promise<FileListResponse>; cancel: () => void } {
  sequence += 1
  const seq = sequence
  const requestId = `fl-${Date.now().toString(36)}-${seq}`
  const key = keyOf(input.root, input.includeIgnored)
  let settled = false
  let cancelled = false
  const result = window.corral.fileList({ root: input.root, includeIgnored: input.includeIgnored, requestId }).then(
    (value): FileListResponse => {
      settled = true
      if (cancelled) return { ok: false, code: 'cancelled', error: '취소됨' }
      if (!value.ok) return value
      const files = value.paths === '' ? [] : value.paths.split('\0')
      const list: FileListOk = { ok: true, root: value.root, includeIgnored: value.includeIgnored, files, truncated: value.truncated, ms: value.ms }
      const previous = cache.get(key)
      // 더 새 요청이 이미 넣었으면 그것을 둔다(앞 요청의 늦은 응답).
      if ((applied.get(key) ?? 0) > seq) return previous ?? list
      applied.set(key, seq)
      // 같은 목록이면 앞 객체를 그대로(색인 재사용).
      if (previous !== undefined && sameFiles(previous.files, list.files) && previous.truncated === list.truncated) {
        remember(key, previous)
        return previous
      }
      remember(key, list)
      return list
    },
    (error: unknown): FileListResponse => {
      settled = true
      return { ok: false, code: 'io_error', error: String(error) }
    },
  )
  return {
    result,
    cancel: () => {
      cancelled = true
      if (!settled) window.corral.fileListCancel(requestId)
    },
  }
}
