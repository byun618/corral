// 탐색기 파일 조작 (LIFE-592 F4) — main·렌더러가 같이 쓰는 모양과 순수 규칙(이름 검증·복제 이름·경로 재지정).
//
// 조작은 전부 main 한 핸들러(`corral:explorerOp`)로 간다 — 렌더러는 (루트, 상대 경로, 이름)만 주고 가둠·덮어쓰기 금지·휴지통은 main(`main/explorer-ops.ts`)이 한다.
// 실행 취소 기록은 렌더러(worktree 별 메모리 — `renderer/src/explorer-history.ts`), 삭제 전 내용 사본은 main 메모리(사본 id 로만 가리킨다 — 렌더러가 되살릴 내용을 만들지 못하게).
import type { ExplorerRefusal } from './explorer.js'

/** 삭제 실행 취소로 되살릴 수 있는 파일 크기 상한(Q1 — VS Code `bulkFileEdits` 와 같은 5 MB). 폴더·큰 파일은 실행 취소 항목을 만들지 않는다. */
export const UNDO_SNAPSHOT_LIMIT = 5 * 1024 * 1024
/** worktree 별 실행 취소 단계 상한(Orca 50 과 같다). 넘으면 가장 오래된 것부터 버린다. */
export const UNDO_HISTORY_LIMIT = 50
/** 이름 한 성분 상한(APFS NAME_MAX — 바이트). */
export const NAME_MAX_BYTES = 255

/**
 * 조작 거절 사유 — 탐색기 공통(`ExplorerRefusal`) + 조작 몫. 양성 대조(E9ⓒ)가 「그 검사에서 났다」 를 이 코드로 보인다.
 *   exists       대상 자리에 이미 무엇이 있다(덮어쓰기 0 — Q7)
 *   invalid_name 이름 규칙 위반(빈 이름·`.`·`..`·NUL·`/`·255 바이트 초과·앞뒤 공백)
 *   protected    루트 자체·`.git`(어느 깊이든) — 조작 대상이 될 수 없다
 *   into_self    폴더를 자기 자신·자기 하위로 옮기기
 *   not_file     일반 파일·폴더·링크가 아니다(FIFO·소켓·장치)
 *   expired      실행 취소용 내용 사본이 메모리에 없다(앱 재시작·상한 초과로 버림)
 *   modified     실행 취소 대상이 만든 뒤 바뀌었다(VS Code `confirmBeforeUndo` 대신 거절 — 휴지통으로도 보내지 않는다)
 *   bad_token    가져오기 원본 표지가 없거나 이미 썼다·재생 근거를 놓았다(렌더러가 원본 경로를 만들 수 없게 — E7ⓓ)
 *   trash_failed `shell.trashItem` 실패 — 영구 삭제로 넘어가지 않는다(E3ⓒⓕ)
 *   permission_denied 쓰기 권한 없음
 */
export type ExplorerOpRefusal = ExplorerRefusal | 'exists' | 'invalid_name' | 'protected' | 'into_self' | 'not_file' | 'expired' | 'modified' | 'bad_token' | 'trash_failed' | 'permission_denied'

/** 정체(dev:ino)와 도장(dev:ino:size:mtime:mode — 폴더는 밑 전부) — 실행 취소가 「그때 그 항목인가」·「그 뒤 바뀌었나」 를 본다. */
export type EntryMark = { rel: string; stamp: string }
/** 도장을 만들 수 없던 항목(읽을 수 없는 하위 폴더 등 — 수정 r2 R2-G). 이 표지의 실행 취소는 「바뀜 확인 불가」 로 거절된다. */
export const UNVERIFIABLE = 'unverifiable'

/** 항목 종류(링크는 링크 자체 — 따라가지 않는다). */
export type EntryKind = 'file' | 'dir' | 'link'

