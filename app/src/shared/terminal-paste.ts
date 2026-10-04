// 터미널 이미지 붙여넣기·파일 드롭의 **순수 계산** (LIFE-497 · D41·D43).
//
// 정답 동작 = Orca v1.4.220 (`terminal-bracketed-paste.ts`·`terminal-drop-image-path.ts`·
// `terminal-drop-path-writer.ts`·`pane-helpers.ts`·`image-file-extensions.ts`). corral 에 없는 갈래
// (Windows·SSH·WSL·composer·runtime-owned paste)는 옮기지 않았다 — D45 의도적. 그래서 대상 셸은 POSIX 하나다.
//
// 렌더러(⌘V·드롭 페이로드 조립)와 preload(드롭 상한)가 같이 쓴다. Node·DOM 에 기대지 않는다.

const ESCAPE = '\u001b'
export const BRACKETED_PASTE_START = `${ESCAPE}[200~`
export const BRACKETED_PASTE_END = `${ESCAPE}[201~`

/** preload 드롭 상한 — 넘으면 한 경로도 보내지 않고 거부한다 (Orca `NATIVE_FILE_DROP_MAX_PATHS`). */
export const FILE_DROP_MAX_PATHS = 256

/**
 * **강제** bracketed paste — 앱의 2004 모드 비트와 무관하게 `ESC[200~ … ESC[201~` 로 싼다.
 *
 * 생성한 이미지 경로는 한 줄이어도 "붙여넣기 페이로드"다. Claude Code·Codex 는 bracketed paste 로 온
 * 경로만 첨부로 올린다(00-analysis §5) — 모드 비트를 따르면 비트가 꺼진 순간 경로가 타건으로 간다.
 * 안쪽 ESC 는 U+241B 로 바꾼다(끼어든 `ESC[201~` 가 틀을 일찍 닫고 꼬리를 키 입력으로 돌리지 않게).
 * 줄바꿈은 xterm 의 네이티브 붙여넣기처럼 CR 로 맞춘다.
 */
export function wrapBracketedPaste(text: string): string {
  const normalized = text.replace(/\r?\n/g, '\r')
  return `${BRACKETED_PASTE_START}${normalized.split(ESCAPE).join('\u241b')}${BRACKETED_PASTE_END}`
}

/** Orca `IMAGE_FILE_EXTENSIONS` (220) 그대로. */
export const IMAGE_FILE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']

/** 확장자는 **파일 이름**에 있어야 한다 — `/home/jane.png/photo` 같은 디렉터리 점은 이미지가 아니다. */
export function isImageDropPath(path: string): boolean {
  const lastDot = path.lastIndexOf('.')
  if (lastDot === -1) return false
  if (lastDot < path.lastIndexOf('/')) return false
  return IMAGE_FILE_EXTENSIONS.includes(path.slice(lastDot).toLowerCase())
}

// ASCII 공백도 위험하다 — Codex 는 raw 경로를 shlex 로 쪼개 여러 조각이면 텍스트로 둔다 (220 주석).
const RAW_IMAGE_DROP_UNSAFE_RE = /[ "'`$;&|<>(){}[\]*?!#\\]/

function hasControlByte(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function canPasteImageDropPathRaw(path: string): boolean {
  return !hasControlByte(path) && !RAW_IMAGE_DROP_UNSAFE_RE.test(path)
}

/**
 * 이미지 드롭의 bracketed paste 안쪽 글자. 붙여넣기 틀이 경로를 바꿔 버리는 경우(제어 바이트)는 null —
 * 호출자가 비이미지처럼 셸 이스케이프 타건으로 보낸다.
 *
 * 위험 글자가 있으면 POSIX 싱글쿼트가 아니라 **백슬래시** 이스케이프다(220): Claude Code 는 바깥 따옴표
 * 한 쌍만 벗기므로 `'\''` 조각이 경로에 새고, 백슬래시는 Claude·Codex·셸 모두에서 왕복한다.
 */
export function formatImageDropPasteText(path: string): string | null {
  if (hasControlByte(path)) return null
  if (canPasteImageDropPathRaw(path)) return path
  return path.replace(/[^a-zA-Z0-9_./@:\-\u0080-\uffff]/g, '\\$&')
}

/** 비이미지 드롭 = POSIX 싱글쿼트 이스케이프 (Orca `shellEscapePath` posix 갈래). */
export function shellEscapePath(path: string): string {
  if (/^[a-zA-Z0-9_./@:-]+$/.test(path)) return path
  return `'${path.replace(/'/g, "'\\''")}'`
}

/**
 * 드롭한 경로들 → pane 에 **차례로** 쓸 페이로드 (경로 하나 = 페이로드 하나).
 *
 * 이미지 = bracketed paste 하나(끝 공백 없음). 다음 경로가 오면 공백 1개를 붙이되, **둘 다 raw 이미지**일
 * 때만 뺀다 — bracketed paste 끼리는 스스로 구분되고 그 사이 공백은 TUI 입력에 남는다. 한쪽이라도
 * 이스케이프됐으면 남긴다: 셸은 붙여넣기 경계를 모르므로 `/a\ \(1\).png/b.png` 가 한 인자가 된다.
 * 비이미지 = 싱글쿼트 이스케이프 + 공백 (`terminal-drop-path-writer.ts`).
 */
export function dropPathPayloads(paths: readonly string[]): string[] {
  return paths.map((path, index) => {
    const imageText = isImageDropPath(path) ? formatImageDropPasteText(path) : null
    if (imageText === null) return `${shellEscapePath(path)} `
    const next = paths[index + 1]
    const bothRaw = imageText === path && next !== undefined && isImageDropPath(next) && canPasteImageDropPathRaw(next)
    const separate = next !== undefined && !bothRaw
    return `${wrapBracketedPaste(imageText)}${separate ? ' ' : ''}`
  })
}

/**
 * ⌘V 의 갈림 — 클립보드에 **텍스트가 있으면 텍스트**(xterm 의 평소 붙여넣기), 없을 때만 이미지를 찾는다.
 * Orca `pasteTerminalClipboard` 의 순서 그대로다.
 */
export function shouldPasteClipboardImage(clipboardText: string): boolean {
  return clipboardText.length === 0
}

/** main 이 쓴 PNG 경로 → pane 에 쓸 바이트. 저장이 안 됐으면(빈 클립보드·실패) 아무것도 보내지 않는다 (K1ⓓ). */
export function clipboardImagePayload(
  result: { status: 'saved'; path: string } | { status: 'empty' } | { status: 'failed'; error: string },
): string | null {
  return result.status === 'saved' ? wrapBracketedPaste(result.path) : null
}
