// ADF ↔ markdown (LIFE-605 C6 · F11) — Jira 본문·코멘트(Atlassian Document Format)를 계약의 markdown 으로, 거꾸로도. **main 안에서만** 쓴다(렌더러·IPC 는 markdown 만 본다).
//
// - 지원 표(design-notes §9): 블록 = 문단 · 제목(1–6) · 글머리 목록 · 번호 목록(시작 번호) · 할 일 목록(중첩) · 코드 블록(언어) · 인용 · 가로줄,
//   인라인 = 글 · 줄바꿈(hardBreak) · 마크 굵게 · 기울임 · 코드 · 취소선 · 링크(href). 그 밖 노드·마크는 전부 「바꿀 수 없는 요소」 다(모르는 것도).
// - ADF → md 는 바꿀 수 없는 요소를 **보기용 자리글**로 그리고 그 이름을 `unsupported` 로 돌려준다 — 출처는 그 목록이 비지 않으면 본문 편집을 잠근다
//   (`WorkItem.bodyLock`). 자리글을 md → ADF 로 되돌리면 원래 요소가 아니라 글이 된다 — 그래서 잠근다(조용히 지우지 않는다).
// - md 의 문단 안 줄바꿈은 ADF `hardBreak` 로(웹 Jira 에서 줄이 바뀌어 보인다), 거꾸로도 `\n` 으로. 말뭉치 안에서는 md → ADF → md 가 바이트로 같다(시험).
// - 체크 칸 바로 저장(C6③)은 `withTaskStates` — 원래 ADF 에서 `taskItem.attrs.state` 만 바꾼다(다른 노드 무변경).
// 참고: Orca `src/main/jira/adf-markdown.ts`(MIT, Lovecast Inc.)의 노드 이름 목록을 대조했다 — 코드는 가져오지 않았다(구조가 다르다: 그쪽은 버리고, 이쪽은 잠근다).

import { isRecord } from '../../shared/json.js'

export type AdfMark = { type: string; attrs?: Record<string, unknown> }
export type AdfNode = { type: string; attrs?: Record<string, unknown>; content?: AdfNode[]; marks?: AdfMark[]; text?: string }
export type AdfDoc = { type: 'doc'; version: 1; content: AdfNode[] }

export type AdfToMd = { markdown: string; unsupported: string[] }

const BLOCKS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'codeBlock', 'blockquote', 'rule'])
const INLINES = new Set(['text', 'hardBreak'])
const MARKS = new Set(['strong', 'em', 'code', 'strike', 'link'])
/** 바꿀 수 없는 요소의 사람 이름 — 안내 글에 쓴다. 목록 밖은 노드 이름 그대로. */
const UNSUPPORTED_LABEL: Record<string, string> = {
  mention: '멘션', emoji: '이모지', panel: '패널', mediaSingle: '첨부', mediaGroup: '첨부', mediaInline: '첨부', media: '첨부', status: '상태 배지',
  table: '표', expand: '펼치기', nestedExpand: '펼치기', inlineCard: '링크 카드', blockCard: '링크 카드', embedCard: '링크 카드', date: '날짜',
  extension: '확장', bodiedExtension: '확장', inlineExtension: '확장', decisionList: '결정 목록', layoutSection: '레이아웃', placeholder: '자리 표시',
  underline: '밑줄', textColor: '글자 색', backgroundColor: '배경 색', subsup: '위·아래 첨자', alignment: '정렬', indentation: '들여쓰기', annotation: '주석', border: '테두리',
}

export function unsupportedLabel(type: string): string {
  return UNSUPPORTED_LABEL[type] ?? type
}

/** ADF 를 읽는다 — 문서 모양(`type: doc` · 배열 content)이 아니면 null. 노드 하나하나의 모양은 변환하면서 본다. */
export function readAdfDoc(value: unknown): AdfDoc | null {
  if (value === null || value === undefined) return { type: 'doc', version: 1, content: [] }
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) return null
  const content = value.content.filter(isRecord).map(readNode)
  return content.some((node) => node === null) ? null : { type: 'doc', version: 1, content: content.filter((node): node is AdfNode => node !== null) }
}