/** 렌더러 → main 조작 요청(경로는 전부 루트 기준 상대, `/` 구분). */
export type ExplorerOpInput =
  /** 새 파일·폴더 — `name` 에 `/` 가 있으면 중간 폴더까지 만든다(VS Code 와 같다). */
  | { op: 'create'; root: string; dir: string; name: string; kind: 'file' | 'dir' }
  /** 이름 변경·이동(같은 연산 — 대상 자리가 비어 있어야 한다, 대소문자만 바꾸기는 허용). `expect` = 실행 취소·다시 실행이 그 항목인지 확인할 정체. */
  | { op: 'move'; root: string; from: string; to: string; expect?: string }
  /** 삭제 = 휴지통. `snapshot` 이면 파일 ≤ 5 MB 의 내용을 사본으로 남긴다(실행 취소용). `expect` = 실행 취소(만들기 되돌리기)가 확인할 도장들(바뀌었으면 거절). */
  | { op: 'trash'; root: string; rel: string; snapshot: boolean; expect?: EntryMark[] }
  /** 사본으로 다시 만들기(삭제 실행 취소·만들기 다시 실행) — 대상 자리가 비어 있어야 한다. */
  | { op: 'restore'; root: string; rel: string; snapshotId: string }
  /**
   * 같은 부모에 「<이름> copy」 로 복제. `again` = 다시 실행 재생(수정 r2 R2-D) — 원래 사본 이름(`name`)에만 만들고(차 있으면 `exists`),
   * 원본 도장이 원래 복제 때(`source`)와 다르면 `modified`.
   */
  | { op: 'duplicate'; root: string; rel: string; again?: { name: string; source: string } }
  /** OS 드롭 가져오기 — 원본은 preload 가 main 에 직접 넘긴 표지(`token`)로만 가리킨다. */
  | { op: 'import'; root: string; dir: string; token: string }
  /**
   * 가져오기 다시 실행(수정 r2 R2-D·R2-E) — main 이 붙잡은 재생 근거(`replay` id)의 원본 중 `names`(원래 만든 이름)만, 그 이름 그대로 다시 가져온다.
   * 자리가 차 있으면 `exists`, 원본이 원래 가져오기 뒤 바뀌었으면 `modified` — 둘 다 아무것도 만들지 않는다.
   */
  | { op: 'import'; root: string; dir: string; replay: string; names: string[] }
  /** 실행 취소 기록에서 빠진 재생 근거를 main 에서 놓는다(R2-E). */
  | { op: 'release'; ids: string[] }
  /** 삭제 확인 전에 종류·크기를 본다(대화상자 문구 — 실행 취소 가능 여부). 읽기만. */
  | { op: 'inspect'; root: string; rel: string }

export type ExplorerOpResult =
  | { ok: true; op: 'create'; rel: string; kind: 'file' | 'dir'; created: string; marks: EntryMark[] }
  | { ok: true; op: 'move'; from: string; to: string; id: string }
  | { ok: true; op: 'trash'; rel: string; kind: EntryKind; snapshotId: string | null }
  | { ok: true; op: 'restore'; rel: string; marks: EntryMark[]; hash: string | null; stamp: string | null }
  /**
   * `from` = 복제 원본, `source` = 복제 직전 원본 도장(다시 실행 재생이 원본이 그대로인지 본다 — R1-G·R2-D). `failed` = 폴더 안 일부 실패(만든 것은 남고 실행 취소 대상 — R1-H).
   * `skipped` = 폴더 안 특수 파일(FIFO·소켓·장치)·하드링크 안내 — 사본에 들지 않은 것을 알린다(점검 표 M-2).
   * `marks` 의 도장이 `UNVERIFIABLE` 이면 바뀜을 확인할 수 없는 항목(R2-G) — 실행 취소는 거절된다.
   */
  | { ok: true; op: 'duplicate'; from: string; rel: string; kind: EntryKind; marks: EntryMark[]; skipped: { name: string; reason: string }[]; failed: { name: string; error: string }[]; source: string }
  /**
   * `rels` = 이번 가져오기가 **실제로 만든** 항목만(만든 순간의 정체로 묶음 — 수정 r2 R2-A). 건너뛴 것은 `skipped` 에만.
   * `partial` = 만들었지만 도중 실패해 내용이 덜 든 항목(rels 의 부분집합 — 실행 취소 대상에 든다, R1-H).
   * `replayId` = main 이 붙잡은 재생 근거(다시 실행 — R2-E). 실행 취소 기록이 그것을 가리키는 동안 남고, 기록에서 빠지면 렌더러가 `release` 로 놓는다(시간 제한 없음).
   */
  | { ok: true; op: 'import'; dir: string; rels: string[]; marks: EntryMark[][]; skipped: { name: string; reason: string }[]; failed: { name: string; error: string }[]; partial: string[]; replayId: string | null }
  | { ok: true; op: 'release' }
  | { ok: true; op: 'inspect'; rel: string; kind: EntryKind; size: number; undoable: boolean }
  /** `done` = 경로 연산은 끝났지만 사후 확인이 어긋났다(Q8 잔여 — `raw/claude/residual.md`). 렌더러는 목록을 다시 읽고 안내한다. */
  | { ok: false; code: ExplorerOpRefusal; error: string; done?: boolean }

/** preload → main: 실제 드롭에서 온 경로를 맡기고 받은 표지. */
export type ExplorerDropRegistration = { ok: true; token: string; names: string[] } | { ok: false; error: string }

/** preload → 렌더러: 탐색기에 파일이 떨어졌다(경로는 싣지 않는다 — 이름과 표지만). */
export type ExplorerDrop = { token: string; root: string; dir: string; names: string[] } | { token: null; root: string; dir: string; error: string }

// --- 이름 규칙 (순수 — 렌더러가 입력 행에 안내하고, main 이 다시 잰다) --------------------------------------------

const utf8Length = (text: string): number => new TextEncoder().encode(text).length

