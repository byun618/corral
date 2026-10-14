// 작업 본문 markdown — 순수 함수 (LIFE-602 C4·C5). 화면(MarkdownView·MarkdownEditor)은 이것을 부르기만 한다.
//
// - 체크 칸 저장: 렌더러가 준 **소스 줄 번호**(mdast position — 항목 시작 줄)로 그 항목의 `[ ]`↔`[x]` 글자 하나만 바꾼다(칸이 다음 줄에 있어도, R6-C).
//   줄 끝 문자(\n·\r\n·\r)와 다른 바이트는 그대로다 — 같은 글자의 체크 줄이 여럿이어도 줄 번호로 고른다(G4).
// - 링크: 밖으로 여는 것은 절대 http·https 뿐이다(main 의 허용 목록과 같은 규칙 — 결정은 main 이 다시 한다). 상대·프로토콜 상대·그 밖 scheme 은 열지 않는다.
// - 편집기 도구·목록 이어 쓰기: 바꿀 구간(from·to)과 넣을 글(text), 바꾼 뒤 선택을 돌려준다 — 편집기가 그 구간을 「입력」 으로 바꿔
//   브라우저 undo 기록에 남긴다(G5).

/** 줄 하나 — 시작·끝(줄 끝 문자 앞) 위치. */
type LineSpan = { start: number; end: number }

function lineSpans(source: string): LineSpan[] {
  const spans: LineSpan[] = []
  const breaks = /\r\n|\r|\n/g
  let start = 0
  for (let match = breaks.exec(source); match !== null; match = breaks.exec(source)) {
    spans.push({ start, end: match.index })
    start = match.index + match[0].length
  }
  spans.push({ start, end: source.length })
  return spans
}

/**
 * 목록 항목 시작 줄 → 그 항목의 체크 칸. 캡처 1 = 칸 앞까지, 2 = 칸 안 글자. GFM 이 체크리스트로 그리는 모양 전부(R6-C):
 * 인용 안(`> - [ ]`) · 한 줄에 표지 여럿(`- - [ ]`, 안쪽 항목이 칸을 갖는다) · 표지 다음 줄의 칸(`-⏎  [ ]`, 인용이면 다음 줄의 `>` 도).
 * 항목은 빈 줄로 시작할 수 있어도 한 줄뿐이라 다음 줄 하나만 본다.
 */
const CHECK_MARK = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|[ \t]*(?:\r\n|\r|\n)(?:[ \t]*>[ \t]?)*[ \t]*))+)\[([ xX])\]/

/**
 * 체크 칸 하나 토글 — `line` 은 그 목록 항목이 시작하는 줄(1부터, 렌더러의 소스 위치). 그 항목에 체크 칸이 없으면 null(보내지 않는다 — 보기는 그런 칸을 비활성으로 둔다).
 * `checked` 를 주면 그 값으로(이미 그 값이면 null), 없으면 뒤집는다.
 */
export function toggleCheckLine({ source, line, checked }: { source: string; line: number; checked?: boolean }): string | null {
  const span = lineSpans(source)[line - 1]
  if (span === undefined) return null
  const text = source.slice(span.start)
  const match = CHECK_MARK.exec(text)
  if (match === null || match[1] === undefined || match[2] === undefined) return null
  const now = match[2] !== ' '
  const next = checked ?? !now
  if (next === now) return null
  const at = span.start + match[1].length + 1
  return source.slice(0, at) + (next ? 'x' : ' ') + source.slice(at + 1)
}

export type LinkAction = { kind: 'external'; url: string } | { kind: 'blocked'; reason: string }

/** 링크를 눌렀을 때 — 절대 http·https 만 밖으로. 앱 안으로 이동하는 길은 없다. */
export function linkAction(href: string | undefined | null): LinkAction {
  const value = (href ?? '').trim()
  if (!/^https?:\/\//i.test(value)) return { kind: 'blocked', reason: value === '' ? '열 수 없는 링크입니다.' : '이 링크는 열지 않습니다 — http·https 주소만 외부 브라우저로 엽니다.' }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? { kind: 'external', url: url.href } : { kind: 'blocked', reason: '열 수 없는 링크입니다.' }
  } catch {
    return { kind: 'blocked', reason: '주소 모양이 아닙니다.' }
  }
}

/** 편집 하나 — [from, to) 를 text 로 바꾸고, 바꾼 뒤 선택은 [selectFrom, selectTo). */
export type TextEdit = { from: number; to: number; text: string; selectFrom: number; selectTo: number }

/**
 * 편집 칸(`data-editor-keys` — 본문 편집기·코멘트 입력)이 직접 쓰는 단축키(LIFE-602 수정 1 R1-F). 포커스가 그 칸에 있으면
 * 앱 전역 단축키 처리기(`useKeybindings`, document capture)가 이 조합을 가로채지 않는다 — ⌘B(사이드바)·⌘K(팔레트)가 편집기에 간다.
 * 형식은 `bindingFromEvent` 의 정규형. main 메뉴 키 길(`menuKeyShortcut`)은 ⌘W·⌘R 만 쥐어 여기와 겹치지 않는다.
 */