function readNode(value: Record<string, unknown>): AdfNode | null {
  if (typeof value.type !== 'string') return null
  const node: AdfNode = { type: value.type }
  if (isRecord(value.attrs)) node.attrs = { ...value.attrs }
  if (typeof value.text === 'string') node.text = value.text
  if (Array.isArray(value.marks)) {
    const marks = value.marks.filter(isRecord)
    if (marks.some((mark) => typeof mark.type !== 'string')) return null
    node.marks = marks.map((mark) => ({ type: String(mark.type), ...(isRecord(mark.attrs) ? { attrs: { ...mark.attrs } } : {}) }))
  }
  if (Array.isArray(value.content)) {
    const content = value.content.filter(isRecord).map(readNode)
    if (content.some((entry) => entry === null)) return null
    node.content = content.filter((entry): entry is AdfNode => entry !== null)
  }
  return node
}

// --- ADF → markdown ---

export function adfToMarkdown(doc: AdfDoc): AdfToMd {
  const unsupported = new Set<string>()
  const markdown = writeBlocks({ nodes: doc.content, unsupported })
  return { markdown, unsupported: [...unsupported] }
}

function writeBlocks({ nodes, unsupported }: { nodes: AdfNode[]; unsupported: Set<string> }): string {
  return nodes.map((node) => writeBlock({ node, unsupported })).join('\n\n')
}

