// LIFE-605 수정 1 R1-A·R1-G — Jira 편집기 모양 ADF 에서 출발하는 말뭉치 + 고정 씨앗 왕복 퍼즈.
// 지켜야 할 것: **조용한 변경 0** — 잠기지 않은 본문은 「보이는 md 를 그대로(또는 덧붙여) 저장해도 원래 요소가 같다」, 못 지키는 모양은 잠긴다.
// 말뭉치 = 리뷰 r1 재현(`raw/review/claude-r1-raw/scratch/zz-review-adf-real.test.ts` · E5) + Jira 편집기가 실제로 내는 노드 마크·링크 속성 모양.
import { describe, expect, it } from 'vitest'
import { adfRuleProblem, adfToMarkdown, adfView, canonicalAdf, losesGaps, markdownToAdf, sameAdf, type AdfDoc, type AdfMark, type AdfNode } from './adf.js'
import { bodyUpdate } from './jira-source.js'

const t = (text: string, marks?: AdfMark[]): AdfNode => (marks === undefined ? { type: 'text', text } : { type: 'text', text, marks })
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content })
const doc = (...content: AdfNode[]): AdfDoc => ({ type: 'doc', version: 1, content })
const link = (href: string, extra: Record<string, unknown> = {}): AdfMark => ({ type: 'link', attrs: { href, ...extra } })

/**
 * 독립 투영 오라클(R2-B) — `canonicalAdf` 를 쓰지 않고 사람이 보는 것만 꺼낸다: 블록 구조(종류 · 제목 수준 · 목록 시작 · 코드 언어 · 할 일 상태)와
 * 글 조각마다 보이는 글 · 마크 집합 · 링크 href. 정규형이 약해져도(마크·속성을 같게 보면) 이 비교가 깬다. 보이지 않는 차이만 같게 본다 —
 * 공백 글자의 굵게·기울임·취소선 · 제목 양끝 공백 · 내용 없는 문단 · 조각 나눔.
 */
type Seen = { text: string; marks: string } | { block: string } | { end: string }

export function visible(nodes: AdfNode[] | undefined): Seen[] {
  const out: Seen[] = []
  let runs: { text: string; marks: string }[] = []
  const flush = (): void => {
    out.push(...runs.filter((run) => run.text !== ''))
    runs = []
  }
  for (const node of nodes ?? []) {
    if (node.type === 'text' || node.type === 'hardBreak') {
      for (const char of node.type === 'hardBreak' ? '\n' : (node.text ?? '')) {
        const marks = (node.marks ?? []).filter((mark) => !(/^\s$/u.test(char) && ['strong', 'em', 'strike'].includes(mark.type))).map((mark) => (mark.type === 'link' ? `link(${String(mark.attrs?.href)})` : mark.type)).sort().join('+')
        const last = runs.at(-1)
        if (last !== undefined && last.marks === marks) last.text += char
        else runs.push({ text: char, marks })
      }
      continue
    }
    flush()
    const block = node.type === 'heading' ? `heading${String(node.attrs?.level)}` : node.type === 'orderedList' ? `orderedList${String(node.attrs?.order ?? 1)}` : node.type === 'codeBlock' ? `codeBlock:${String(node.attrs?.language ?? '')}` : node.type === 'taskItem' ? `taskItem:${String(node.attrs?.state)}` : node.type
    const inner = visible(node.content)
    if (node.type === 'heading') {
      const first = inner[0]
      if (first !== undefined && 'text' in first) first.text = first.text.replace(/^\s+/u, '')
      const last = inner.at(-1)
      if (last !== undefined && 'text' in last) last.text = last.text.replace(/\s+$/u, '')
    }
    const shown = inner.filter((entry) => !('text' in entry && entry.text === ''))
    if (node.type === 'paragraph' && shown.length === 0) continue
    out.push({ block }, ...shown, { end: node.type })
  }
  flush()
  return out
}

const sameVisible = ({ a, b }: { a: AdfNode[]; b: AdfNode[] }): boolean => JSON.stringify(visible(a)) === JSON.stringify(visible(b))

/**
 * ADF 스키마 오라클(R3-A) — 공식 ADF JSON Schema(`@atlaskit/adf-schema@40.10.0` `json-schema/v1/full.json`, sha256 앞 16자 `d1e48e901f5b5436`, Apache-2.0)의
 * 이 코덱이 내는 노드(문단·제목·목록·할 일·코드·인용·가로줄·글·줄바꿈 + 마크 strong·em·strike·code·link) 규칙을 시험 쪽에 옮겨 적은 작은 검사기다 — 제품의 `adfRuleProblem` 과 따로 썼다.
 * 라이브러리(ajv·adf-schema)는 넣지 않았다(의존성 0 — design-notes §8). 옮긴 규칙: 칸 이름(additionalProperties false) · 필수 칸 · 자식 종류(목록 항목은 첫 자식 문단·코드, 뒤는 문단·목록·할 일·코드 /
 * 인용은 문단·목록·코드 · 할 일 목록은 첫 자식 할 일) · minItems 1(목록·인용·목록 항목·할 일 목록) · 글 minLength 1 · 코드 글자 마크는 code·link 만 · 코드 블록 글자는 마크 없음 · 문단·제목은 목록 항목·인용 안에서 마크 없음.
 * 스키마 튜플(`items: [첫, 둘째]`)은 셋째 뒤를 묶지 않지만 여기서는 둘째 규칙을 뒤 전부에 건다(더 엄격).
 */