export const EDITOR_KEYS: readonly string[] = ['Mod+B', 'Mod+Shift+I', 'Mod+E', 'Mod+K', 'Mod+Enter']

export const MD_TOOLS = ['heading', 'bold', 'italic', 'code', 'link', 'bullet', 'number', 'check', 'quote', 'codeblock'] as const
export type MdTool = (typeof MD_TOOLS)[number]

export const MD_TOOL_LABEL: Record<MdTool, string> = {
  heading: '제목', bold: '굵게', italic: '기울임', code: '코드', link: '링크', bullet: '목록', number: '번호', check: '체크', quote: '인용', codeblock: '코드 블록',
}

function wrap({ value, start, end, before, after, placeholder }: { value: string; start: number; end: number; before: string; after: string; placeholder: string }): TextEdit {
  const selected = value.slice(start, end)
  const inner = selected.length === 0 ? placeholder : selected
  return { from: start, to: end, text: `${before}${inner}${after}`, selectFrom: start + before.length, selectTo: start + before.length + inner.length }
}

/** 선택이 걸친 줄마다 앞에 붙인다(번호는 1. 2. 3.). */
function prefixLines({ value, start, end, prefix }: { value: string; start: number; end: number; prefix: (index: number) => string }): TextEdit {
  const from = value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = value.indexOf('\n', end)
  const to = lineEnd < 0 ? value.length : lineEnd
  const lines = value.slice(from, to).split('\n')
  const text = lines.map((line, index) => `${prefix(index)}${line}`).join('\n')
  return { from, to, text, selectFrom: from + text.length, selectTo: from + text.length }
}

/** 도구 하나 — 선택(없으면 자리 글)을 감싸거나 줄 앞에 표지를 붙인다. */
export function applyTool({ value, start, end, tool }: { value: string; start: number; end: number; tool: MdTool }): TextEdit {
  switch (tool) {
    case 'bold': return wrap({ value, start, end, before: '**', after: '**', placeholder: '굵게' })
    case 'italic': return wrap({ value, start, end, before: '_', after: '_', placeholder: '기울임' })
    case 'code': return wrap({ value, start, end, before: '`', after: '`', placeholder: 'code' })
    case 'link': {
      const selected = value.slice(start, end)
      const label = selected.length === 0 ? '링크' : selected
      const text = `[${label}](https://)`
      const urlAt = start + label.length + 3
      return { from: start, to: end, text, selectFrom: urlAt, selectTo: urlAt + 'https://'.length }
    }
    case 'codeblock': {
      const selected = value.slice(start, end)
      const lead = start > 0 && value[start - 1] !== '\n' ? '\n' : ''
      const text = `${lead}\`\`\`\n${selected}\n\`\`\``
      const at = start + lead.length + 4
      return { from: start, to: end, text, selectFrom: at, selectTo: at + selected.length }
    }
    case 'heading': return prefixLines({ value, start, end, prefix: () => '## ' })
    case 'bullet': return prefixLines({ value, start, end, prefix: () => '- ' })
    case 'number': return prefixLines({ value, start, end, prefix: (index) => `${index + 1}. ` })
    case 'check': return prefixLines({ value, start, end, prefix: () => '- [ ] ' })
    case 'quote': return prefixLines({ value, start, end, prefix: () => '> ' })
  }
}

const LIST_LINE = /^([ \t]*(?:>[ \t]?)*[ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/

/**
 * 목록 줄에서 Enter — 다음 항목 표지를 이어 쓴다. 표지만 있는 빈 항목이면 표지를 지워 목록을 끝낸다. 목록 줄이 아니거나 선택이 있으면 null(기본 Enter).
 */
export function continueList({ value, start, end }: { value: string; start: number; end: number }): TextEdit | null {
  if (start !== end) return null
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const before = value.slice(lineStart, start)
  const match = LIST_LINE.exec(before)
  if (match === null) return null
  const marker = match[0]
  const lineEnd = value.indexOf('\n', start)
  const rest = value.slice(start, lineEnd < 0 ? value.length : lineEnd)
  if (before.length === marker.length && rest.trim().length === 0) {
    // 빈 항목 — 표지를 지운다(목록 끝).
    return { from: lineStart, to: start, text: '', selectFrom: lineStart, selectTo: lineStart }
  }
  const indent = match[1] ?? ''
  const number = match[3]
  const bullet = number === undefined ? (match[2] ?? '-') : `${Number(number) + 1}${match[4] ?? '.'}`
  const task = match[6] === undefined ? '' : '[ ] '
  const text = `\n${indent}${bullet}${match[5] ?? ' '}${task}`
  return { from: start, to: start, text, selectFrom: start + text.length, selectTo: start + text.length }
}

/** 편집을 글에 적용(편집기가 브라우저 입력을 못 쓸 때의 대체 경로와 테스트). */
export function applyEdit({ value, edit }: { value: string; edit: TextEdit }): string {
  return value.slice(0, edit.from) + edit.text + value.slice(edit.to)
}
