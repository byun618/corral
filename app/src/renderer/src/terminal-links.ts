// LIFE-565 — 터미널 링크 ⌘+클릭 열기 (평문 URL · OSC 8).
//
// 열기 경로는 하나다: 렌더러 `window.open(url)` → main `setWindowOpenHandler` 의 허용 술어(`isExternalOpenAllowed`)
// → `shell.openExternal`. 여기는 **스킴을 거르지 않는다** — 허용 판단은 main 한 곳이고, 거절은 main 이 로그로 남긴다(C3ⓒ).
//
// 평문 URL 은 `@xterm/addon-web-links` 대신 자체 provider 로 찾는다. herdr 프레임은 행마다 절대 좌표로 쓰고 autowrap 을
// 끄기 때문에(frame-to-ansi) xterm 버퍼의 `isWrapped` 가 서지 않는다 — 애드온은 긴 URL 을 첫 행 끝에서 자른다(00-analysis F2).
// 그래서 **행 끝 칸까지 URL 문자로 찬 행과 (들여쓰기 뒤) URL 문자로 시작하는 다음 행**을 한 줄로 이어 본다(D3).
// 실제 Claude Code(Ink)는 이어지는 행을 본문 여백만큼 들여쓴다 — 단독 URL 2칸·목록 항목 4칸(fix r1 샘플
// `raw/claude/f1-wrap-sample-*`). 들여쓰기 공백은 URL 에 넣지 않는다.
import type { IBufferRange, ILink, ILinkHandler, Terminal } from '@xterm/xterm'

/** 버퍼 한 칸. `width` 0 은 넓은 글자의 뒤 칸이다. */
export type LinkCell = { chars: string; width: number }

/** 0 기반 버퍼 행 → 그 행의 칸들(길이 = cols). 범위 밖이면 undefined. */
export type ReadRow = (y: number) => LinkCell[] | undefined

/** 한 번에 잇는 최대 행 수 — 화면 하나를 통째로 훑지 않게 막는 상한. */
const MAX_JOINED_ROWS = 16

/** 이어지는 행에 허용하는 들여쓰기 칸 수 상한 — 실측 2·4칸, 중첩 목록 여유를 둔다. */
const MAX_CONTINUATION_INDENT = 8