export function schemaProblems(value: AdfDoc): string[] {
  const out: string[] = []
  const keys = ({ node, allowed, at }: { node: object; allowed: string[]; at: string }): void => {
    for (const key of Object.keys(node)) if (!allowed.includes(key)) out.push(`${at}: 칸 ${key}`)
  }
  const attrsOk = ({ node, allowed, required, at }: { node: AdfNode; allowed: Record<string, (v: unknown) => boolean>; required: string[]; at: string }): void => {
    if (node.attrs === undefined) { if (required.length > 0) out.push(`${at}: attrs 없음`); return }
    for (const [key, v] of Object.entries(node.attrs)) if (allowed[key] === undefined || !(allowed[key] ?? (() => false))(v)) out.push(`${at}: attrs.${key}`)
    for (const key of required) if (node.attrs[key] === undefined) out.push(`${at}: attrs.${key} 없음`)
  }
  const isString = (v: unknown): boolean => typeof v === 'string'
  const inline = (nodes: AdfNode[] | undefined, at: string): void => {
    for (const [index, node] of (nodes ?? []).entries()) {
      const here = `${at}/${index}`
      if (node.type === 'hardBreak') { keys({ node, allowed: ['type', 'attrs'], at: here }); attrsOk({ node, allowed: { text: (v) => v === '\n' }, required: [], at: here }); continue }
      if (node.type !== 'text') { out.push(`${here}: 인라인 ${node.type}`); continue }
      keys({ node, allowed: ['type', 'text', 'marks'], at: here })
      if (typeof node.text !== 'string' || node.text.length === 0) out.push(`${here}: 빈 글`)
      const marks = node.marks ?? []
      const types = marks.map((mark) => mark.type)
      const formatted = types.every((type) => ['link', 'em', 'strong', 'strike'].includes(type))
      const code = types.every((type) => ['code', 'link'].includes(type))
      if (!formatted && !code) out.push(`${here}: 마크 조합 ${types.join('+')}`)
      for (const mark of marks) {
        if (mark.type === 'link') {
          keys({ node: mark, allowed: ['type', 'attrs'], at: `${here} link` })
          const attrs = mark.attrs ?? {}
          if (typeof attrs.href !== 'string') out.push(`${here}: link href`)
          for (const [key, v] of Object.entries(attrs)) if (!['href', 'title', 'id', 'collection', 'occurrenceKey'].includes(key) || typeof v !== 'string') out.push(`${here}: link attrs.${key}`)
        } else keys({ node: mark, allowed: ['type'], at: `${here} ${mark.type}` })
      }
    }
  }
  const noMarks = (node: AdfNode, at: string): void => { if ((node.marks ?? []).length > 0) out.push(`${at}: 블록 마크`) }
  const block = ({ node, at, nested }: { node: AdfNode; at: string; nested: boolean }): void => {
    const content = node.content ?? []
    const kids = ({ allowed, first, min }: { allowed: string[]; first?: string[]; min: number }): void => {
      if (node.content === undefined && min > 0) out.push(`${at}: content 없음`)
      if (content.length < min) out.push(`${at}: 자식 ${content.length} < ${min}`)
      content.forEach((child, index) => {
        const ok = index === 0 && first !== undefined ? first : allowed
        if (!ok.includes(child.type)) out.push(`${at}/${index}: ${node.type} 안 ${child.type}`)
        block({ node: child, at: `${at}/${index}`, nested: true })
      })
    }
    switch (node.type) {
      case 'paragraph':
        keys({ node, allowed: ['type', 'marks', 'attrs', 'content'], at })
        attrsOk({ node, allowed: { localId: isString }, required: [], at })
        if (nested) noMarks(node, at)
        return inline(node.content, at)
      case 'heading':
        keys({ node, allowed: ['type', 'marks', 'attrs', 'content'], at })
        attrsOk({ node, allowed: { level: (v) => typeof v === 'number' && v >= 1 && v <= 6, localId: isString }, required: ['level'], at })
        if (nested) noMarks(node, at)
        return inline(node.content, at)
      case 'bulletList':
        keys({ node, allowed: ['type', 'content'], at })
        return kids({ allowed: ['listItem'], min: 1 })
      case 'orderedList':
        keys({ node, allowed: ['type', 'attrs', 'content'], at })
        attrsOk({ node, allowed: { order: (v) => typeof v === 'number' && v >= 0 }, required: [], at })
        return kids({ allowed: ['listItem'], min: 1 })
      case 'listItem':
        keys({ node, allowed: ['type', 'content'], at })
        return kids({ first: ['paragraph', 'codeBlock'], allowed: ['paragraph', 'bulletList', 'orderedList', 'taskList', 'codeBlock'], min: 1 })
      case 'taskList':
        keys({ node, allowed: ['type', 'attrs', 'content'], at })
        attrsOk({ node, allowed: { localId: isString }, required: ['localId'], at })
        return kids({ first: ['taskItem'], allowed: ['taskItem', 'taskList'], min: 1 })
      case 'taskItem':
        keys({ node, allowed: ['type', 'attrs', 'content'], at })
        attrsOk({ node, allowed: { localId: isString, state: (v) => v === 'TODO' || v === 'DONE' }, required: ['localId', 'state'], at })
        return inline(node.content, at)
      case 'codeBlock':
        keys({ node, allowed: ['type', 'marks', 'attrs', 'content'], at })
        attrsOk({ node, allowed: { language: isString }, required: [], at })
        if (nested) noMarks(node, at)
        for (const [index, child] of content.entries()) {
          if (child.type !== 'text' || typeof child.text !== 'string' || child.text.length === 0 || (child.marks ?? []).length > 0) out.push(`${at}/${index}: 코드 블록 글`)
        }
        return
      case 'blockquote':
        keys({ node, allowed: ['type', 'content'], at })
        return kids({ allowed: ['paragraph', 'orderedList', 'bulletList', 'codeBlock'], min: 1 })
      case 'rule':
        return keys({ node, allowed: ['type'], at })
      default:
        out.push(`${at}: 오라클 밖 노드 ${node.type}`)
    }
  }
  keys({ node: value, allowed: ['type', 'version', 'content'], at: 'doc' })
  if (value.type !== 'doc' || value.version !== 1) out.push('doc: type·version')
  value.content.forEach((node, index) => {
    if (!['paragraph', 'heading', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'blockquote', 'rule'].includes(node.type)) out.push(`doc/${index}: 최상위 ${node.type}`)
    block({ node, at: `doc/${index}`, nested: false })
  })
  return out
}

