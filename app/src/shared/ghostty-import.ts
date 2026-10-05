// Ghostty 설정 가져오기 미리보기 모양 (LIFE-513 K4) — main(`main/ghostty/`)이 만들고 렌더러(모달)가 그린다.
// Orca v1.4.198 `shared/global-settings-types.ts` `GhosttyImportPreview` 에 대응한다(MIT, 고지 `src/main/ghostty/NOTICE.md`). 다른 점: found/error 를 상태별 union 으로 나눴고,
// 지원되지 않는 키에 사유를 붙인다(01-criteria K2ⓒ — 값이 corral 칸 검증을 못 넘으면 왜 못 넘었는지 보인다).
import type { Settings } from './terminal-settings.js'

export type GhosttyUnsupportedKey = { key: string; reason: string }

export type GhosttyImportPreview =
  /** 읽을 수 있는 Ghostty 구성 파일이 없다(빈 파일·디렉터리는 없는 것으로 친다 — Ghostty 와 같다). */
  | { status: 'not-found' }
  /** 후보 파일은 있었지만 하나도 읽지 못했다 — 첫 오류 문구. */
  | { status: 'error'; error: string }
  /** `configPaths` = 실제로 읽은 파일(로드 순서), `diff` = 현재 설정과 다른 칸만. */
  | { status: 'found'; configPaths: string[]; diff: Partial<Settings>; unsupported: GhosttyUnsupportedKey[] }
