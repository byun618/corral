// 파일 탭 뷰어 (LIFE-590 F2) — main 읽기 전용 내용 IPC 와 렌더러가 같이 쓰는 형·상수. 쓰기 IPC 는 없다(F3).
import type { ExplorerRefusal } from './explorer.js'

/** 텍스트 표시 상한 — 넘으면 내용을 읽지 않고 안내(Orca `MAX_TEXT_FILE_SIZE`, 게이트 ⓪ 고정). main 이 이 이상 읽지 않는다. */
export const TEXT_LIMIT_BYTES = 50 * 1024 * 1024
/** 바이너리 판정 창 — 앞 8 KB 에 NUL 이 있으면 바이너리(Orca·git, 게이트 ⓪ 고정). */
export const BINARY_PROBE_BYTES = 8192
/** VS Code `LARGE_FILE_SIZE_THRESHOLD`(textModel.ts) — 넘으면 Monaco 가 토큰화·접기 등을 끈다(같은 Monaco 코드라 상수가 같다). */
export const LARGE_FILE_BYTES = 20 * 1024 * 1024

/** 내용 읽기 거절 — 가둠 사유(`ExplorerRefusal`)에 파일 쪽 둘을 더한다. */
export type FileReadRefusal = ExplorerRefusal | 'not_file'

/**
 * 한 번 읽은 결과. `bytesRead` = main 이 실제로 읽은 바이트(상한 초과·바이너리 판정이 내용을 넘게 읽지 않았음을 보이는 계측 — E4ⓕ).
 * `stamp` = 읽기 직전 정체·크기·mtime — 외부 변경 판정(E5)이 같은 파일인지 비교한다.
 */
export type FileReadResult =
  | { ok: true; kind: 'text'; text: string; size: number; bytesRead: number; stamp: string }
  | { ok: true; kind: 'binary'; size: number; bytesRead: number; stamp: string }
  | { ok: true; kind: 'too_large'; size: number; limit: number; bytesRead: number; stamp: string }
  | { ok: false; code: FileReadRefusal; error: string }
