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
 * ⌘V 의 갈림 — 클립보드에 **텍스트가 있으면 텍스트**, 없을 때만 이미지를 찾는다.
 * Orca `pasteTerminalClipboard` 의 순서 그대로다.
 */
export function shouldPasteClipboardImage(clipboardText: string): boolean {
  return clipboardText.length === 0
}

/**
 * herdr 0.9.0 이 Paste 한 번에 받는 본문 상한(UTF-8 바이트). 넘으면 거절하고 아무것도 쓰지 않는다 — 연결은 남는다.
 * 실측: `oversized targeted pane paste, rejecting … size=4194304 max=1048576`, 1048576 바이트는 통과
 * (specs/LIFE-505-bracketed-paste/raw/claude/iso/after-L1·after-L0).
 */
export const HERDR_PASTE_MAX_BYTES = 1024 * 1024

const utf8Length = (codePoint: number): number => (codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4)

/**
 * ⌘V 텍스트 → pane 에 **차례로** 쓸 페이로드 (LIFE-505). **한 줄이어도 늘** 강제 bracketed paste 다.
 *
 * corral 의 xterm 은 안쪽 앱의 2004 비트를 모른다(늘 false) — xterm 에 맡기면 틀 없이 가서 main 분류기가 CR 을
 * Enter 키로 보낸다(여러 줄의 첫 줄이 전송·실행된다). 틀로 보내면 분류기가 herdr Paste 로 바꾸고 herdr 가 pane 의
 * 실제 모드에 맞춰 틀을 유지하거나 벗긴다 — 2004 를 끈 앱은 지금과 같은 바이트를 받는다.
 * Orca 는 여러 줄만 강제한다(xterm 이 비트를 가진 구조라서) — corral 은 한 줄도 강제해야 2004 앱이 붙여넣기로 받는다.
 *
 * herdr 상한(`maxBytes`)을 넘으면 코드 포인트 경계에서 쪼개 틀 여러 개로 보낸다 — 거절돼 통째로 사라지는 대신
 * 본문이 온전히 도착한다(앱은 붙여넣기 여러 번으로 받는다). 줄바꿈 정규화·ESC 무력화는 쪼개기 **전에** 해서
 * `\r\n` 이 조각 경계에 걸려도 결과가 같다.
 */
export function clipboardTextPayloads(text: string, maxBytes: number = HERDR_PASTE_MAX_BYTES): string[] {
  const normalized = text.replace(/\r?\n/g, '\r').split(ESCAPE).join('\u241b')
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  let index = 0
  for (const char of normalized) {
    const size = utf8Length(char.codePointAt(0) ?? 0)
    if (bytes + size > maxBytes && index > start) {
      chunks.push(normalized.slice(start, index))
      start = index
      bytes = 0
    }
    bytes += size
    index += char.length
  }
  chunks.push(normalized.slice(start))
  return chunks.map(wrapBracketedPaste)
}

/** main 이 쓴 PNG 경로 → pane 에 쓸 바이트. 저장이 안 됐으면(빈 클립보드·실패) 아무것도 보내지 않는다 (K1ⓓ). */
export function clipboardImagePayload(
  result: { status: 'saved'; path: string } | { status: 'empty' } | { status: 'failed'; error: string },
): string | null {
  return result.status === 'saved' ? wrapBracketedPaste(result.path) : null
}

/**
 * 렌더러가 이미지 ⌘V 의 main 왕복(클립보드 읽기·PNG 쓰기)을 기다리는 상한 (LIFE-505 fix1 F2).
 * 텍스트 ⌘V·드롭도 같은 순서 큐에 서므로, 왕복이 끝나지 않으면 그 pane 의 뒤 붙여넣기가 영영 막힌다.
 * 값의 근거는 specs/LIFE-505-bracketed-paste/raw/claude/RESULT.md 「fix1」 F2 (큰 이미지 왕복 실측 대비 여유).
 */
export const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 5000

/**
 * `pending` 이 `ms` 안에 끝나지 않으면 `onTimeout()` 값으로 푼다 — 순서 큐의 한 자리가 영원히 막히지 않게 (fix1 F2).
 * 늦게 끝난 원래 결과는 버린다(시간이 지나 나간 이미지 경로가 뒤 입력 사이에 끼지 않게).
 */