function writeBlock({ node, unsupported }: { node: AdfNode; unsupported: Set<string> }): string {
  const content = node.content ?? []
  switch (node.type) {
    case 'paragraph':
      return escapeLineStarts(writeInline({ nodes: content, unsupported }))
    case 'heading': {
      const level = clampLevel(node.attrs?.level)
      return `${'#'.repeat(level)} ${writeInline({ nodes: content, unsupported }).replaceAll('\n', ' ')}`
    }
    case 'bulletList':
      return content.map((item) => writeListItem({ item, marker: '- ', unsupported })).join('\n')
    case 'orderedList': {
      const start = typeof node.attrs?.order === 'number' && Number.isInteger(node.attrs.order) && node.attrs.order >= 0 ? node.attrs.order : 1
      return content.map((item, index) => writeListItem({ item, marker: `${start + index}. `, unsupported })).join('\n')
    }
    case 'taskList':
      return writeTaskList({ node, unsupported, indent: '' })
    case 'codeBlock': {
      const text = content.map((entry) => entry.text ?? '').join('')
      const language = typeof node.attrs?.language === 'string' && /^[\w#+.-]{1,40}$/.test(node.attrs.language) ? node.attrs.language : ''
      const fence = fenceFor(text)
      return `${fence}${language}\n${text}\n${fence}`
    }
    case 'blockquote':
      return writeBlocks({ nodes: content, unsupported }).split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')
    case 'rule':
      return '---'
    default:
      unsupported.add(node.type)
      return placeholderBlock({ node, unsupported })
  }
}

function writeListItem({ item, marker, unsupported }: { item: AdfNode; marker: string; unsupported: Set<string> }): string {
  if (item.type !== 'listItem') {
    unsupported.add(item.type)
    return `${marker}${placeholderBlock({ node: item, unsupported })}`
  }
  const pad = ' '.repeat(marker.length)
  const children = item.content ?? []
  const parts: string[] = []
  children.forEach((child, index) => {
    const text = writeBlock({ node: child, unsupported })
    // 목록 바로 뒤 목록·첫 문단 뒤 목록은 빈 줄 없이(촘촘한 목록), 그 밖 블록 사이는 빈 줄.
    const tight = index > 0 && isList(child)
    if (index > 0) parts.push(tight ? '\n' : '\n\n')
    parts.push(indentRest({ text, pad, first: index === 0 }))
  })
  return `${marker}${parts.join('')}`
}

function writeTaskList({ node, unsupported, indent }: { node: AdfNode; unsupported: Set<string>; indent: string }): string {
  const lines: string[] = []
  for (const child of node.content ?? []) {
    if (child.type === 'taskItem') {
      const done = child.attrs?.state === 'DONE'
      const text = writeInline({ nodes: child.content ?? [], unsupported })
      lines.push(`${indent}- [${done ? 'x' : ' '}] ${text.split('\n').join(`\n${indent}  `)}`)
    } else if (child.type === 'taskList') {
      lines.push(writeTaskList({ node: child, unsupported, indent: `${indent}  ` }))
    } else {
      unsupported.add(child.type)
      lines.push(`${indent}- ${placeholderBlock({ node: child, unsupported })}`)
    }
  }
  return lines.join('\n')
}

function isList(node: AdfNode): boolean {
  return node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList'
}

/** 목록 항목 안 블록 — 첫 줄은 표지 뒤, 나머지 줄은 들여 쓴다(빈 줄은 그대로). */
function indentRest({ text, pad, first }: { text: string; pad: string; first: boolean }): string {
  return text.split('\n').map((line, index) => (line === '' || (first && index === 0) ? line : `${pad}${line}`)).join('\n')
}

function clampLevel(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : 1
}

function fenceFor(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** 바꿀 수 없는 블록의 보기용 자리글 — 안의 글은 살려 보인다(패널·펼치기 안 문단 등). */
function placeholderBlock({ node, unsupported }: { node: AdfNode; unsupported: Set<string> }): string {
  const inner = (node.content ?? []).map((child) => (BLOCKS.has(child.type) ? writeBlock({ node: child, unsupported }) : writeInline({ nodes: [child], unsupported }))).filter((text) => text.length > 0)
  const label = `[${unsupportedLabel(node.type)}]`
  return inner.length === 0 ? label : `${label} ${inner.join(' ').replaceAll('\n', ' ')}`
}

function placeholderInline({ node, unsupported }: { node: AdfNode; unsupported: Set<string> }): string {
  unsupported.add(node.type)
  const attrs = node.attrs ?? {}
  const text = typeof attrs.text === 'string' ? attrs.text : typeof attrs.shortName === 'string' ? attrs.shortName : typeof attrs.url === 'string' ? attrs.url : null
  if (node.type === 'mention') return escapeText(text ?? '@멘션')
  if (node.type === 'date' && typeof attrs.timestamp === 'string' && /^\d{1,15}$/.test(attrs.timestamp)) return new Date(Number(attrs.timestamp)).toISOString().slice(0, 10)
  return `[${escapeText(text ?? unsupportedLabel(node.type))}]`
}

type Open = { type: string; href: string | null; delim?: string }

/** 인라인 — 마크는 열고 닫기를 이어 쓴다(같은 마크가 이어진 글 조각을 한 번만 감싼다). 순서: 링크 바깥 · 굵게 · 기울임 · 취소선 · 코드 안쪽. */
function writeInline({ nodes, unsupported }: { nodes: AdfNode[]; unsupported: Set<string> }): string {
  let out = ''
  const stack: Open[] = []
  const closeTo = (depth: number): void => {
    while (stack.length > depth) {
      const top = stack.pop()
      if (top !== undefined) out += closer(top)
    }
  }
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      closeTo(0)
      out += '\n'
      continue
    }
    if (node.type !== 'text') {
      closeTo(0)
      out += placeholderInline({ node, unsupported })
      continue
    }
    const marks = orderedMarks({ marks: node.marks ?? [], unsupported })
    // 지금 열린 마크 중 앞에서부터 같은 것까지만 남기고 닫는다.
    let keep = 0
    while (keep < stack.length && keep < marks.length && sameOpen(stack[keep], marks[keep])) keep += 1
    closeTo(keep)
    const text = node.text ?? ''
    const code = marks.some((mark) => mark.type === 'code')
    for (const mark of marks.slice(keep)) {
      if (mark.type === 'code') continue
      const open = { ...mark, delim: opener({ mark, before: out.at(-1) ?? '' }) }
      stack.push(open)
      out += open.delim
    }
    out += code ? codeSpan(text) : escapeText(text)
  }
  closeTo(0)
  return out
}

function sameOpen(a: Open | undefined, b: Open | undefined): boolean {
  return a !== undefined && b !== undefined && a.type === b.type && a.href === b.href
}

const MARK_ORDER = ['link', 'strong', 'em', 'strike', 'code']