/**
 * 한 성분 이름 검사. 문구는 입력 행 안내(한국어). null = 통과.
 * 앞뒤 공백은 **거절**한다 — VS Code 는 경고만 하고 만든다(`fileNameWhitespaceWarning`). corral 은 디스크를 바꾸지 않는 쪽(01-criteria E1ⓒ)을 골랐다.
 */
export function nameError(name: string): string | null {
  if (name.length === 0 || /^\s+$/.test(name)) return '파일 또는 폴더 이름을 입력해야 합니다.'
  if (name === '.' || name === '..') return `'${name}' 은(는) 파일 또는 폴더 이름으로 쓸 수 없습니다.`
  if (name.includes('\0')) return '이름에 NUL 문자를 쓸 수 없습니다.'
  if (name.includes('/')) return "이름에 '/' 를 쓸 수 없습니다."
  if (utf8Length(name) > NAME_MAX_BYTES) return `이름이 너무 깁니다(${NAME_MAX_BYTES} 바이트 초과).`
  if (/^\s|\s$/.test(name)) return '이름 앞뒤에 공백을 둘 수 없습니다.'
  return null
}

/**
 * 만들기 입력(`a/b/c.ts` 허용) → 성분들. 앞 `/`·빈 성분(`a//b`·끝 `/`)·`.`·`..` 성분은 거절(VS Code `fileNameStartsWithSlashError` 등과 같은 결).
 * 렌더러 안내와 main 재검사가 같은 함수를 쓴다.
 */
export function splitNewName(input: string): { ok: true; parts: string[] } | { ok: false; error: string } {
  if (input.startsWith('/')) return { ok: false, error: "이름은 '/' 로 시작할 수 없습니다." }
  const parts = input.split('/')
  for (const part of parts) {
    const error = part.length === 0 && parts.length > 1 ? "빈 폴더 이름이 있습니다('//' 또는 끝 '/')." : nameError(part)
    if (error !== null) return { ok: false, error }
  }
  return { ok: true, parts }
}

/** 대소문자를 무시하고 같은 이름인가(APFS 기본 — 대소문자 무시). NFC 로 맞춘 뒤 비교한다. */
export const sameNameIgnoringCase = (a: string, b: string): boolean => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()

/**
 * 조작 대상이 될 수 없는 경로 — 루트 자체·`.git` 성분(어느 깊이든 — worktree 의 `.git` 파일 포함). 이름은 **대소문자 무시**(APFS — `.GIT`·`.Git` 도 같은 곳, 수정 r1 R1-B).
 * 이것은 들어온 문자열만 본다 — main 은 링크를 푼 실제 위치로 한 번 더 본다(`explorer-ops.ts` `insideGit`).
 */
export const isGitName = (name: string): boolean => sameNameIgnoringCase(name, '.git')
export function isProtectedRel(rel: string): boolean {
  return rel === '' || rel.split('/').some(isGitName)
}

/** 확장자 — 첫 글자 점(`.gitignore`)은 확장자가 아니다(Node `path.extname` · VS Code `extname` 과 같다). */
function extOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.slice(index)
}

/**
 * 복제·가져오기 충돌 이름 — VS Code `incrementFileName(simple)` 그대로: `a.ts` → `a copy.ts` → `a copy 2.ts` → `a copy 3.ts` …(폴더는 확장자를 가르지 않는다).
 * `taken` 은 대소문자 무시로 본다(APFS). 다음 이름을 차례로 시험해 비어 있는 첫 이름.
 */
export function copyName(input: { name: string; isDir: boolean; taken: (name: string) => boolean }): string {
  let name = input.name
  for (let guard = 0; guard < 10_000; guard += 1) {
    if (guard > 0 || input.taken(name)) name = nextCopyName(name, input.isDir)
    if (!input.taken(name)) return name
  }
  return name
}

export function nextCopyName(name: string, isDir: boolean): string {
  const ext = isDir ? '' : extOf(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  const match = /^(.+ copy)( \d+)?$/.exec(stem)
  if (match !== null) {
    const number = match[2] === undefined ? 1 : Number.parseInt(match[2], 10)
    return `${match[1]} ${number + 1}${ext}`
  }
  return `${stem} copy${ext}`
}

// --- 경로 재지정 (열린 탭·펼침·선택이 이름 변경·이동을 따라간다 — E4) --------------------------------------------

/** `rel` 이 `from` 자신이거나 그 밑이면 `to` 쪽으로 옮긴 경로, 아니면 null. */
export function remapRel(rel: string, from: string, to: string): string | null {
  if (rel === from) return to
  if (from !== '' && rel.startsWith(`${from}/`)) return `${to}${rel.slice(from.length)}`
  return null
}

/** `rel` 이 `base` 자신이거나 그 밑인가. */
export const isAtOrUnder = (rel: string, base: string): boolean => rel === base || base === '' || rel.startsWith(`${base}/`)

export const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)
