// 대화 화면 표시 규칙 (LIFE-581 X9 · 579 Q4·Q5·Q9) — 순수 함수(단위 시험 대상, Y6ⓓ). RN 을 모른다.
//
// - 도구 묶음 머리: `도구 9회 · Read 5 · Edit 2 · Bash 2`(이름 많은 순 3개) · 상세 없는 묶음은 `도구 실행 N회`(C15).
// - 진행 줄: 묶음 안 마지막 「실행 중」 도구 하나 — 대화의 마지막 말풍선이고 세션이 작업 중일 때만 그린다(Q4 「지금 무엇을 하나」).
// - 긴 답: 24줄을 넘으면 접고 `나머지 N줄 더 보기`(Q9). 접기는 원문 줄 기준 — 코드 블록 안에서 끊기면 그 블록은 닫힌 것으로 그린다.
// - 마크다운: 단락·제목·목록·인용·가로줄·코드 블록(```)·표(GFM 파이프). 인라인은 굵게(**)·코드(`) 만. 의존성 없이 한 파일로(Y11 — 새 네이티브 의존성 0).
import type { ChatItem, ChatTool } from './chat'

export const ANSWER_FOLD_LINES = 24
/** 표가 이만큼 열 이상이면 블록 안 가로 스크롤(Q9). */
export const TABLE_SCROLL_COLUMNS = 4

type ToolsItem = Extract<ChatItem, { kind: 'tools' }>

export function toolSummary(item: ToolsItem): string {
  if (!item.detail) return `도구 실행 ${item.count}회`
  const top = Object.entries(item.names)
    .filter(([name]) => name !== '?')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, count]) => `${name} ${count}`)
  return [`도구 ${item.count}회`, ...top].join(' · ')
}

/** 묶음 안 마지막 실행 중 도구 — 없으면 null. */
export function runningTool(item: ToolsItem): ChatTool | null {
  for (let i = item.tools.length - 1; i >= 0; i -= 1) {
    const tool = item.tools[i]
    if (tool !== undefined && tool.status === 'running') return tool
  }
  return null
}

export function toolLine(tool: ChatTool): string {
  if (tool.name === null) return tool.target ?? '도구'
  return tool.target === null ? tool.name : `${tool.name} ${tool.target}`
}

export function foldText(input: { text: string; expanded: boolean; maxLines?: number }): { text: string; hiddenLines: number } {
  const max = input.maxLines ?? ANSWER_FOLD_LINES
  const lines = input.text.split('\n')
  if (input.expanded || lines.length <= max) return { text: input.text, hiddenLines: 0 }
  return { text: lines.slice(0, max).join('\n'), hiddenLines: lines.length - max }
}

export type Span = { text: string; bold: boolean; code: boolean }

export type Block =
  | { kind: 'para'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/

function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

export function markdownBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'para', text: para.join('\n') })
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = FENCE.exec(line)
    if (fence !== null) {
      flush()
      const marker = fence[1] ?? '```'
      const body: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker.slice(0, 3))) {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1 // 닫는 줄(없으면 끝)
      blocks.push({ kind: 'code', lang: fence[2] === '' || fence[2] === undefined ? null : fence[2], text: body.join('\n') })
      continue
    }
    if (line.includes('|') && TABLE_DIVIDER.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      flush()
      const header = splitRow(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitRow(lines[i] ?? ''))
        i += 1
      }
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    if (line.trim() === '') {
      flush()
      i += 1
      continue
    }
    if (RULE.test(line)) {
      flush()
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
      i += 1
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      flush()
      const ordered = item[2] !== undefined
      const items: string[] = []
      while (i < lines.length) {
        const match = LIST_ITEM.exec(lines[i] ?? '')
        if (match === null || (match[2] !== undefined) !== ordered) break
        items.push(match[3] ?? '')
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    if (line.trimStart().startsWith('>')) {
      flush()
      const quote: string[] = []
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('>')) {
        quote.push((lines[i] ?? '').trimStart().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', text: quote.join('\n') })
      continue
    }
    para.push(line)
    i += 1
  }
  flush()
  return blocks
}

/** 인라인 — `코드` 와 **굵게** 만. 나머지 기호는 글자 그대로. */
export function inlineSpans(text: string): Span[] {
  const spans: Span[] = []
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) spans.push({ text: text.slice(last, index), bold: false, code: false })
    if (match[2] !== undefined) spans.push({ text: match[2], bold: false, code: true })
    else spans.push({ text: match[3] ?? '', bold: true, code: false })
    last = index + match[0].length
  }
  if (last < text.length) spans.push({ text: text.slice(last), bold: false, code: false })
  return spans
}

/** 에이전트 답 머리(아바타·이름·시각)를 그릴 말풍선 — 지시 뒤 첫 에이전트 쪽 말풍선(답·묶음)마다 한 번(「첫 덩어리에만 머리」). */
export function replyHeads(items: readonly ChatItem[]): Set<number> {
  const heads = new Set<number>()
  let open = true
  for (const item of items) {
    if (item.kind === 'prompt') {
      open = true
      continue
    }
    if (item.kind === 'reply' && open) {
      heads.add(item.id)
      open = false
    }
  }
  return heads
}

export type NoteView = { title: string; detail: string | null; tone: 'alert' | 'muted' }

export function noteView(item: Extract<ChatItem, { kind: 'note' }>): NoteView {
  switch (item.note) {
    case 'interrupted':
      return { title: '중단됨', detail: item.text, tone: 'alert' }
    case 'failed':
      return { title: '실패', detail: item.text ?? '사유를 알 수 없습니다', tone: 'alert' }
    case 'compacted':
      return { title: '대화 압축됨', detail: '이 위는 압축 전 대화입니다', tone: 'muted' }
  }
}