function orderedMarks({ marks, unsupported }: { marks: AdfMark[]; unsupported: Set<string> }): Open[] {
  const known: Open[] = []
  for (const mark of marks) {
    if (!MARKS.has(mark.type)) {
      unsupported.add(mark.type)
      continue
    }
    const href = mark.type === 'link' && typeof mark.attrs?.href === 'string' ? mark.attrs.href : null
    if (mark.type === 'link' && href === null) continue
    if (!known.some((entry) => entry.type === mark.type)) known.push({ type: mark.type, href })
  }
  return known.sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
}

function opener({ mark, before }: { mark: Open; before: string }): string {
  switch (mark.type) {
    case 'link': return '['
    case 'strong': return '**'
    case 'strike': return '~~'
    // 기울임은 `_` — 굵게와 붙어도(`**_x_**`) 갈리지 않는다. 단어 안에서 시작하면 `_` 가 기울임이 아니므로 `*`.
    case 'em': return /[\p{L}\p{N}]/u.test(before) ? '*' : '_'
    default: return ''
  }
}

function closer(mark: Open): string {
  switch (mark.type) {
    case 'link': return `](${(mark.href ?? '').replaceAll(' ', '%20').replaceAll(')', '%29')})`
    case 'strong': return '**'
    case 'strike': return '~~'
    case 'em': return mark.delim ?? '_'
    default: return ''
  }
}

function codeSpan(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const ticks = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ') && text.trim().length > 0) ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

/** 글 조각의 md 특수 글자를 막는다 — `\` `*` `` ` `` `[` `]` `~~`, 단어 경계의 `_`. 줄 첫머리 표지는 `escapeLineStarts` 가. */
function escapeText(text: string): string {
  let out = ''
  // `*` 하나가 글 조각 가운데에만 있으면(2*3) 짝이 없어 표지가 아니다 — 그대로 둔다. 둘 이상이거나 조각 끝이면 막는다.
  const stars = [...text].filter((char) => char === '*').length
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const prev = index === 0 ? '' : text[index - 1] ?? ''
    const loneStar = char === '*' && stars === 1 && index > 0 && index < text.length - 1
    if (char === '\\' || (char === '*' && !loneStar) || char === '`' || char === '[' || char === ']') out += `\\${char}`
    else if (char === '~' && (text[index + 1] === '~' || prev === '~')) out += '\\~'
    else if (char === '_' && !/[\p{L}\p{N}]/u.test(prev)) out += '\\_'
    else if (char === '<' && /[A-Za-z/]/.test(text[index + 1] ?? '')) out += '\\<'
    else out += char
  }
  return out
}

