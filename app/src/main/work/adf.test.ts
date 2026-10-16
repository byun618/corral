// LIFE-605 C6 — ADF ↔ markdown 말뭉치(지원 표 안): md → ADF → md 가 바이트로 같고, ADF → md → ADF 가 의미상 같다(localId 무시).
// 바꿀 수 없는 요소는 이름이 나오고(편집 잠금 근거), 체크 칸 상태만 바꾸기는 다른 노드를 건드리지 않는다.
import { describe, expect, it } from 'vitest'
import { adfToMarkdown, markdownToAdf, taskStates, withTaskStates, type AdfDoc, type AdfNode } from './adf.js'

export const ADF_CORPUS: string[] = [
  '한 줄 문단',
  '첫 문단\n\n둘째 문단',
  '줄바꿈이\n있는 문단',
  '# 제목 하나',
  '## 제목 둘\n\n### 제목 셋\n\n###### 제목 여섯',
  '**굵게** 와 _기울임_ 과 `코드` 와 ~~취소선~~',
  '**굵고 _기울어진_ 글**',
  '[링크 글](https://example.com/a?b=1)',
  '[**굵은 링크**](https://example.com)',
  '- 하나\n- 둘\n- 셋',
  '1. 첫째\n2. 둘째\n3. 셋째',
  '3. 셋부터\n4. 넷',
  '- 바깥\n  - 안쪽\n    - 더 안쪽\n- 다시 바깥',
  '1. 번호\n   - 섞인 하위\n2. 번호 둘',
  '- [ ] 할 일\n- [x] 끝난 일',
  '- [ ] 부모 할 일\n  - [x] 자식 할 일\n- [ ] 다음',
  '```ts\nconst a = 1\nconsole.log(a)\n```',
  '```\n<b>raw</b>\n```',
  '> 인용 문단\n>\n> 둘째 인용',
  '앞\n\n---\n\n뒤',
  'snake_case_name 과 2*3 은 글',
  '별표 \\* 와 역슬래시 \\\\ 와 대괄호 \\[x\\] 와 \\*굵게 아님\\*',
  '``백틱`안`` 코드 와 `` `앞 ``',
  '# 제목\n\n- [ ] 한글 체크\n- [x] 끝\n\n```\n<b>raw</b>\n```\n\n끝',
  '## 본문\n\n- [ ] 하나',
  '- 항목 첫 줄\n  이어지는 줄',
]

/** 의미 비교용 — localId 를 지우고 빈 attrs 를 뺀다. */
function normalize(nodes: AdfNode[]): unknown[] {
  return nodes.map((node) => {
    const attrs = Object.fromEntries(Object.entries(node.attrs ?? {}).filter(([key]) => key !== 'localId'))
    return { type: node.type, ...(Object.keys(attrs).length === 0 ? {} : { attrs }), ...(node.text === undefined ? {} : { text: node.text }), ...(node.marks === undefined ? {} : { marks: node.marks }), ...(node.content === undefined ? {} : { content: normalize(node.content) }) }
  })
}

describe('ADF ↔ markdown (C6①)', () => {
  it(`말뭉치 ${ADF_CORPUS.length}개 — md → ADF → md 바이트 같음`, () => {
    expect(ADF_CORPUS.length).toBeGreaterThanOrEqual(20)
    for (const md of ADF_CORPUS) {
      const back = adfToMarkdown(markdownToAdf(md))
      expect(back.unsupported, md).toEqual([])
      expect(back.markdown, md).toBe(md)
    }
  })

  it('말뭉치 — ADF → md → ADF 의미상 같음', () => {
    for (const md of ADF_CORPUS) {
      const adf = markdownToAdf(md)
      expect(normalize(markdownToAdf(adfToMarkdown(adf).markdown).content), md).toEqual(normalize(adf.content))
    }
  })

  it('모양 — 제목·목록·할 일·코드 언어·마크가 ADF 노드로', () => {
    const doc = markdownToAdf('## 제목\n\n- [x] 끝\n\n```ts\nx\n```\n\n**a** [b](https://e.x)')
    expect(normalize(doc.content)).toEqual([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '제목' }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [{ type: 'text', text: '끝' }] }] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'a', marks: [{ type: 'strong' }] }, { type: 'text', text: ' ' }, { type: 'text', text: 'b', marks: [{ type: 'link', attrs: { href: 'https://e.x' } }] }] },
    ])
  })

  it('CRLF·줄 끝 공백 강제 줄바꿈은 줄바꿈 하나로 정규화된다(지원 표 밖 모양 — 의미 유지)', () => {
    expect(adfToMarkdown(markdownToAdf('a  \r\nb\r\n')).markdown).toBe('a\nb')
  })
})

const LOCKED: AdfDoc = {
  type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [{ type: 'text', text: '담당 ' }, { type: 'mention', attrs: { id: 'acc-1', text: '@Kim' } }, { type: 'text', text: ' 확인', marks: [{ type: 'underline' }] }] },
    { type: 'panel', attrs: { panelType: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '패널 안 글' }] }] },
    { type: 'taskList', attrs: { localId: 'tl-1' }, content: [{ type: 'taskItem', attrs: { localId: 'ti-1', state: 'TODO' }, content: [{ type: 'text', text: '하나' }] }, { type: 'taskItem', attrs: { localId: 'ti-2', state: 'DONE' }, content: [{ type: 'text', text: '둘' }] }] },
    { type: 'table', content: [] },
  ],
}

describe('바꿀 수 없는 요소 (C6②)', () => {
  it('멘션·패널·표·밑줄 — 이름이 나오고 보기용 자리글로 그린다(안의 글은 보인다)', () => {
    const out = adfToMarkdown(LOCKED)
    expect(out.unsupported.sort()).toEqual(['mention', 'panel', 'table', 'underline'])
    expect(out.markdown).toContain('@Kim')
    expect(out.markdown).toContain('[패널] 패널 안 글')
    expect(out.markdown).toContain('[표]')
  })

  it('모르는 노드도 바꿀 수 없는 요소다(조용히 글로 읽지 않는다)', () => {
    expect(adfToMarkdown({ type: 'doc', version: 1, content: [{ type: 'futureNode', content: [] }] }).unsupported).toEqual(['futureNode'])
  })
})

describe('체크 칸 상태만 (C6③)', () => {
  it('taskItem.state 만 바뀌고 다른 노드·속성(멘션·패널·localId)은 그대로', () => {
    expect(taskStates(LOCKED)).toEqual([false, true])
    const next = withTaskStates({ doc: LOCKED, states: [true, true] })
    expect(next).not.toBeNull()
    if (next === null) return
    expect(taskStates(next)).toEqual([true, true])
    const strip = (doc: AdfDoc) => JSON.stringify(doc).replaceAll('"state":"DONE"', 'S').replaceAll('"state":"TODO"', 'S')
    expect(strip(next)).toBe(strip(LOCKED))
    expect(JSON.stringify(next)).toContain('"localId":"ti-1"')
    expect(withTaskStates({ doc: LOCKED, states: [true] })).toBeNull()
  })
})