const URL_CHAR = /[\w\-.~:/?#[\]@!$&()*+,;=%]/
// 스킴은 거르지 않는다(위 주석) — `scheme://` 꼴이면 링크로 본다. 앞 글자가 스킴 문자면 스킴 중간이라 잡지 않는다.
const URL_PATTERN = /(?<![a-zA-Z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[\w\-.~:/?#[\]@!$&()*+,;=%]+/g
const SCHEME_START = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
// 목록 마커 한 토큰 + 공백 — hard-break 로 이어지는 URL 조각은 이 꼴일 수 없다(R2-01).
const LIST_MARKER_START = /^(?:[-+*]|\d+[.)]) /
// 비 ASCII 글자 앞에서 끊긴 URL 이 경로 중간이었다고 볼 마지막 글자(R2-04) — `wiki/한글`·`?q=검색` 류.
const MID_PATH_TAIL = /[/=\-_?&#%~]$/

function isUrlCell(cell: LinkCell | undefined): boolean {
  return cell !== undefined && cell.width === 1 && cell.chars.length === 1 && URL_CHAR.test(cell.chars)
}

function isBlankCell(cell: LinkCell | undefined): boolean {
  return cell !== undefined && cell.width === 1 && (cell.chars === '' || cell.chars === ' ')
}

/** 이어지는 행의 들여쓰기 칸 수. 상한 안에서 URL 문자가 안 나오면 null. */
function continuationIndent(cells: LinkCell[]): number | null {
  let x = 0
  while (x <= MAX_CONTINUATION_INDENT && isBlankCell(cells[x])) x++
  return x <= MAX_CONTINUATION_INDENT && isUrlCell(cells[x]) ? x : null
}

/**
 * 행 a 의 마지막 칸이 URL 문자이고 행 b 가 (들여쓰기 ≤ 상한 뒤) URL 문자로 시작하면 줄 넘김으로 본다.
 * 단 b 가 `scheme://` 로 시작하면 새 URL 이다 — 잇지 않는다(R1-04: 앞 행 끝 글자와 붙어 정상 URL 이 사라지는 것 방지).
 */
function continues(a: LinkCell[] | undefined, b: LinkCell[] | undefined): boolean {
  if (a === undefined || b === undefined || a.length === 0) return false
  if (!isUrlCell(a[a.length - 1])) return false
  const indent = continuationIndent(b)
  if (indent === null) return false
  const head = b
    .slice(indent, indent + 32)
    .map((cell) => (cell.chars === '' ? ' ' : cell.chars))
    .join('')
  return !SCHEME_START.test(head) && !LIST_MARKER_START.test(head)
}

/** URL 끝에 붙은 문장 구두점·마크다운 굵게(`*`)·짝 없는 닫는 괄호를 뗀다 (C1ⓓ·R1-05). */
export function trimUrlTail(url: string): string {
  let end = url.length
  for (;;) {
    const last = url[end - 1]
    if (last === undefined) break
    if ('.,;:!?*'.includes(last)) {
      end--
      continue
    }
    const open = last === ')' ? '(' : last === ']' ? '[' : null
    if (open !== null) {
      const body = url.slice(0, end)
      if (body.split(open).length < body.split(last).length) {
        end--
        continue
      }
    }
    break
  }
  return url.slice(0, end)
}

/** 버퍼 행 y(0 기반)에 걸친 URL 링크들. 범위는 xterm 규약(1 기반·끝 포함). */
export function findLinksOnRow(input: { readRow: ReadRow; y: number }): Array<{ text: string; range: IBufferRange }> {
  const { readRow, y } = input
  if (readRow(y) === undefined) return []
  let top = y
  while (y - top < MAX_JOINED_ROWS && top > 0 && continues(readRow(top - 1), readRow(top))) top--
  let bottom = y
  while (bottom - top < MAX_JOINED_ROWS && continues(readRow(bottom), readRow(bottom + 1))) bottom++
  // 상한에 걸려 체인이 안 끝났으면 그 끝에 닿은 URL 은 잘린 것이다 — 내지 않는다(R2-03).
  const topOpen = top > 0 && continues(readRow(top - 1), readRow(top))
  const bottomOpen = continues(readRow(bottom), readRow(bottom + 1))

  let text = ''
  const positions: Array<{ x: number; y: number }> = []
  for (let row = top; row <= bottom; row++) {
    const cells = readRow(row) ?? []
    // 이어지는 행의 들여쓰기는 URL 의 일부가 아니다 — 건너뛴다.
    const skip = row === top ? 0 : (continuationIndent(cells) ?? 0)
    cells.forEach((cell, x) => {
      if (cell.width === 0 || x < skip) return
      const chars = cell.chars === '' ? ' ' : cell.chars
      text += chars
      for (let i = 0; i < chars.length; i++) positions.push({ x, y: row })
    })
  }

  const links: Array<{ text: string; range: IBufferRange }> = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrlTail(match[0])
    if (!/:\/\/./.test(url)) continue
    const rawEnd = match.index + match[0].length
    if ((topOpen && match.index === 0) || (bottomOpen && rawEnd === text.length)) continue
    // 경로 중간에서 비 ASCII 글자를 만나 끊겼으면 접두사 URL 이다 — 내지 않는다(R2-04).
    // `https://example.com에서` 처럼 조사가 붙은 꼴은 끝 글자가 경로 중간 표지가 아니라 링크로 둔다.
    const next = text[rawEnd]
    if (next !== undefined && next.charCodeAt(0) > 0x7f && !/\s/.test(next) && MID_PATH_TAIL.test(match[0])) continue
    const start = positions[match.index]
    const end = positions[match.index + url.length - 1]
    if (start === undefined || end === undefined) continue
    if (end.y < y || start.y > y) continue
    links.push({ text: url, range: { start: { x: start.x + 1, y: start.y + 1 }, end: { x: end.x + 1, y: end.y + 1 } } })
  }
  return links
}

/** ⌘+클릭만 연다 (D1) — 수식키 없는 클릭은 pane 앱의 클릭이다. 스킴 판단은 main 이 한다. */
export function openTerminalLink(event: MouseEvent, url: string): void {
  if (!event.metaKey) return
  window.open(url)
}

/**
 * OSC 8 링크 활성화 — xterm 기본 `defaultActivate`(confirm 모달 + 빈 창)를 대신한다(C2ⓑ).
 * `allowNonHttpProtocols` 를 켜는 이유: 끄면 xterm 이 렌더러에서 http(s) 밖을 걸러 두 번째 허용 목록이 되고,
 * 거절이 main 로그에 남지 않는다(C3ⓑⓒ).
 */
export const terminalLinkHandler: ILinkHandler = {
  activate: (event, text) => openTerminalLink(event, text),
  allowNonHttpProtocols: true,
}

/** 평문 URL provider 를 등록한다. 반환값을 터미널과 함께 dispose 한다. */
export function registerTerminalLinks(term: Terminal): { dispose(): void } {
  const readRow: ReadRow = (y) => {
    const line = term.buffer.active.getLine(y)
    if (line === undefined) return undefined
    const cells: LinkCell[] = []
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      cells.push(cell === undefined ? { chars: '', width: 1 } : { chars: cell.getChars(), width: cell.getWidth() })
    }
    return cells
  }
  return term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const links: ILink[] = findLinksOnRow({ readRow, y: bufferLineNumber - 1 }).map((link) => ({
        ...link,
        activate: openTerminalLink,
      }))
      callback(links.length === 0 ? undefined : links)
    },
  })
}