/** 편집할 수 있어야 하는 모양 — 왕복이 원래와 같다(잠그지 않는다). */
export const EDITABLE: Record<string, AdfDoc> = {
  wikiUrl: doc(p(t('see '), t('Foo (bar)', [link('https://en.wikipedia.org/wiki/Foo_(bar)')]))),
  urlWithSpace: doc(p(t('문서', [link('https://example.com/a b')]))),
  urlBare: doc(p(t('https://example.com/a_b_c?x=1&y=2~z'))),
  cpp: doc(p(t('std::vector<int> v; a*b*c; x_y_z; 3 * 4'))),
  winPath: doc(p(t('C:\\Users\\me\\file_name.txt and \\n'))),
  hashIssue: doc(p(t('fix #123 (see PR) - done + more'))),
  numbered: doc(p(t('1. not a list'))),
  numberedParen: doc(p(t('2) 둘째 아님'))),
  yearDot: doc(p(t('2024. 올해 계획'))),
  numberedAfterBreak: doc(p(t('첫 줄'), { type: 'hardBreak' }, t('3. 목록 아님'))),
  dashStart: doc(p(t('- not a list'))),
  hashStart: doc(p(t('# 제목 아님'))),
  quoteStart: doc(p(t('> 인용 아님'))),
  strongMid: doc(p(t('un'), t('believ', [{ type: 'strong' }]), t('able'))),
  emBeforeWord: doc(p(t('un', [{ type: 'em' }]), t('believable'))),
  emAfterWord: doc(p(t('believ'), t('able', [{ type: 'em' }]))),
  emWord: doc(p(t('snake_case', [{ type: 'em' }]), t(' and '), t('x', [{ type: 'strong' }, { type: 'em' }]))),
  boldTrailingSpace: doc(p(t('Steps: ', [{ type: 'strong' }]), t('open the app'))),
  boldLeadingSpace: doc(p(t('앞'), t(' 굵게', [{ type: 'strong' }]))),
  strikeSpaces: doc(p(t(' 지움 ', [{ type: 'strike' }]), t('끝'))),
  boldRunAcrossNodes: doc(p(t('굵고 ', [{ type: 'strong' }]), t('기울어진', [{ type: 'strong' }, { type: 'em' }]), t(' 글', [{ type: 'strong' }]))),
  codeWithTicks: doc(p(t('use '), t('a`b', [{ type: 'code' }]), t(' here'))),
  strikeTilde: doc(p(t('about ~5 items, ~ 10'))),
  htmlish: doc(p(t('<div> & <b>x</b> &amp;'))),
  listSpacing: doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('b'))] }] }] }, { type: 'listItem', content: [p(t('c'))] }] }),
  orderedNoAttrs: doc({ type: 'orderedList', content: [{ type: 'listItem', content: [p(t('하나'))] }, { type: 'listItem', content: [p(t('둘'))] }] }),
  quote: doc({ type: 'blockquote', content: [p(t('q1')), p(t('q2'))] }),
  tab: doc(p(t('a\tb'))),
  nbsp: doc(p(t('a\u00a0b'))),
  italicAfterPunct: doc(p(t('('), t('note', [{ type: 'em' }]), t(')'))),
  // Jira 새 편집기는 문단·목록에 localId 를 붙이고 빈 attrs 를 둔다 — 뜻이 없는 속성이라 잠그지 않는다.
  localIds: doc({ type: 'paragraph', attrs: { localId: 'p-1' }, content: [t('글')] }, { type: 'taskList', attrs: { localId: 'tl' }, content: [{ type: 'taskItem', attrs: { localId: 'ti', state: 'TODO' }, content: [t('할 일')] }] }),
  nullAttr: doc(p(t('링크', [link('https://e.x', { title: null })]))),
  // R2-D — 보이는 차이 없는 빈 모양(리뷰 r2 A1-LIST). 잠그지 않는다 — 그대로 저장하면 보내지 않고, 고쳐 저장하면 빈 문단만 빠진다(보이지 않음).
  trailingEmptyParagraph: doc(p(t('안녕')), { type: 'paragraph' }),
  trailingEmptyParagraphContent: doc(p(t('안녕')), { type: 'paragraph', content: [] }),
  emptyParagraphBetween: doc(p(t('a')), { type: 'paragraph' }, p(t('b'))),
  hardBreakAttrs: doc(p(t('a'), { type: 'hardBreak', attrs: { text: '\n' } }, t('b'))),
  codeBlockEmpty: doc({ type: 'codeBlock' }),
  listItemEmptyPara: doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a'))] }, { type: 'listItem', content: [{ type: 'paragraph' }] }] }),
  taskListEmptyItem: doc({ type: 'taskList', attrs: { localId: 'x' }, content: [{ type: 'taskItem', attrs: { localId: 'y', state: 'TODO' } }] }),
  headingEmpty: doc({ type: 'heading', attrs: { level: 2 } }),
  quoteEmptyParagraph: doc({ type: 'blockquote', content: [{ type: 'paragraph' }] }, p(t('뒤'))),
  // R3-A — 리뷰 r3 zz-a: 잠기지 않는데 고쳐 저장하면 스키마를 어기던 모양(빈 부모 항목 + 중첩 목록).
  emptyItemWithNestedList: doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }, { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('child'))] }] }] }] }),
  orderedEmptyFirst: doc({ type: 'orderedList', attrs: { order: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }, { type: 'orderedList', attrs: { order: 1 }, content: [{ type: 'listItem', content: [p(t('z'))] }] }] }] }),
  emptyCodeInQuote: doc({ type: 'blockquote', content: [{ type: 'codeBlock', content: [] }] }),
}

/** 잠가야 하는 모양 — 저장하면 원래 요소가 사라지거나 바뀐다. 값 = 안내에 나와야 할 이름. */
export const LOCKED: Record<string, { doc: AdfDoc; label: string }> = {
  alignCenter: { doc: doc({ type: 'paragraph', marks: [{ type: 'alignment', attrs: { align: 'center' } }], content: [t('가운데')] }), label: '정렬' },
  indentation: { doc: doc({ type: 'paragraph', marks: [{ type: 'indentation', attrs: { level: 1 } }], content: [t('들여')] }), label: '들여쓰기' },
  headingAlign: { doc: doc({ type: 'heading', attrs: { level: 2 }, marks: [{ type: 'alignment', attrs: { align: 'end' } }], content: [t('제목')] }), label: '정렬' },
  codeBreakout: { doc: doc({ type: 'codeBlock', attrs: { language: 'ts' }, marks: [{ type: 'breakout', attrs: { mode: 'wide' } }], content: [t('x')] }), label: '넓게 보기' },
  linkTitle: { doc: doc(p(t('문서', [link('https://e.x', { title: '설명' })]))), label: '서식 속성' },
  linkCollection: { doc: doc(p(t('문서', [link('https://e.x', { collection: 'c', occurrenceKey: 'k' })]))), label: '서식 속성' },
  unknownLanguage: { doc: doc({ type: 'codeBlock', attrs: { language: 'c plus plus' }, content: [t('x')] }), label: '편집기 서식' },
  unknownAttr: { doc: doc({ type: 'paragraph', attrs: { dir: 'rtl' }, content: [t('글')] }), label: '편집기 서식' },
  trailingSpacesBreak: { doc: doc(p(t('line one  '), { type: 'hardBreak' }, t('line two'))), label: '편집기 서식' },
  underline: { doc: doc(p(t('밑줄', [{ type: 'underline' }]))), label: '밑줄' },
  hugeUnknownType: { doc: doc({ type: `x${'y'.repeat(500)}`, content: [] }), label: 'xyyyy' },
}

