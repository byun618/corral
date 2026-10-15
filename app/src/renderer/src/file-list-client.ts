// 전체 파일 목록 요청 (LIFE-593 F5) — ⌘P 대화상자·탐색기 이름 필터가 같이 쓴다. main `corral:fileList` 를 부르고, (루트, 무시 파일 포함)마다 마지막 목록을 기억한다.
//
// 다시 열 때는 기억한 목록을 바로 보이고 새로 읽는다(목록은 열 때마다 다시 읽는다 — Q8, 열린 동안 실시간 갱신은 하지 않는다). 새 목록이 같으면 같은 객체를 돌려줘
// 색인을 다시 만들지 않는다. 요청마다 id 를 붙이고, 부르는 쪽이 닫히면(대화상자 닫기·worktree 전환) `cancel` 로 main 의 git 자식을 끝낸다(E7ⓓ).
import type { FileListResult } from '../../shared/file-list.js'

export type FileListOk = Extract<FileListResult, { ok: true }>

const cache = new Map<string, FileListOk>()
let sequence = 0

const keyOf = (root: string, includeIgnored: boolean): string => `${includeIgnored ? '1' : '0'}\0${root}`

const sameFiles = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
  return true
}

export function cachedFileList(input: { root: string; includeIgnored: boolean }): FileListOk | null {
  return cache.get(keyOf(input.root, input.includeIgnored)) ?? null
}

/** 목록을 새로 읽는다. 돌려주는 `cancel` 은 진행 중이면 main 의 자식을 끝낸다(끝난 뒤 부르면 아무것도 안 한다). */
export function requestFileList(input: { root: string; includeIgnored: boolean }): { result: Promise<FileListResult>; cancel: () => void } {
  sequence += 1
  const requestId = `fl-${Date.now().toString(36)}-${sequence}`
  let settled = false
  const result = window.corral.fileList({ root: input.root, includeIgnored: input.includeIgnored, requestId }).then(
    (value) => {
      settled = true
      if (!value.ok) return value
      const key = keyOf(input.root, input.includeIgnored)
      const previous = cache.get(key)
      // 같은 목록이면 앞 객체를 그대로(색인 재사용).
      if (previous !== undefined && sameFiles(previous.files, value.files) && previous.truncated === value.truncated) return previous
      cache.set(key, value)
      return value
    },
    (error: unknown): FileListResult => {
      settled = true
      return { ok: false, code: 'io_error', error: String(error) }
    },
  )
  return {
    result,
    cancel: () => {
      if (!settled) window.corral.fileListCancel(requestId)
    },
  }
}