/** 문단 줄 첫머리가 블록 표지로 읽히지 않게 — `#` `>` `-` `+` `1.` 펜스·가로줄. */
function escapeLineStarts(text: string): string {
  return text.split('\n').map((line) => {
    if (/^(#{1,6}(\s|$)|>|[-+](\s|$)|\d+[.)](\s|$)|~~~|-{3,}|={3,})/.test(line)) return `\\${line}`
    return line
  }).join('\n')
}

// --- markdown → ADF ---

export function markdownToAdf(markdown: string): AdfDoc {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  return { type: 'doc', version: 1, content: parseBlocks(lines) }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line)
}

function parseBlocks(lines: string[]): AdfNode[] {
  const out: AdfNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const mark = fence[1] ?? '```'
      const body: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`).test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const text = body.join('\n')
      const node: AdfNode = { type: 'codeBlock', content: text.length === 0 ? [] : [{ type: 'text', text }] }
      if ((fence[2] ?? '') !== '') node.attrs = { language: fence[2] }
      out.push(node)
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      out.push({ type: 'heading', attrs: { level: (heading[1] ?? '#').length }, content: parseInline(heading[2] ?? '') })
      index += 1
      continue
    }
    if (RULE.test(line) && !(LIST.test(line) && !/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line))) {
      out.push({ type: 'rule' })
      index += 1
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        body.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '')
        index += 1
      }
      out.push({ type: 'blockquote', content: parseBlocks(body) })
      continue
    }
    if (LIST.test(line)) {
      const parsed = parseList({ lines, start: index })
      out.push(...parsed.nodes)
      index = parsed.next
      continue
    }
    const body: string[] = []
    while (index < lines.length && (lines[index] ?? '').trim() !== '' && (body.length === 0 || !startsBlock(lines[index] ?? ''))) {
      body.push(lines[index] ?? '')
      index += 1
    }
    out.push({ type: 'paragraph', content: parseInline(body.join('\n')) })
  }
  return out
}

type ListItemLines = { ordered: boolean; number: number; task: boolean | null; lines: string[] }

/** 목록 하나 — 같은 들여쓰기의 항목들. 항목 내용은 표지 뒤 들여쓰기 이상인 줄(빈 줄 포함, 다음 줄이 들여 쓴 경우). */
function parseList({ lines, start }: { lines: string[]; start: number }): { nodes: AdfNode[]; next: number } {
  const first = LIST.exec(lines[start] ?? '')
  const baseIndent = first?.[1]?.length ?? 0
  const items: ListItemLines[] = []
  let index = start
  while (index < lines.length) {
    const match = LIST.exec(lines[index] ?? '')
    if (match === null || (match[1]?.length ?? 0) !== baseIndent) break
    const marker = match[2] ?? '-'
    const ordered = /\d/.test(marker)
    if (items.length > 0 && items[0]?.ordered !== ordered) break
    const contentOffset = baseIndent + marker.length + Math.max(1, Math.min((match[3] ?? ' ').length, 4))
    let text = match[4] ?? ''
    let task: boolean | null = null
    const box = /^\[([ xX])\](?: (.*)|$)/.exec(text)
    if (!ordered && box !== null) {
      task = box[1] !== ' '
      text = box[2] ?? ''
    }
    const body = [text]
    index += 1
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim() === '') {
        // 빈 줄 뒤에 들여 쓴 줄이 오면 이 항목의 내용이다.
        let look = index
        while (look < lines.length && (lines[look] ?? '').trim() === '') look += 1
        const after = lines[look] ?? ''
        if (look < lines.length && leading(after) >= contentOffset) {
          for (; index < look; index += 1) body.push('')
          continue
        }
        break
      }
      if (leading(next) >= contentOffset) {
        body.push(next.slice(contentOffset))
        index += 1
        continue
      }
      if (leading(next) > baseIndent && LIST.test(next)) {
        // 덜 들여 쓴 하위 목록도 이 항목 아래로(2칸 들여쓰기 관례).
        body.push(next.slice(Math.min(leading(next), contentOffset)))
        index += 1
        continue
      }
      if (startsBlock(next)) break
      // 게으른 이어 쓰기 — 문단의 다음 줄.
      body.push(next.trimStart())
      index += 1
    }
    items.push({ ordered, number: ordered ? Number.parseInt(marker, 10) : 0, task, lines: body })
  }
  return { nodes: buildLists(items), next: index }
}

function leading(line: string): number {
  return line.length - line.trimStart().length
}

/** 항목 → ADF 목록. 할 일 항목이 이어지면 taskList, 아니면 bulletList/orderedList(섞이면 끊어 만든다). */
function buildLists(items: ListItemLines[]): AdfNode[] {
  const out: AdfNode[] = []
  let run: ListItemLines[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const head = run[0]
    if (head === undefined) return
    if (head.task !== null) out.push({ type: 'taskList', attrs: { localId: '' }, content: run.flatMap(taskNodes) })
    else if (head.ordered) out.push({ type: 'orderedList', attrs: { order: head.number }, content: run.map(listItem) })
    else out.push({ type: 'bulletList', content: run.map(listItem) })
    run = []
  }
  for (const item of items) {
    const head = run[0]
    if (head !== undefined && (head.task !== null) !== (item.task !== null)) flush()
    run.push(item)
  }
  flush()
  return out
}

function listItem(item: ListItemLines): AdfNode {
  const blocks = parseBlocks(item.lines)
  return { type: 'listItem', content: blocks.length === 0 ? [{ type: 'paragraph', content: [] }] : blocks }
}

/** 할 일 항목 — 글은 인라인(ADF taskItem 은 문단을 안 쓴다), 하위 할 일 목록은 형제 taskList 로. 그 밖 하위 블록은 글로 잇는다. */
function taskNodes(item: ListItemLines): AdfNode[] {
  const blocks = parseBlocks(item.lines)
  const inline: AdfNode[] = []
  const nested: AdfNode[] = []
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      if (inline.length > 0) inline.push({ type: 'hardBreak' })
      inline.push(...(block.content ?? []))
    } else if (block.type === 'taskList') nested.push(block)
    else {
      if (inline.length > 0) inline.push({ type: 'hardBreak' })
      inline.push({ type: 'text', text: adfToMarkdown({ type: 'doc', version: 1, content: [block] }).markdown })
    }
  }
  return [{ type: 'taskItem', attrs: { localId: '', state: item.task === true ? 'DONE' : 'TODO' }, content: inline }, ...nested]
}

type Mark = AdfMark

/** 인라인 파서 — 이스케이프 · 코드 · 링크 · 굵게(`**`) · 취소선(`~~`) · 기울임(`*`·단어 경계 `_`) · 줄바꿈(hardBreak). 닫히지 않은 표지는 글. */
export function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = []
  walkInline({ text, marks: [], nodes })
  return mergeText(nodes)
}

function pushText({ nodes, text, marks }: { nodes: AdfNode[]; text: string; marks: Mark[] }): void {
  if (text.length === 0) return
  const parts = text.split('\n')
  parts.forEach((part, index) => {
    if (index > 0) nodes.push({ type: 'hardBreak' })
    // 줄 끝 강제 줄바꿈 표지(공백 둘·역슬래시)는 지운다 — 줄바꿈 하나로.
    const cleaned = index < parts.length - 1 ? part.replace(/( {2,}|\\)$/, '') : part
    if (cleaned.length > 0) nodes.push(marks.length === 0 ? { type: 'text', text: cleaned } : { type: 'text', text: cleaned, marks: marks.map((mark) => ({ ...mark })) })
  })
}

function walkInline({ text, marks, nodes }: { text: string; marks: Mark[]; nodes: AdfNode[] }): void {
  let buffer = ''
  const flush = (): void => {
    pushText({ nodes, text: buffer, marks })
    buffer = ''
  }
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '\\' && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1] ?? '')) {
      buffer += text[index + 1]
      index += 2
      continue
    }
    if (char === '`') {
      const run = /^`+/.exec(text.slice(index))?.[0] ?? '`'
      const close = findCodeClose({ text, from: index + run.length, run })
      if (close >= 0) {
        flush()
        let code = text.slice(index + run.length, close).replaceAll('\n', ' ')
        if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) code = code.slice(1, -1)
        nodes.push({ type: 'text', text: code, marks: [...marks.map((mark) => ({ ...mark })), { type: 'code' }] })
        index = close + run.length
        continue
      }
      buffer += run
      index += run.length
      continue
    }
    if (char === '[' && !marks.some((mark) => mark.type === 'link')) {
      const link = findLink({ text, from: index })
      if (link !== null) {
        flush()
        walkInline({ text: link.label, marks: [...marks, { type: 'link', attrs: { href: link.href } }], nodes })
        index = link.end
        continue
      }
    }
    const pair = char === '*' && text[index + 1] === '*' ? '**' : char === '~' && text[index + 1] === '~' ? '~~' : null
    if (pair !== null) {
      const type = pair === '**' ? 'strong' : 'strike'
      const close = findClose({ text, from: index + 2, mark: pair })
      if (close >= 0 && !marks.some((mark) => mark.type === type) && !/\s/.test(text[index + 2] ?? ' ')) {
        flush()
        walkInline({ text: text.slice(index + 2, close), marks: [...marks, { type }], nodes })
        index = close + 2
        continue
      }
      buffer += pair
      index += 2
      continue
    }
    if ((char === '*' || char === '_') && !marks.some((mark) => mark.type === 'em') && !/\s/.test(text[index + 1] ?? ' ')) {
      const before = index === 0 ? '' : text[index - 1] ?? ''
      const wordStart = char === '*' || !/[\p{L}\p{N}]/u.test(before)
      const close = wordStart ? findClose({ text, from: index + 1, mark: char }) : -1
      if (close > index + 1) {
        flush()
        walkInline({ text: text.slice(index + 1, close), marks: [...marks, { type: 'em' }], nodes })
        index = close + 1
        continue
      }
    }
    buffer += char
    index += 1
  }
  flush()
}