describe('R1-A·R1-G Jira 편집기 모양 출발 말뭉치', () => {
  it(`편집 가능 ${Object.keys(EDITABLE).length}개 — 잠그지 않고, 보이는 md 를 다시 ADF 로 하면 원래와 같고, 덧붙여 저장해도 원래 부분이 그대로`, () => {
    for (const [name, original] of Object.entries(EDITABLE)) {
      // 원문도 스키마 안(말뭉치 점검) — `nullAttr` 만 예외: Jira API 응답의 null 속성(`title: null`)을 본뜬 모양이라 스키마(문자열)와 다르다. 오라클은 **나가는 쪽**에 건다.
      if (name !== 'nullAttr') expect(schemaProblems(original), `${name} 원문 스키마`).toEqual([])
      const view = adfView(original)
      expect(view.unsupported, name).toEqual([])
      expect(schemaProblems(markdownToAdf(view.markdown)), `${name} md→ADF 스키마`).toEqual([])
      expect(sameAdf({ a: markdownToAdf(view.markdown), b: original }), `${name}: ${view.markdown}`).toBe(true)
      expect(sameVisible({ a: markdownToAdf(view.markdown).content, b: original.content }), `${name} 투영: ${view.markdown}`).toBe(true)
      expect(bodyUpdate({ current: original, next: view.markdown }), name).toEqual({ ok: true })
      const edited = bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` })
      if (!edited.ok || edited.doc === undefined || edited.doc === null) throw new Error(`${name}: 저장 안 됨`)
      expect(JSON.stringify(canonicalAdf(edited.doc.content.slice(0, -1))), name).toBe(JSON.stringify(canonicalAdf(original.content)))
      expect(sameVisible({ a: edited.doc.content.slice(0, -1), b: original.content }), `${name} 투영`).toBe(true)
      expect(schemaProblems(edited.doc), `${name} 고쳐 저장 스키마`).toEqual([])
    }
  })

  it('리뷰 재현 값 — 숫자 시작 문단은 `1\\.`(글에 역슬래시 없음) · 공백 낀 굵게는 마크 밖 공백 · 단어 앞 기울임은 `*` · 괄호 주소는 `<…>`', () => {
    expect(adfView(EDITABLE.numbered ?? doc()).markdown).toBe('1\\. not a list')
    expect(adfView(EDITABLE.boldTrailingSpace ?? doc()).markdown).toBe('**Steps:** open the app')
    expect(adfView(EDITABLE.emBeforeWord ?? doc()).markdown).toBe('*un*believable')
    expect(adfView(EDITABLE.wikiUrl ?? doc()).markdown).toBe('see [Foo (bar)](<https://en.wikipedia.org/wiki/Foo_(bar)>)')
  })

  it(`잠금 ${Object.keys(LOCKED).length}개 — 이름이 안내에 나오고, 글을 고친 저장은 거절(조용히 지우지 않는다) · 원격 이름은 40자 상한`, () => {
    for (const [name, { doc: original, label }] of Object.entries(LOCKED)) {
      const view = adfView(original)
      expect(view.unsupported.length, name).toBeGreaterThan(0)
      const saved = bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` })
      expect(saved.ok, name).toBe(false)
      if (!saved.ok) {
        expect(saved.message, name).toContain(label)
        expect(saved.message.length, name).toBeLessThan(400)
      }
    }
  })
})