export function questionLine(item: Extract<ChatItem, { kind: 'question' }>): string {
  const first = item.questions[0]
  const text = first === undefined ? '질문' : first.header !== null && first.header.trim() !== '' ? `${first.header} — ${first.question}` : first.question
  return item.questions.length > 1 ? `${text} 외 ${item.questions.length - 1}` : text
}

/** 대화 화면 본문 상태(Y6ⓔ) — 받기 전·실패를 「빈 대화」 로 그리지 않는다. */
export type BodyState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'items' }
  | { kind: 'failed'; title: string; detail: string; retry: boolean }

export function bodyState(input: { phase: { kind: string; reason?: string }; count: number }): BodyState {
  const { phase } = input
  switch (phase.kind) {
    case 'ready':
      return input.count === 0 ? { kind: 'empty' } : { kind: 'items' }
    case 'unavailable':
      return { kind: 'failed', ...unavailableText(phase.reason ?? ''), retry: phase.reason === 'not_ready' || phase.reason === 'unreadable' }
    case 'failed':
      if (phase.reason === 'rejected') return { kind: 'failed', title: '맥이 대화를 보내지 않습니다', detail: '맥의 corral 을 업데이트해 주세요', retry: false }
      if (phase.reason === 'invalid') return { kind: 'failed', title: '대화 형식이 맞지 않습니다', detail: '앱이나 맥의 corral 을 업데이트해 주세요', retry: false }
      return { kind: 'failed', title: '대화 응답이 없습니다', detail: '맥이 응답하지 않습니다 — 다시 시도해 주세요', retry: true }
    default:
      return input.count === 0 ? { kind: 'loading' } : { kind: 'items' }
  }
}

function unavailableText(reason: string): { title: string; detail: string } {
  switch (reason) {
    case 'no_session':
      return { title: '이 세션의 기록을 찾을 수 없습니다', detail: '세션 정보가 없는 채널입니다' }
    case 'no_file':
      return { title: '대화 기록 파일이 없습니다', detail: '맥에서 기록이 지워졌거나 아직 만들어지지 않았습니다' }
    case 'not_listed':
      return { title: '이 세션은 지금 목록에 없습니다', detail: '목록에서 다시 열어 주세요' }
    case 'not_ready':
      return { title: '맥이 아직 세션 상태를 읽지 못했습니다', detail: '잠시 뒤 다시 시도해 주세요' }
    case 'unreadable':
      return { title: '대화 기록을 읽지 못했습니다', detail: '다시 시도해 주세요' }
    default:
      return { title: '대화를 열 수 없습니다', detail: reason }
  }
}

/** 도구 줄 표식 — `unknown` 은 성공도 실패도 아닌 중립(결과를 기록에서 못 읽음, R1-A9). */
export function toolMark(status: ChatTool['status']): { mark: string; tone: 'error' | 'running' | 'muted' } {
  switch (status) {
    case 'error':
      return { mark: '✕', tone: 'error' }
    case 'running':
      return { mark: '…', tone: 'running' }
    case 'unknown':
      return { mark: '·', tone: 'muted' }
    case 'ok':
      return { mark: '✓', tone: 'muted' }
  }
}

/**
 * 지금 상태 카드(C8 중단됨 · C9 실패, X2ⓔ · R1-A6) — 목록 채널의 지금 점(`agentState`·`turnOutcome` 을 합친 값)이 중단·실패면 대화 끝에 한 장.
 * 기록에서 낸 같은 종류 카드가 **최신 턴**(마지막 내 지시 뒤)에 이미 있으면 그리지 않는다(같은 턴 중복 없음). 지난 턴의 기록 카드는 제자리에 그대로.
 */
export function stateCard(input: { dot: string; live: boolean; errorText: string | null; items: readonly ChatItem[] }): { note: 'interrupted' | 'failed'; text: string | null } | null {
  if (!input.live) return null
  const note = input.dot === 'interrupted' ? 'interrupted' : input.dot === 'failed' ? 'failed' : null
  if (note === null) return null
  let lastPrompt = -1
  input.items.forEach((item, index) => {
    if (item.kind === 'prompt') lastPrompt = index
  })
  const latestTurn = input.items.slice(lastPrompt + 1)
  if (latestTurn.some((item) => item.kind === 'note' && item.note === note)) return null
  return { note, text: note === 'failed' ? input.errorText : null }
}

/** 다시 구독이 실패해 들고 있는 본문이 최신이 아닐 수 있다(R1-A7) — 띠 글. */
export function staleText(stale: 'timeout' | 'rejected' | 'invalid'): { title: string; retry: boolean } {
  switch (stale) {
    case 'timeout':
      return { title: '대화를 새로 받지 못했습니다 · 지난 내용입니다', retry: true }
    case 'rejected':
      return { title: '맥이 대화를 보내지 않습니다 · 맥의 corral 을 업데이트해 주세요', retry: false }
    case 'invalid':
      return { title: '대화 형식이 맞지 않습니다 · 앱이나 맥의 corral 을 업데이트해 주세요', retry: false }
  }
}

/** 일부 말풍선을 못 읽었다(R1-A8) — 대화 끝 안내. */
export function droppedText(dropped: number): string | null {
  return dropped > 0 ? `읽지 못한 말풍선 ${dropped}개를 건너뛰었습니다 · 앱을 업데이트해 주세요` : null
}