function findCodeClose({ text, from, run }: { text: string; from: number; run: string }): number {
  let index = from
  while (index < text.length) {
    const at = text.indexOf(run, index)
    if (at < 0) return -1
    const longer = text[at + run.length] === '`' || text[at - 1] === '`'
    if (!longer) return at
    index = at + 1
    while (text[index] === '`') index += 1
  }
  return -1
}

/** 닫는 표지 — 코드 구간·이스케이프를 건너뛰고, 앞 글자가 공백이 아닌 자리. `_` 는 뒤가 단어 글자가 아니어야, `*` 하나는 `**` 의 일부가 아니어야. */
function findClose({ text, from, mark }: { text: string; from: number; mark: string }): number {
  let index = from
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '`') {
      const run = /^`+/.exec(text.slice(index))?.[0] ?? '`'
      const close = findCodeClose({ text, from: index + run.length, run })
      index = close < 0 ? index + run.length : close + run.length
      continue
    }
    if (text.startsWith(mark, index) && index > from && !/\s/.test(text[index - 1] ?? ' ')) {
      if (mark === '_' && /[\p{L}\p{N}]/u.test(text[index + 1] ?? '')) {
        index += 1
        continue
      }
      if (mark === '*' && (text[index + 1] === '*' || text[index - 1] === '*')) {
        // `**` 안쪽의 `*` 는 기울임 닫기가 아니다 — 굵게 쌍을 통째로 건너뛴다.
        if (text[index + 1] === '*') {
          const strongClose = findClose({ text, from: index + 2, mark: '**' })
          index = strongClose < 0 ? index + 2 : strongClose + 2
          continue
        }
      }
      return index
    }
    index += 1
  }
  return -1
}