/** 고정 씨앗 PRNG(mulberry32) — 실행마다 같은 문서들. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['글', 'word', 'Steps:', '1.', '2)', '#', '>', '-', '+', '*', '_', '~', '~~', '`', '[', ']', '(', ')', '<b>', '&', '\\', 'a_b', '2*3', 'x', '한글', '  ', ' ', 'CORE-12', 'https://e.x/a_(b)', '---', '===']
/** 평범한 글 — 편집기에서 흔한 낱말·구두점. 이 말뭉치는 거의 다 편집할 수 있어야 한다(잠금 남용 대조). */
const PLAIN_WORDS = ['글', 'word', 'Steps:', '한글', '확인', 'CORE-12', '(참고)', '1.', '2024.', 'a_b', 'v1.2', 'e.g.,', 'TODO', '#123', '100%', 'x']
const HREFS = ['https://example.com', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://e.x/a b', 'https://e.x/?q=1&r=2', 'mailto:a@b.c']

function fuzzDoc({ random, words }: { random: () => number; words: readonly string[] }): { doc: AdfDoc; exotic: boolean } {
  const pick = <T,>(list: readonly T[]): T => {
    const value = list[Math.floor(random() * list.length)]
    if (value === undefined) throw new Error('빈 목록')
    return value
  }
  let exotic = false
  const inline = (): AdfNode[] => {
    const out: AdfNode[] = []
    const count = 1 + Math.floor(random() * 5)
    for (let index = 0; index < count; index += 1) {
      if (random() < 0.08 && out.length > 0 && out.at(-1)?.type !== 'hardBreak') { out.push({ type: 'hardBreak' }); continue }
      const text = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(words)).join(random() < 0.7 || words === PLAIN_WORDS ? ' ' : '')
      const marks: AdfMark[] = []
      if (random() < 0.25) marks.push({ type: 'strong' })
      if (random() < 0.2) marks.push({ type: 'em' })
      if (random() < 0.1) marks.push({ type: 'strike' })
      if (random() < 0.1 && marks.length === 0) marks.push({ type: 'code' })
      if (random() < 0.12) {
        const extra = random() < 0.2 ? { title: 't' } : {}
        if ('title' in extra) exotic = true
        marks.push(link(pick(HREFS), extra))
      }
      if (random() < 0.03) { marks.push({ type: 'underline' }); exotic = true }
      // 평범한 글은 조각 사이를 띄운다(단어 한가운데 서식은 적대적 쪽이 맡는다).
      if (words === PLAIN_WORDS && out.length > 0 && out.at(-1)?.type === 'text') out.push(t(' '))
      out.push(t(text, marks.length === 0 ? undefined : marks))
    }
    // 평범한 글은 끝 줄바꿈을 두지 않는다(md 로 나타낼 수 없어 잠기는 모양 — 적대적 쪽이 맡는다).
    if (words === PLAIN_WORDS && out.at(-1)?.type === 'hardBreak') out.pop()
    return out
  }
  const block = (depth: number): AdfNode => {
    const roll = random()
    if (roll < 0.45) {
      const node = p(...inline())
      // 블록 마크는 최상위 문단에만(스키마 — 목록 항목·인용 안 문단은 마크 없음).
      if (depth === 0 && random() < 0.05) { node.marks = [{ type: 'alignment', attrs: { align: 'center' } }]; exotic = true }
      return node
    }
    if (roll < 0.55) return { type: 'heading', attrs: { level: 1 + Math.floor(random() * 6) }, content: words === PLAIN_WORDS ? inline().filter((node) => node.type !== 'hardBreak') : inline() }
    // 목록 항목은 문단으로 시작하고 뒤에 중첩 목록·코드가 올 수 있다(스키마 — R3-A 로 생성기도 규칙 안).
    if (roll < 0.68 && depth < 2) return { type: 'bulletList', content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ type: 'listItem', content: words === PLAIN_WORDS || random() < 0.5 ? [p(...inline())] : [p(...inline()), itemChild(depth + 1)] })) }
    if (roll < 0.76 && depth < 2) return { type: 'orderedList', attrs: { order: 1 + Math.floor(random() * 3) }, content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ type: 'listItem', content: [p(...inline())] })) }
    if (roll < 0.84) return { type: 'taskList', attrs: { localId: 'tl' }, content: [{ type: 'taskItem', attrs: { localId: 'ti', state: random() < 0.5 ? 'DONE' : 'TODO' }, content: inline().filter((node) => node.type !== 'hardBreak') }] }
    if (roll < 0.9) return { type: 'codeBlock', attrs: { language: pick(['ts', 'python', '']) }, content: [t(Array.from({ length: 2 }, () => pick(words)).join('\n'))] }
    if (roll < 0.95 && depth < 2) return { type: 'blockquote', content: [quoteChild(depth + 1)] }
    return { type: 'rule' }
  }
  /** 스키마가 받는 자식만 — 목록 항목 뒤 자식(문단·목록·할 일·코드) · 인용 자식(문단·목록·코드). */
  const childOf = ({ depth, allowed }: { depth: number; allowed: string[] }): AdfNode => {
    for (;;) {
      const before = exotic
      const node = block(depth)
      if (allowed.includes(node.type)) return node
      exotic = before // 버린 후보의 이국 표지는 되돌린다.
    }
  }
  const itemChild = (depth: number): AdfNode => childOf({ depth, allowed: ['paragraph', 'bulletList', 'orderedList', 'taskList', 'codeBlock'] })
  const quoteChild = (depth: number): AdfNode => childOf({ depth, allowed: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'] })
  return { doc: doc(...Array.from({ length: 1 + Math.floor(random() * 4) }, () => block(0))), exotic }
}

function fuzzRun({ seed, words, rounds }: { seed: number; words: readonly string[]; rounds: number }): { editable: number; locked: number; exoticLocked: number; silent: string[] } {
  const random = prng(seed)
  let editable = 0
  let locked = 0
  let exoticLocked = 0
  const silent: string[] = []
  for (let round = 0; round < rounds; round += 1) {
    const { doc: original, exotic } = fuzzDoc({ random, words })
    if (!exotic && schemaProblems(original).length > 0) silent.push(`generator-invalid #${round}: ${schemaProblems(original)[0]}`)
    const view = adfView(original)
    if (view.unsupported.length > 0) {
      locked += 1
      if (exotic) exoticLocked += 1
      if (process.env.L605_FUZZ_DUMP === String(seed) && !exotic) {
        // 진단 전용 — 왕복이 어긋나는 첫 블록과 그 md.
        const bad = original.content.find((block) => adfView(doc(block)).unsupported.length > 0)
        if (bad !== undefined) process.stdout.write(`L605_LOCK ${JSON.stringify(adfView(doc(bad)).markdown)} ${JSON.stringify(canonicalAdf([bad])).slice(0, 200)}\n`)
        else process.stdout.write(`L605_LOCK_JOIN ${JSON.stringify(view.markdown).slice(0, 200)}\n`)
      }
      if (bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` }).ok) silent.push(`locked-but-saved #${round}`)
      continue
    }
    if (exotic) silent.push(`exotic-not-locked #${round}: ${view.markdown.slice(0, 80)}`)
    editable += 1
    if (!sameAdf({ a: markdownToAdf(view.markdown), b: original })) silent.push(`roundtrip #${round}`)
    if (!sameVisible({ a: markdownToAdf(view.markdown).content, b: original.content })) silent.push(`visible #${round}: ${view.markdown.slice(0, 80)}`)
    const parsedProblems = schemaProblems(markdownToAdf(view.markdown))
    if (parsedProblems.length > 0) silent.push(`md-schema #${round}: ${parsedProblems[0]}`)
    if (adfView(markdownToAdf(view.markdown)).markdown !== view.markdown) silent.push(`not-fixed-point #${round}: ${view.markdown.slice(0, 80)}`)
    const edited = bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` })
    if (!edited.ok || edited.doc === undefined || edited.doc === null) silent.push(`edit-refused #${round}`)
    else if (JSON.stringify(canonicalAdf(edited.doc.content.slice(0, -1))) !== JSON.stringify(canonicalAdf(original.content))) silent.push(`edit-changed #${round}: ${view.markdown.slice(0, 80)}`)
    else if (!sameVisible({ a: edited.doc.content.slice(0, -1), b: original.content })) silent.push(`edit-visible #${round}: ${view.markdown.slice(0, 80)}`)
    else if (schemaProblems(edited.doc).length > 0) silent.push(`edit-schema #${round}: ${schemaProblems(edited.doc)[0]}`)
  }
  return { editable, locked, exoticLocked, silent }
}

describe('R2-B·R2-D 독립 투영 오라클 · 빈 모양 · 잠금 안내', () => {
  it('투영은 마크 종류·href·제목 수준·목록 시작·코드 언어·할 일 상태가 다르면 다르고, 보이지 않는 차이(조각 나눔·공백 굵게·빈 문단·localId)는 같다', () => {
    const base = doc(p(t('굵게', [{ type: 'strong' }]), t(' 링크', [link('https://a.x')])))
    const differs: AdfDoc[] = [
      doc(p(t('굵게', [{ type: 'em' }]), t(' 링크', [link('https://a.x')]))),
      doc(p(t('굵게', [{ type: 'strong' }]), t(' 링크', [link('https://b.x')]))),
      doc(p(t('굵게', [{ type: 'strong' }]), t(' 링크'))),
      doc(p(t('굵게', [{ type: 'strong' }]), t(' 링크', [link('https://a.x'), { type: 'code' }]))),
    ]
    for (const other of differs) expect(sameVisible({ a: base.content, b: other.content }), JSON.stringify(other)).toBe(false)
    const same = doc({ type: 'paragraph', attrs: { localId: 'q' }, content: [t('굵'), t('게', [{ type: 'strong' }]), t(' ', [{ type: 'strong' }, link('https://a.x')]), t('링크', [link('https://a.x')])] }, { type: 'paragraph' })
    const shifted = doc(p(t('굵'), t('게', [{ type: 'strong' }]), t(' 링크', [link('https://a.x')])))
    expect(sameVisible({ a: same.content, b: shifted.content })).toBe(true)
    const blocks: [AdfNode, AdfNode][] = [
      [{ type: 'heading', attrs: { level: 2 }, content: [t('제')] }, { type: 'heading', attrs: { level: 3 }, content: [t('제')] }],
      [{ type: 'orderedList', attrs: { order: 2 }, content: [] }, { type: 'orderedList', content: [] }],
      [{ type: 'codeBlock', attrs: { language: 'ts' }, content: [t('x')] }, { type: 'codeBlock', content: [t('x')] }],
      [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('x')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('x')] }],
    ]
    for (const [a, b] of blocks) expect(sameVisible({ a: [a], b: [b] }), a.type).toBe(false)
  })

  it('R2-D 빈 모양은 그대로 저장하면 보내지 않는다(원래 ADF 보존) · 왕복 잠금 안내는 몇 번째 어떤 블록인지 말한다', () => {
    for (const name of ['trailingEmptyParagraph', 'emptyParagraphBetween', 'hardBreakAttrs', 'codeBlockEmpty', 'listItemEmptyPara', 'taskListEmptyItem', 'headingEmpty', 'quoteEmptyParagraph']) {
      const original = EDITABLE[name] ?? doc()
      expect(bodyUpdate({ current: original, next: adfView(original).markdown }), name).toEqual({ ok: true })
    }
    // 둘째 블록(문단)만 왕복에서 바뀐다(줄 끝 공백 둘 + 줄바꿈) — 안내에 자리·종류.
    const locked = doc(p(t('첫')), p(t('line one  '), { type: 'hardBreak' }, t('line two')))
    expect(adfView(locked).unsupported).toEqual(['#roundtrip:2:paragraph'])
    const saved = bodyUpdate({ current: locked, next: `${adfView(locked).markdown}\n\n덧붙임` })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.message).toContain('편집기 서식 — 2번째 블록 문단')
  })
})

