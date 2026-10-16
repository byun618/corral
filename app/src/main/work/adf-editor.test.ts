// LIFE-605 수정 1 R1-A·R1-G — Jira 편집기 모양 ADF 에서 출발하는 말뭉치 + 고정 씨앗 왕복 퍼즈.
// 지켜야 할 것: **조용한 변경 0** — 잠기지 않은 본문은 「보이는 md 를 그대로(또는 덧붙여) 저장해도 원래 요소가 같다」, 못 지키는 모양은 잠긴다.
// 말뭉치 = 리뷰 r1 재현(`raw/review/claude-r1-raw/scratch/zz-review-adf-real.test.ts` · E5) + Jira 편집기가 실제로 내는 노드 마크·링크 속성 모양.
import { describe, expect, it } from 'vitest'
import { adfView, canonicalAdf, markdownToAdf, sameAdf, type AdfDoc, type AdfMark, type AdfNode } from './adf.js'
import { bodyUpdate } from './jira-source.js'

const t = (text: string, marks?: AdfMark[]): AdfNode => (marks === undefined ? { type: 'text', text } : { type: 'text', text, marks })
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content })
const doc = (...content: AdfNode[]): AdfDoc => ({ type: 'doc', version: 1, content })
const link = (href: string, extra: Record<string, unknown> = {}): AdfMark => ({ type: 'link', attrs: { href, ...extra } })

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
      const view = adfView(original)
      expect(view.unsupported, name).toEqual([])
      expect(sameAdf({ a: markdownToAdf(view.markdown), b: original }), `${name}: ${view.markdown}`).toBe(true)
      expect(bodyUpdate({ current: original, next: view.markdown }), name).toEqual({ ok: true })
      const edited = bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` })
      if (!edited.ok || edited.doc === undefined || edited.doc === null) throw new Error(`${name}: 저장 안 됨`)
      expect(JSON.stringify(canonicalAdf(edited.doc.content.slice(0, -1))), name).toBe(JSON.stringify(canonicalAdf(original.content)))
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
      if (random() < 0.05) { node.marks = [{ type: 'alignment', attrs: { align: 'center' } }]; exotic = true }
      return node
    }
    if (roll < 0.55) return { type: 'heading', attrs: { level: 1 + Math.floor(random() * 6) }, content: words === PLAIN_WORDS ? inline().filter((node) => node.type !== 'hardBreak') : inline() }
    if (roll < 0.68 && depth < 2) return { type: 'bulletList', content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ type: 'listItem', content: [words === PLAIN_WORDS ? p(...inline()) : block(depth + 1)] })) }
    if (roll < 0.76 && depth < 2) return { type: 'orderedList', attrs: { order: 1 + Math.floor(random() * 3) }, content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({ type: 'listItem', content: [p(...inline())] })) }
    if (roll < 0.84) return { type: 'taskList', attrs: { localId: 'tl' }, content: [{ type: 'taskItem', attrs: { localId: 'ti', state: random() < 0.5 ? 'DONE' : 'TODO' }, content: inline().filter((node) => node.type !== 'hardBreak') }] }
    if (roll < 0.9) return { type: 'codeBlock', attrs: { language: pick(['ts', 'python', '']) }, content: [t(Array.from({ length: 2 }, () => pick(words)).join('\n'))] }
    if (roll < 0.95 && depth < 2) return { type: 'blockquote', content: [block(depth + 1)] }
    return { type: 'rule' }
  }
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
    if (adfView(markdownToAdf(view.markdown)).markdown !== view.markdown) silent.push(`not-fixed-point #${round}: ${view.markdown.slice(0, 80)}`)
    const edited = bodyUpdate({ current: original, next: `${view.markdown}\n\n덧붙임` })
    if (!edited.ok || edited.doc === undefined || edited.doc === null) silent.push(`edit-refused #${round}`)
    else if (JSON.stringify(canonicalAdf(edited.doc.content.slice(0, -1))) !== JSON.stringify(canonicalAdf(original.content))) silent.push(`edit-changed #${round}: ${view.markdown.slice(0, 80)}`)
  }
  return { editable, locked, exoticLocked, silent }
}

describe('R1-G 고정 씨앗 왕복 퍼즈', () => {
  it('적대적 낱말 · 씨앗 605 · 2000 문서 — 조용한 변경 0(잠기지 않은 문서: 그대로/덧붙여 저장해도 원래 요소 같음 · md 고정점) · 이국 요소 든 문서는 전부 잠김', () => {
    const run = fuzzRun({ seed: 605, words: WORDS, rounds: 2000 })
    expect(run.silent.slice(0, 10)).toEqual([])
    expect(run.editable).toBeGreaterThan(500)
    expect(run.exoticLocked).toBeGreaterThan(0)
    process.stdout.write(`L605_FUZZ adversarial editable=${run.editable} locked=${run.locked} exoticLocked=${run.exoticLocked}\n`)
  })

  it('평범한 낱말 · 씨앗 6051 · 2000 문서 — 조용한 변경 0 · 이국 요소 없는 문서의 95% 이상이 편집 가능(잠금 남용 대조)', () => {
    const run = fuzzRun({ seed: 6051, words: PLAIN_WORDS, rounds: 2000 })
    expect(run.silent.slice(0, 10)).toEqual([])
    const plain = 2000 - run.exoticLocked
    expect(run.editable / plain).toBeGreaterThan(0.95)
    process.stdout.write(`L605_FUZZ plain editable=${run.editable} locked=${run.locked} exoticLocked=${run.exoticLocked}\n`)
  })
})