function findLink({ text, from }: { text: string; from: number }): { label: string; href: string; end: number } | null {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '[') depth += 1
    if (char === ']') {
      depth -= 1
      if (depth === 0) {
        if (text[index + 1] !== '(') return null
        const close = text.indexOf(')', index + 2)
        if (close < 0) return null
        const href = text.slice(index + 2, close).trim()
        if (href.length === 0 || /\s/.test(href)) return null
        return { label: text.slice(from + 1, index), href, end: close + 1 }
      }
    }
  }
  return null
}

function sameMarks(a: AdfMark[] | undefined, b: AdfMark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
}

function mergeText(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = []
  for (const node of nodes) {
    const last = out.at(-1)
    if (last !== undefined && last.type === 'text' && node.type === 'text' && sameMarks(last.marks, node.marks)) last.text = `${last.text ?? ''}${node.text ?? ''}`
    else out.push(node)
  }
  return out
}

// --- 체크 칸 (C6③) ---

/** 문서 순서의 할 일 상태(DONE = true). */
export function taskStates(doc: AdfDoc): boolean[] {
  const states: boolean[] = []
  const walk = (nodes: AdfNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'taskItem') states.push(node.attrs?.state === 'DONE')
      if (node.content !== undefined) walk(node.content)
    }
  }
  walk(doc.content)
  return states
}

/** 원래 ADF 의 `taskItem.attrs.state` 만 바꾼 사본 — 개수가 다르면 null. 다른 노드·속성은 그대로(바꿀 수 없는 요소 포함). */
export function withTaskStates({ doc, states }: { doc: AdfDoc; states: boolean[] }): AdfDoc | null {
  if (taskStates(doc).length !== states.length) return null
  let at = 0
  const walk = (nodes: AdfNode[]): AdfNode[] => nodes.map((node) => {
    const next: AdfNode = { ...node }
    if (node.type === 'taskItem') {
      next.attrs = { ...(node.attrs ?? {}), state: states[at] === true ? 'DONE' : 'TODO' }
      at += 1
    }
    if (node.content !== undefined) next.content = walk(node.content)
    return next
  })
  return { type: 'doc', version: 1, content: walk(doc.content) }
}

/** 지원 표 안의 노드만 있는가 — 시험·출처가 쓴다. */
export function isSupportedNode(type: string): boolean {
  return BLOCKS.has(type) || INLINES.has(type)
}