describe('R1-G 고정 씨앗 왕복 퍼즈', () => {
  it('적대적 낱말 · 씨앗 605 · 2000 문서 — 조용한 변경 0(잠기지 않은 문서: 그대로/덧붙여 저장해도 원래 요소 같음 · md 고정점) · 이국 요소 든 문서는 전부 잠김', () => {
    const run = fuzzRun({ seed: 605, words: WORDS, rounds: 2000 })
    expect(run.silent.slice(0, 10)).toEqual([])
    expect(run.editable).toBeGreaterThan(500)
    expect(run.exoticLocked).toBeGreaterThan(0)
    process.stdout.write(`L605_FUZZ adversarial editable=${run.editable} locked=${run.locked} exoticLocked=${run.exoticLocked}\n`)
  })

  it('정규형 대 독립 투영(R2-B) · 씨앗 6052 · 1000 쌍 — 퍼즈 문서와 보이는 것 한 군데(마크 종류·href·글)를 바꾼 사본을 `sameAdf` 가 다르다고 본다(투영과 같은 답) · 그대로 사본은 같다', () => {
    const random = prng(6052)
    const disagree: string[] = []
    let perturbed = 0
    for (let round = 0; round < 1000; round += 1) {
      const { doc: original } = fuzzDoc({ random, words: WORDS })
      const copy: AdfDoc = JSON.parse(JSON.stringify(original))
      if (!sameAdf({ a: copy, b: original }) || !sameVisible({ a: copy.content, b: original.content })) disagree.push(`copy #${round}`)
      const texts: AdfNode[] = []
      const walk = (nodes: AdfNode[] | undefined): void => { for (const node of nodes ?? []) { if (node.type === 'text' && /\S/u.test(node.text ?? '')) texts.push(node); walk(node.content) } }
      walk(copy.content)
      const target = texts[Math.floor(random() * texts.length)]
      if (target === undefined) continue
      const marks = target.marks ?? []
      const roll = random()
      const linked = marks.find((mark) => mark.type === 'link')
      if (roll < 0.3 && linked !== undefined) target.marks = marks.map((mark) => (mark === linked ? link(`${String(linked.attrs?.href)}z`) : mark))
      else if (roll < 0.6) target.marks = marks.some((mark) => mark.type === 'strong') ? marks.filter((mark) => mark.type !== 'strong') : [...marks, { type: 'strong' }]
      else if (roll < 0.8) target.marks = marks.some((mark) => mark.type === 'em') ? marks.map((mark) => (mark.type === 'em' ? { type: 'strike' } : mark)) : [...marks, { type: 'em' }]
      else target.text = `${target.text ?? ''}q`
      perturbed += 1
      const visibleSame = sameVisible({ a: copy.content, b: original.content })
      if (visibleSame || sameAdf({ a: copy, b: original }) !== visibleSame) disagree.push(`perturbed #${round}: visible=${visibleSame}`)
    }
    expect(disagree.slice(0, 10)).toEqual([])
    expect(perturbed).toBeGreaterThan(900)
  })

  it('평범한 낱말 · 씨앗 6051 · 2000 문서 — 조용한 변경 0 · 이국 요소 없는 문서의 95% 이상이 편집 가능(잠금 남용 대조)', () => {
    const run = fuzzRun({ seed: 6051, words: PLAIN_WORDS, rounds: 2000 })
    expect(run.silent.slice(0, 10)).toEqual([])
    const plain = 2000 - run.exoticLocked
    expect(run.editable / plain).toBeGreaterThan(0.95)
    process.stdout.write(`L605_FUZZ plain editable=${run.editable} locked=${run.locked} exoticLocked=${run.exoticLocked}\n`)
  })
})