export function settleWithin<T>(input: { pending: Promise<T>; ms: number; onTimeout: () => T }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(input.onTimeout()), input.ms)
    input.pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * pane 하나의 생성 입력(⌘V 이미지·드롭)을 **받은 순서대로** 내보낸다 (R1-03).
 * ⌘V 이미지는 main 왕복(클립보드 읽기·PNG 쓰기)을 기다리고 드롭은 바로 준비된다 — 각자 끝나는 대로 보내면
 * 두 번 연속 ⌘V 나 ⌘V 직후 드롭이 뒤바뀐다. 그래서 접수 때 자리를 잡고, 앞 자리가 끝나야 다음을 보낸다.
 * 빈 결과·실패(reject)도 자리를 지킨다 — 아무것도 안 보내고 다음으로 넘어간다.
 * 돌려주는 값은 그 자리가 다 나갔을 때 풀리는 promise (테스트·관측용, 호출자는 무시해도 된다).
 */
export function createOrderedSender<T>(send: (item: T) => void): (pending: Promise<readonly T[]> | readonly T[]) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (pending) => {
    const ready = Promise.resolve(pending).catch((): readonly T[] => [])
    tail = tail.then(async () => {
      for (const item of await ready) {
        try {
          send(item)
        } catch {
          // 한 항목의 전송 예외가 뒤 자리를 막지 않게 한다
        }
      }
    })
    return tail
  }
}

/**
 * 초안 본문 정제 (LIFE-603 D8 · C15) — 외부 본문(작업 제목·본문)을 **입력창에만** 넣을 글자로 만든다.
 *
 * 남기는 제어 문자는 줄바꿈(LF)과 탭뿐이다. CR·CRLF 는 LF 로 맞추고, ESC(붙여넣기 끝 `ESC[201~` 포함)·그 밖의
 * C0·DEL·C1 은 **지운다** — U+241B 로 바꾸는 `wrapBracketedPaste` 의 무력화보다 한 단계 세다(본문에 보일 이유가 없는 글자다).
 * 그래서 감싼 뒤의 틀 안에는 `ESC` 가 하나도 없고, 틀을 일찍 닫아 꼬리를 키 입력으로 돌릴 길이 없다.
 * 끝의 빈 줄·공백은 걷는다 — 틀 안이어도 마지막 줄바꿈을 「보내기」 로 읽는 입력기가 있을 수 있어 아예 만들지 않는다.
 */
export function sanitizeDraftBody(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n')
  let out = ''
  for (const char of unified) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\n' || char === '\t') out += char
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    else if (invisibleCodePoint(code)) continue
    else out += char
  }
  return out.replace(/\s+$/u, '')
}

/**
 * 사람 눈에 안 보이고 모델은 읽는 글자(LIFE-603 R1-F) — 초안의 안전장치(「사람이 보고 Enter」)를 비껴간다. 지운다.
 * 태그 U+E0000–E007F(숨긴 ASCII) · 양방향 제어 U+061C·U+200E·U+200F·U+202A–202E·U+2066–2069 ·
 * 제로폭 U+200B–200D·U+2060–2064·U+FEFF · 변형 선택자 보충 U+E0100–E01EF · 소프트 하이픈 U+00AD.
 * 대가: 이모지 결합(ZWJ U+200D)이 낱자로 풀린다 — 본문의 뜻은 그대로다.
 */
export function invisibleCodePoint(code: number): boolean {
  return (code >= 0xe0000 && code <= 0xe007f) || (code >= 0xe0100 && code <= 0xe01ef)
    || code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
    || (code >= 0x200b && code <= 0x200d) || (code >= 0x2060 && code <= 0x2064) || code === 0xfeff || code === 0x00ad
}

/** 초안 한 번에 쓸 바이트 — 정제한 본문을 강제 bracketed paste 하나로. Enter(CR) 는 틀 밖에 붙이지 않는다. */
export function draftPastePayload(text: string): string {
  return wrapBracketedPaste(sanitizeDraftBody(text))
}
