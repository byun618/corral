// 파일 탭 뷰어 (LIFE-590 F2) · 편집 (LIFE-591 F3) — main 내용 IPC(읽기 `file-read.ts` · 쓰기 `file-write.ts`)와 렌더러가 같이 쓰는 형·상수.
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
 * 텍스트(LIFE-591 E1ⓕ) — `text` 는 BOM 을 뺀 내용이고 `bom` 이 그 유무다(저장이 다시 붙인다). `utf8` = 손실 없이 UTF-8 로 디코드됐나
 * (false 면 `text` 에 대체 문자가 섞였다 — 렌더러는 읽기 전용으로 연다, 게이트 ⓪ Q4). `nlink` = 하드링크 수(1 넘으면 편집하지 않는다 — E6ⓑ⑪).
 * `hash` = 읽은 바이트(BOM 포함) sha256 — 저장 시점 충돌 검사의 내용 지문(수정 r1 R1-C: 같은 크기·같은 mtime 의 다른 내용은 stamp 로 못 가른다).
 */
export type FileReadResult =
  | { ok: true; kind: 'text'; text: string; bom: boolean; utf8: boolean; nlink: number; size: number; bytesRead: number; stamp: string; hash: string }
  | { ok: true; kind: 'binary'; size: number; bytesRead: number; stamp: string }
  | { ok: true; kind: 'too_large'; size: number; limit: number; bytesRead: number; stamp: string }
  | { ok: false; code: FileReadRefusal; error: string }

/** 열린 파일 탭 외부 변경 push(E5) — `stamp` 는 `FileReadResult.stamp` 와 같은 글(없으면 null = 없음·가둠 밖). */
export type FileWatchPush = { root: string; rel: string; exists: boolean; stamp: string | null }

/**
 * 이미지로 여는 확장자(E4ⓔ) — VS Code `extensions/media-preview/package.json` 의 imagePreview.previewEditor 선택자(1.142)와 같은 목록. 값은 MIME.
 * `.svg` 는 텍스트이기도 하다 — VS Code 처럼 이미지 미리보기로 연다.
 */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpe: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

export function imageMimeOf(rel: string): string | null {
  const name = rel.split('/').pop() ?? rel
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null
}

export type ImageReadResult =
  | { ok: true; kind: 'image'; mime: string; bytes: Uint8Array; size: number; bytesRead: number; stamp: string }
  | { ok: true; kind: 'too_large'; size: number; limit: number; bytesRead: number; stamp: string }
  | { ok: false; code: FileReadRefusal; error: string }

/**
 * 저장 요청(LIFE-591 E2·E6). `text` 는 줄끝까지 직렬화한 내용(BOM 제외) — main 이 `bom` 이면 EF BB BF 를 앞에 붙여 UTF-8 로 쓴다.
 * `baseStamp` = 이 내용이 기대는 디스크 정체(마지막으로 읽거나 저장한 stamp) — 디스크가 그와 다르면 `overwrite` 가 아닌 한 쓰지 않는다(E4ⓒ).
 * `baseHash` = 그 내용의 바이트 sha256(읽기·저장이 돌려준 `hash`) — stamp 가 같아도 디스크 바이트 지문이 다르면 쓰지 않는다(수정 r1 R1-C).
 * `create` = 지워진 파일을 같은 경로에 다시 만든다(E4ⓓ — 사용자가 「다시 만들기」 를 고른 뒤에만).
 */
export type FileWriteInput = { root: string; rel: string; text: string; bom: boolean; baseStamp: string | null; baseHash: string | null; overwrite: boolean; create: boolean }

/** 쓰기 거절 — 읽기 가둠 사유에 쓰기 쪽을 더한다. 각 코드가 어느 검사에서 났는지가 양성 대조(E6ⓑ)의 근거다. */
export type FileWriteRefusal =
  | FileReadRefusal
  | 'too_large' // 내용이 상한(`TEXT_LIMIT_BYTES`)을 넘는다 — main 이 다시 잰다(E6ⓓ)
  | 'hardlink' // 연 fd 의 nlink > 1 — 다른 이름(밖일 수 있다)과 같은 inode(E6ⓑ⑪)
  | 'permission_denied' // 쓰기 권한 없음(EACCES·EPERM) — 열기에서 났고 아무것도 쓰지 않았다(E2ⓔ)
  | 'exists' // 다시 만들려는데 그 사이 같은 이름이 생겼다(E4ⓓ)

export type FileWriteResult =
  /** `stamp`·`hash` = 쓴 뒤 같은 fd 로 다시 읽어 **쓴 바이트와 같음을 확인한** 디스크 상태(수정 r1 R1-B). */
  | { ok: true; stamp: string; hash: string; size: number }
  | { ok: false; code: FileWriteRefusal; error: string }
  /**
   * 디스크가 `baseStamp`·`baseHash` 와 다르다 — 아무것도 쓰지 않았다(E4ⓒ). `written: true` = 썼지만 끝에 다시 읽어 보니 다른 내용이었다
   * (쓰는 사이 외부 쓰기가 끼었다 — 수정 r1 R1-B). 어느 쪽이든 렌더러는 저장된 것으로 치지 않고 「덮어쓰기 / 취소」 를 묻는다.
   */
  | { ok: false; code: 'conflict'; error: string; diskStamp: string; written?: boolean }
  /** 쓰는 도중 실패 — `bytesWritten` 만큼 이미 덮었을 수 있다(E2ⓔ 「실패가 쓰기 도중이면 그 결과를 그대로 기록」). */
  | { ok: false; code: 'write_failed'; error: string; bytesWritten: number }

/** 수정된 파일 하나(main 이 종료 확인에 쓴다 — E3ⓒ). */
export type DirtyFile = { root: string; rel: string }

/**
 * 파일 탭 확인 대화상자(OS 기본 `dialog.showMessageBox` — main 이 문구를 만든다). 갈래마다 고를 수 있는 답이 다르다.
 *   · close — 수정된 탭 닫기·앱 종료·worktree 닫기(E3ⓑ): 저장 / 저장 안 함 / 취소
 *   · conflict — 저장 시점 충돌(E4ⓒ): 덮어쓰기 / 취소
 *   · recreate — 지워진 파일 저장(E4ⓓ): 다시 만들기 / 취소
 *   · discard — worktree 삭제(E3ⓓ): 버리고 계속 / 취소(지울 파일을 저장할 수는 없다)
 * 렌더러 다시 불러오기(E3ⓕ) 확인은 main 이 `will-prevent-unload` 에서 직접 띄운다(렌더러가 묻지 않는다).
 */
export type FileDialogRequest =
  | { kind: 'close'; files: string[] }
  | { kind: 'conflict'; file: string }
  | { kind: 'recreate'; file: string }
  | { kind: 'discard'; files: string[] }
export type FileDialogChoice = 'save' | 'discard' | 'cancel' | 'overwrite' | 'recreate'