describe('R3-A ADF 스키마 오라클 — 나가는 ADF 가 문서 규칙 안', () => {
  it('오라클 자기시험 — 리뷰 r3 zz-a 의 위반 저장본(첫 자식이 목록인 항목 · 빈 인용)과 코드+굵게 · 빈 글 · 모르는 칸은 잡고, 규칙 안 문서는 통과', () => {
    const bad: AdfDoc[] = [
      doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('child'))] }] }] }] }),
      doc({ type: 'blockquote', content: [] }, p(t('뒤'))),
      doc(p(t('x', [{ type: 'code' }, { type: 'strong' }]))),
      doc(p(t(''))),
      doc({ type: 'bulletList', attrs: { localId: 'x' }, content: [{ type: 'listItem', content: [p(t('a'))] }] }),
      doc({ type: 'blockquote', content: [{ type: 'heading', attrs: { level: 1 }, content: [t('h')] }] }),
      doc({ type: 'codeBlock', content: [t('x', [{ type: 'strong' }])] }),
      doc({ type: 'taskList', attrs: { localId: 'l' }, content: [{ type: 'taskList', attrs: { localId: 'm' }, content: [{ type: 'taskItem', attrs: { localId: 'i', state: 'TODO' } }] }] }),
    ]
    for (const value of bad) expect(schemaProblems(value).length, JSON.stringify(value)).toBeGreaterThan(0)
    for (const [name, value] of Object.entries(EDITABLE)) if (name !== 'nullAttr') expect(schemaProblems(value), name).toEqual([])
  })

  it('R3-A 빈 모양 섞은 생성기 · 씨앗 305 · 5000 문서(리뷰 r3 zz-d 본뜸, 원문은 전부 스키마 안) — 잠기지 않은 문서를 고쳐 저장한 ADF 가 스키마 안 · 보이는 것 그대로 · 그대로 저장은 보내지 않음', () => {
    let state = 305
    const r = (): number => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296 }
    const pick = <T,>(list: readonly T[]): T => { const value = list[Math.floor(r() * list.length)]; if (value === undefined) throw new Error('빈 목록'); return value }
    const words = ['alpha', 'beta', 'gamma', 'one', 'x1']
    const text = (): AdfNode => {
      const marks: AdfMark[] | undefined = r() < 0.2 ? [{ type: pick(['strong', 'em', 'strike', 'code']) }] : r() < 0.1 ? [link(`https://e.x/${pick(words)}`)] : undefined
      return t(`${pick(words)}${r() < 0.3 ? ` ${pick(words)}` : ''}`, marks)
    }
    const inline = (): AdfNode[] => {
      if (r() < 0.12) return []
      const out: AdfNode[] = [text()]
      while (r() < 0.3) { if (r() < 0.2) out.push(r() < 0.5 ? { type: 'hardBreak' } : { type: 'hardBreak', attrs: { text: '\n' } }); out.push(text()) }
      return out
    }
    const para = (): AdfNode => (r() < 0.2 ? (r() < 0.5 ? { type: 'paragraph' } : { type: 'paragraph', content: [] }) : p(...inline()))
    const list = (depth: number): AdfNode => {
      const items = Array.from({ length: 1 + Math.floor(r() * 3) }, (): AdfNode => {
        const content: AdfNode[] = [para()]
        if (depth < 2 && r() < 0.35) content.push(list(depth + 1))
        if (r() < 0.1) content.push(para())
        return { type: 'listItem', content }
      })
      return r() < 0.5 ? { type: 'bulletList', content: items } : { type: 'orderedList', ...(r() < 0.3 ? { attrs: { order: 3 } } : {}), content: items }
    }
    const block = (): AdfNode => {
      const k = r()
      if (k < 0.35) return para()
      if (k < 0.5) return { type: 'heading', attrs: { level: 1 + Math.floor(r() * 3) }, ...(r() < 0.85 ? { content: inline() } : {}) }
      if (k < 0.72) return list(0)
      if (k < 0.82) return { type: 'blockquote', content: Array.from({ length: 1 + Math.floor(r() * 2) }, para) }
      if (k < 0.9) return { type: 'codeBlock', ...(r() < 0.5 ? { attrs: { language: 'ts' } } : {}), ...(r() < 0.8 ? { content: [t(`code ${pick(words)}`)] } : {}) }
      if (k < 0.95) return { type: 'rule' }
      return { type: 'taskList', attrs: { localId: 'l' }, content: [{ type: 'taskItem', attrs: { localId: 'i', state: pick(['TODO', 'DONE']) }, ...(r() < 0.8 ? { content: inline() } : {}) }] }
    }
    const bad: string[] = []
    let unlocked = 0
    for (let round = 0; round < 5000; round += 1) {
      const original = doc(...Array.from({ length: 1 + Math.floor(r() * 4) }, block))
      if (schemaProblems(original).length > 0) { bad.push(`generator #${round}: ${schemaProblems(original)[0]}`); continue }
      const view = adfView(original)
      if (view.unsupported.length > 0) continue
      unlocked += 1
      const same = bodyUpdate({ current: original, next: view.markdown })
      if (!same.ok || same.doc !== undefined) bad.push(`same-save-sent #${round}`)
      const edited = bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` })
      if (!edited.ok || edited.doc === undefined || edited.doc === null) { bad.push(`refused #${round}`); continue }
      const problems = schemaProblems(edited.doc)
      if (problems.length > 0) bad.push(`edit-schema #${round}: ${problems[0]} · ${view.markdown.slice(0, 60)}`)
      if (!sameVisible({ a: edited.doc.content.slice(0, -1), b: original.content })) bad.push(`visible #${round}`)
    }
    expect(bad.slice(0, 10)).toEqual([])
    expect(unlocked).toBeGreaterThan(4000)
    process.stdout.write(`L605_FUZZ empties unlocked=${unlocked}/5000\n`)
  })

  it('R3-A md 퍼즈 · 씨앗 6053 · 5000 글 — `markdownToAdf` 출력은 스키마 안이거나 `adfRuleProblem` 이 이유를 낸다(둘이 어긋나지 않음) · 본문 저장·코멘트 경로는 규칙 밖이면 거절', () => {
    const random = prng(6053)
    const pieces = ['- ', '  - ', '1. ', '   1. ', '> ', '>', '# ', '## ', '---', '```', '- [ ] ', '  - [x] ', '**', '*', '_', '~~', '`', '[a](https://e.x)', 'word', '한글', ' ', '\\', '|', '']
    const disagree: string[] = []
    let ruled = 0
    for (let round = 0; round < 5000; round += 1) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, () => Array.from({ length: 1 + Math.floor(random() * 4) }, () => pieces[Math.floor(random() * pieces.length)] ?? '').join(''))
      const md = lines.join('\n')
      const parsed = markdownToAdf(md)
      const problems = schemaProblems(parsed)
      const rule = adfRuleProblem(parsed)
      if (rule !== null) ruled += 1
      if (rule === null && problems.length > 0) disagree.push(`schema-miss #${round}: ${problems[0]} · ${JSON.stringify(md).slice(0, 80)}`)
      if (rule !== null && problems.length === 0) disagree.push(`rule-overreach #${round}: ${rule} · ${JSON.stringify(md).slice(0, 80)}`)
      const saved = bodyUpdate({ current: doc(p(t('원래'))), next: md })
      if (saved.ok && saved.doc !== undefined && saved.doc !== null && schemaProblems(saved.doc).length > 0) disagree.push(`saved-invalid #${round}`)
      if (!saved.ok && rule === null) disagree.push(`refused-without-rule #${round}: ${saved.message}`)
    }
    expect(disagree.slice(0, 10)).toEqual([])
    expect(ruled).toBeGreaterThan(0)
    process.stdout.write(`L605_FUZZ md ruled=${ruled}/5000\n`)
  })

  it('R3-A 규칙 밖 markdown(인용 안 제목·목록 항목 안 인용)은 보내지 않고 이유 · 굵게 안의 코드는 마크를 그대로 실어 규칙 그물이 거절(R4-A) · `>` 만 친 줄은 빈 문단 든 인용', () => {
    const quoted = bodyUpdate({ current: doc(p(t('원래'))), next: '> # 제목' })
    expect(quoted.ok).toBe(false)
    if (!quoted.ok) expect(quoted.message).toContain('인용 안에는 제목')
    const item = bodyUpdate({ current: doc(p(t('원래'))), next: '- a\n\n  > q' })
    expect(item.ok).toBe(false)
    if (!item.ok) expect(item.message).toContain('목록 항목 안에는 인용')
    expect(markdownToAdf('**a `b` c**').content[0]?.content?.find((node) => node.text === 'b')?.marks).toEqual([{ type: 'strong' }, { type: 'code' }])
    expect(markdownToAdf('>').content).toEqual([{ type: 'blockquote', content: [{ type: 'paragraph', content: [] }] }])
    expect(markdownToAdf('- \n  - x').content[0]?.content?.[0]?.content?.[0]).toEqual({ type: 'paragraph', content: [] })
  })

  it('R3-A 마지막 그물 — 받은 문서가 이미 규칙 밖(인용 안 제목)이면 고쳐 저장해도 규칙 밖이라 잠그고 이유(「Jira 문서 규칙」)를 미리 말한다', () => {
    const original = doc({ type: 'blockquote', content: [{ type: 'heading', attrs: { level: 2 }, content: [t('제목')] }] })
    expect(adfView(original).unsupported).toEqual(['#rules'])
    const saved = bodyUpdate({ current: original, next: `${adfView(original).markdown}\n\n덧붙임` })
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.message).toContain('Jira 문서 규칙')
  })

  it('R3-D 왕복 잠금 안내 번호는 md 에 보이는 블록 순서 — 빈 문단은 세지 않는다 · Z08·Z09 정규형 경계(마크 든 빈 문단·줄바꿈의 다른 text 값은 같지 않다)', () => {
    const locked = doc(p(t('A')), { type: 'paragraph' }, p(t('line one  '), { type: 'hardBreak' }, t('line two')))
    expect(adfView(locked).unsupported).toEqual(['#roundtrip:2:paragraph'])
    expect(sameAdf({ a: doc(p(t('a')), { type: 'paragraph', marks: [{ type: 'alignment', attrs: { align: 'center' } }] }), b: doc(p(t('a'))) })).toBe(false)
    expect(sameAdf({ a: doc(p(t('a'), { type: 'hardBreak', attrs: { text: 'x' } }, t('b'))), b: doc(p(t('a'), { type: 'hardBreak' }, t('b'))) })).toBe(false)
  })
})

describe('수정 4 — 리뷰 r4 (R4-A·R4-B·R4-G)', () => {
  it('R4-A 굵게·기울임·취소선 안의 코드는 조용히 서식을 잃지 않는다 — 둘러싼 마크 조합 전부(깊이 2)에서 보내지 않고 이유, 링크만 둘러싸면 마크 그대로 보낸다(조용한 변경 0)', () => {
    const wraps = [
      { mark: 'strong', open: '**', close: '**' },
      { mark: 'em', open: '*', close: '*' },
      { mark: 'em', open: '_', close: '_' },
      { mark: 'strike', open: '~~', close: '~~' },
      { mark: 'link', open: '[', close: '](https://e.x/a)' },
    ]
    const silent: string[] = []
    let refused = 0
    let sent = 0
    for (const outer of [null, ...wraps]) {
      for (const inner of [null, ...wraps]) {
        // `***` 처럼 같은 글자 표지가 붙으면 md 해석이 갈린다 — 조합에서 뺀다(같은 마크 겹침도).
        if (outer !== null && inner !== null && (outer.mark === inner.mark || outer.open[0] === inner.open[0])) continue
        for (const [before, after] of [['', ''], ['a ', ' b']]) {
          let md = `${before}\`c\`${after}`
          if (inner !== null) md = `${inner.open}${md}${inner.close}`
          if (outer !== null) md = `x ${outer.open}${md}${outer.close} y`
          const around = new Set([outer?.mark, inner?.mark].filter((mark): mark is string => mark !== undefined))
          const saved = bodyUpdate({ current: doc(p(t('원래'))), next: md })
          const code = markdownToAdf(md).content[0]?.content?.find((node) => node.text === 'c')
          const marks = new Set((code?.marks ?? []).map((mark) => mark.type))
          // 실은 마크 = 둘러싼 마크 + 코드(빼지 않는다).
          if ([...around].some((mark) => !marks.has(mark)) || !marks.has('code')) silent.push(`dropped ${JSON.stringify(md)} → ${[...marks].join(',')}`)
          const formatted = [...around].some((mark) => mark !== 'link')
          if (formatted) {
            refused += 1
            if (saved.ok) silent.push(`sent ${JSON.stringify(md)}`)
            else if (!saved.message.includes('굵게·기울임·취소선 안의 코드')) silent.push(`reason ${JSON.stringify(md)}: ${saved.message}`)
          } else {
            sent += 1
            if (!saved.ok || saved.doc === undefined || saved.doc === null) silent.push(`refused ${JSON.stringify(md)}`)
            else if (schemaProblems(saved.doc).length > 0) silent.push(`schema ${JSON.stringify(md)}`)
          }
        }
      }
    }
    expect(silent).toEqual([])
    expect(refused).toBeGreaterThan(30)
    expect(sent).toBe(6)
  })

  it('R4-B 고쳐 저장하면 빈 문단 간격이 빠지는 본문만 참 — 사이·끝 빈 문단은 참, 빈 문단 없는 본문·md 가 다시 만드는 빈 항목 머리 문단은 거짓', () => {
    const gaps = doc(p(t('a')), { type: 'paragraph' }, { type: 'paragraph', content: [] }, p(t('b')), { type: 'paragraph', attrs: { localId: 'z' } })
    expect(losesGaps(gaps)).toBe(true)
    const saved = bodyUpdate({ current: gaps, next: 'a\n\nb\n\nc' })
    if (!saved.ok || saved.doc === undefined || saved.doc === null) throw new Error('saved')
    expect(saved.doc.content.filter((node) => node.type === 'paragraph' && (node.content ?? []).length === 0)).toHaveLength(0)
    expect(losesGaps(doc(p(t('끝')), { type: 'paragraph' }))).toBe(true)
    expect(losesGaps(doc({ type: 'blockquote', content: [p(t('q')), { type: 'paragraph' }] }))).toBe(true)
    expect(losesGaps(doc(p(t('a')), p(t('b'))))).toBe(false)
    expect(losesGaps(doc())).toBe(false)
    const head = doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }, { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('x'))] }] }] }] })
    expect(adfToMarkdown(head).markdown).toBe('- \n  - x')
    expect(losesGaps(head)).toBe(false)
  })

  it('R4-G 규칙 그물을 받은 문서 모양으로 직접 — 빈 인용·빈 목록 셋·첫 자식이 목록·빈 항목·코드+굵게는 이유, 규칙 안 문서는 null · md 는 이 모양을 만들지 않는다(md 퍼즈가 스키마로 확인)', () => {
    const cases: [string, AdfDoc, string][] = [
      ['empty quote', doc({ type: 'blockquote', content: [] }), '빈 인용'],
      ['empty bullet', doc({ type: 'bulletList', content: [] }), '빈 목록'],
      ['empty ordered', doc({ type: 'orderedList', content: [] }), '빈 목록'],
      ['empty task', doc({ type: 'taskList', attrs: { localId: 'l' }, content: [] }), '빈 목록'],
      ['item first list', doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('x'))] }] }] }] }), '글로 시작'],
      ['empty item', doc({ type: 'orderedList', content: [{ type: 'listItem', content: [] }] }), '글로 시작'],
      ['code strong', doc(p(t('x', [{ type: 'strong' }, { type: 'code' }]))), '굵게·기울임·취소선 안의 코드'],
      ['code em in quote', doc({ type: 'blockquote', content: [p(t('x', [{ type: 'code' }, { type: 'em' }]))] }), '굵게·기울임·취소선 안의 코드'],
    ]
    for (const [name, value, reason] of cases) {
      expect(adfRuleProblem(value), name).toContain(reason)
      expect(schemaProblems(value).length, name).toBeGreaterThan(0)
    }
    expect(adfRuleProblem(doc(p(t('x', [link('https://e.x'), { type: 'code' }]))))).toBeNull()
    expect(adfRuleProblem(doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'codeBlock', content: [t('c')] }] }] }))).toBeNull()
    for (const [name, value] of Object.entries(EDITABLE)) expect(adfRuleProblem(value), name).toBeNull()
  })
})
