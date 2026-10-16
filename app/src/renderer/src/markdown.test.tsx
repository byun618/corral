// @vitest-environment happy-dom
// LIFE-602 C4·C5 — 본문 markdown: 체크 칸 한 줄 저장(바이트 diff) · 링크 규칙(양성 대조) · raw HTML 은 요소가 아님(양성 대조) · 키 자동 링크 · 편집기 도구·목록 이어 쓰기.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownView } from './components/MarkdownView.js'
import { applyEdit, applyTool, continueList, linkAction, toggleCheckLine } from './markdown.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

/** 두 글의 바이트가 다른 구간 — [처음 다른 위치, 원문 끝에서 같은 길이]. */
function diffBytes(a: string, b: string): { at: number; before: string; after: string } {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1
  let endA = left.length
  let endB = right.length
  while (endA > start && endB > start && left[endA - 1] === right[endB - 1]) { endA -= 1; endB -= 1 }
  return { at: start, before: left.subarray(start, endA).toString('utf8'), after: right.subarray(start, endB).toString('utf8') }
}

describe('체크 칸 한 줄 저장 (C4)', () => {
  const source = '# 일\r\n\r\n- [ ] 같은 글\n- [ ] 같은 글\r\n  1. [x] 번호 체크\n> - [ ] 인용 속\n\n```\n- [ ] 코드 속\n```\n끝'

  it('그 줄의 칸 글자 하나만 바뀐다 — 같은 글자의 줄이 여럿이어도 줄 번호로 고른다, 줄 끝 문자는 그대로', () => {
    const second = toggleCheckLine({ source, line: 4 })
    expect(second).not.toBeNull()
    const diff = diffBytes(source, second ?? '')
    expect(diff).toEqual({ at: Buffer.byteLength('# 일\r\n\r\n- [ ] 같은 글\n- [', 'utf8'), before: ' ', after: 'x' })
    expect(Buffer.byteLength(second ?? '')).toBe(Buffer.byteLength(source))
    const first = toggleCheckLine({ source, line: 3 })
    expect(diffBytes(source, first ?? '').at).toBe(Buffer.byteLength('# 일\r\n\r\n- [', 'utf8'))
    expect(diffBytes(source, toggleCheckLine({ source, line: 5 }) ?? '')).toMatchObject({ before: 'x', after: ' ' })
    expect(diffBytes(source, toggleCheckLine({ source, line: 6 }) ?? '')).toMatchObject({ before: ' ', after: 'x' })
  })

  it('체크 칸이 없는 줄 · 없는 줄 · 이미 그 값이면 null(보내지 않는다)', () => {
    expect(toggleCheckLine({ source, line: 1 })).toBeNull()
    expect(toggleCheckLine({ source, line: 99 })).toBeNull()
    expect(toggleCheckLine({ source, line: 3, checked: false })).toBeNull()
    expect(toggleCheckLine({ source, line: 3, checked: true })).not.toBeNull()
  })
})

describe('링크 규칙 (C4 · G13)', () => {
  it('절대 http·https 만 밖으로 — 그 밖 scheme·상대·프로토콜 상대는 열지 않는다', () => {
    expect(linkAction('https://example.com/a?b=1')).toEqual({ kind: 'external', url: 'https://example.com/a?b=1' })
    expect(linkAction('HTTP://example.com')).toMatchObject({ kind: 'external' })
    for (const href of ['javascript:alert(1)', 'file:///etc/hosts', 'corral://x', '/x', '//host/x', 'data:text/html,1', '', undefined, 'https//no']) {
      expect(linkAction(href).kind, String(href)).toBe('blocked')
    }
  })
})

describe('편집기 도구·목록 이어 쓰기 (C5)', () => {
  it('도구 10 — 감싸기·줄 앞 표지', () => {
    const value = 'ab\ncd'
    expect(applyEdit({ value, edit: applyTool({ value, start: 0, end: 2, tool: 'bold' }) })).toBe('**ab**\ncd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 0, end: 2, tool: 'italic' }) })).toBe('_ab_\ncd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 0, end: 2, tool: 'code' }) })).toBe('`ab`\ncd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 0, end: 2, tool: 'link' }) })).toBe('[ab](https://)\ncd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 1, end: 4, tool: 'bullet' }) })).toBe('- ab\n- cd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 1, end: 4, tool: 'number' }) })).toBe('1. ab\n2. cd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 4, end: 4, tool: 'check' }) })).toBe('ab\n- [ ] cd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 0, end: 0, tool: 'quote' }) })).toBe('> ab\ncd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 0, end: 0, tool: 'heading' }) })).toBe('## ab\ncd')
    expect(applyEdit({ value, edit: applyTool({ value, start: 3, end: 5, tool: 'codeblock' }) })).toBe('ab\n```\ncd\n```')
    const empty = applyTool({ value: '', start: 0, end: 0, tool: 'bold' })
    expect(empty).toMatchObject({ text: '**굵게**', selectFrom: 2, selectTo: 4 })
  })

  it('목록 줄 Enter = 다음 항목(번호는 +1, 체크는 빈 칸) · 빈 항목 Enter = 목록 끝 · 목록 밖은 null', () => {
    const run = (value: string): string | null => {
      const edit = continueList({ value, start: value.length, end: value.length })
      return edit === null ? null : applyEdit({ value, edit })
    }
    expect(run('- 하나')).toBe('- 하나\n- ')
    expect(run('3. 셋')).toBe('3. 셋\n4. ')
    expect(run('  - [x] 끝')).toBe('  - [x] 끝\n  - [ ] ')
    expect(run('> * 인용')).toBe('> * 인용\n> * ')
    expect(run('a\n- ')).toBe('a\n')
    expect(run('그냥 글')).toBeNull()
    expect(continueList({ value: '- ab', start: 2, end: 4 })).toBeNull()
  })
})

describe('MarkdownView (C4)', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })
  const render = (source: string, extra: Partial<Parameters<typeof MarkdownView>[0]> = {}): void => {
    act(() => root.render(createElement(MarkdownView, { source, keyPattern: 'K-\\d+', onOpenKey: () => {}, ...extra })))
  }

  it('요소 — 제목·문단·목록·번호·체크·인용·코드 블록·구분선·굵게·기울임·인라인 코드·링크', () => {
    render('# h1\n## h2\n### h3\n\n문단 **굵게** _기울임_ `코드` [l](https://e.com)\n\n- a\n\n1. b\n\n- [ ] c\n\n> q\n\n```\nx\n```\n\n---')
    for (const selector of ['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'input[type=checkbox]', 'blockquote', 'pre code', 'hr', 'strong', 'em', 'p > code', 'a.md-link']) {
      expect(host.querySelector(selector), selector).not.toBeNull()
    }
    expect(host.querySelector('[data-md-rendered]')).not.toBeNull()
  })

  it('raw HTML 은 요소가 되지 않는다 — img·script·iframe 0, 글자로 보인다 (양성 대조: 같은 DOM 검사가 진짜 요소는 잡는다)', () => {
    const hostile = '<img src=x onerror="window.__l602=1"> <script>window.__l602=2</script>\n\n<iframe src="https://e.com"></iframe>\n\n<a href="javascript:alert(1)">x</a>'
    render(hostile)
    const rendered = host.querySelector('[data-md-rendered]')
    expect(rendered?.querySelectorAll('img, script, iframe').length).toBe(0)
    expect(rendered?.querySelector('a[href^="javascript"]')).toBeNull()
    expect(rendered?.textContent).toContain('<img src=x onerror=')
    expect(Reflect.get(window, '__l602')).toBeUndefined()
    // 양성 대조 — 검사 자체가 요소를 볼 수 있다.
    const control = document.createElement('div')
    control.innerHTML = '<img src="x"><iframe></iframe>'
    expect(control.querySelectorAll('img, script, iframe').length).toBe(2)
  })

  it('링크 클릭은 창을 옮기지 않는다 — http(s) 는 window.open, 그 밖은 막힘 (양성 대조: 가드 없는 <a> 는 기본 동작이 산다)', () => {
    const opened: string[] = []
    const blocked: string[] = []
    const original = window.open
    window.open = (url?: string | URL) => { opened.push(String(url)); return null }
    try {
      render('[a](https://e.com/x) [b](file:///etc/hosts) [c](/relative) [d](//host/x) [e](javascript:alert(1))', { onBlockedLink: (reason) => blocked.push(reason) })
      const links = [...host.querySelectorAll('a.md-link')]
      expect(links).toHaveLength(5)
      const prevented = links.map((link) => {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true })
        act(() => { link.dispatchEvent(event) })
        return event.defaultPrevented
      })
      expect(prevented).toEqual([true, true, true, true, true])
      expect(opened).toEqual(['https://e.com/x'])
      expect(blocked).toHaveLength(4)
      // 양성 대조 — 같은 시험을 가드 없는 링크에 돌리면 기본 동작(이동)이 막히지 않는다.
      const bare = document.createElement('a')
      bare.href = 'file:///etc/hosts'
      host.append(bare)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      bare.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      window.open = original
    }
  })

  it('외부 이미지는 불러오지 않는다 — 대체 글자', () => {
    render('![그림](https://e.com/a.png)')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('.md-img')?.textContent).toBe('[이미지: 그림]')
  })

  it('작업 키 자동 링크 — keyPattern 으로만, 링크·코드 안은 그대로, 누르면 그 키', () => {
    const keys: string[] = []
    render('K-1 과 k-22 · `K-3` · [K-4](https://e.com) · AK-5', { onOpenKey: (key) => keys.push(key) })
    const found = [...host.querySelectorAll('[data-issue-key]')].map((node) => node.getAttribute('data-issue-key'))
    // 대소문자 그대로(R1-R) — 브랜치 자동 연결(`work-link.ts`)과 같은 규칙. 소문자 `k-22` 는 키가 아니다.
    expect(found).toEqual(['K-1'])
    const first = host.querySelector('[data-issue-key="K-1"]')
    if (first !== null) act(() => { first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(keys).toEqual(['K-1'])
    render('K-1', { keyPattern: null })
    expect(host.querySelector('[data-issue-key]')).toBeNull()
  })

  it('R1-R Jira 키 모양 — utf-8·sha-256·iso-8601 같은 소문자 낱말은 링크가 아니다 · CORE-12 는 링크(양성 대조)', () => {
    render('utf-8 · sha-256 · iso-8601 · Utf-8 · CORE-12', { keyPattern: '[A-Z][A-Z0-9_]+-\\d+' })
    expect([...host.querySelectorAll('[data-issue-key]')].map((node) => node.getAttribute('data-issue-key'))).toEqual(['CORE-12'])
  })

  it('체크 칸 — 누르면 그 항목의 소스 줄 번호와 바꿀 값', () => {
    const toggles: { line: number; checked: boolean }[] = []
    render('글\n\n- [ ] 같은\n- [x] 같은\n- [ ] 같은', { onToggleCheck: (input) => toggles.push(input) })
    const boxes = [...host.querySelectorAll('[data-md-check]')]
    expect(boxes.map((box) => box.getAttribute('data-md-check'))).toEqual(['3', '4', '5'])
    const third = boxes[2]
    if (third !== undefined) act(() => { third.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(toggles).toEqual([{ line: 5, checked: true }])
    render('- [ ] 읽기 전용')
    expect(host.querySelector('[data-md-check]')?.hasAttribute('disabled')).toBe(true)
  })
})

// LIFE-602 수정 6 (R6-C) — GFM 이 체크리스트로 그리는 모든 칸은, 누르면 그 칸의 글자 하나만 바뀐 본문이거나(매핑) 처음부터 비활성이다(활성인데 아무 일 없는 칸 금지).
// 리뷰 r6 재현(`codex-r6-raw/markdown-extra.test.tsx` V21: nested·quoted·continuation·duplicates)에 같은 모양(표지 둘 · 번호 · 인용 안 다음 줄 · 탭 · 끝 공백)을 더했다.
describe('R6-C 그려진 체크 칸 = 그 칸의 소스 위치', () => {
  const clickAll = (source: string): { enabled: number; disabled: number; results: (string | null)[] } => {
    const results: (string | null)[] = []
    const local = document.createElement('div')
    document.body.append(local)
    const view = createRoot(local)
    act(() => view.render(createElement(MarkdownView, { source, keyPattern: null, onOpenKey: () => {}, onToggleCheck: ({ line, checked }) => { results.push(toggleCheckLine({ source, line, checked })) } })))
    try {
      const boxes = [...local.querySelectorAll('[data-md-check]')]
      const enabled = boxes.filter((box) => !box.hasAttribute('disabled'))
      for (const box of enabled) act(() => { box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
      return { enabled: enabled.length, disabled: boxes.length - enabled.length, results }
    } finally {
      act(() => view.unmount())
      local.remove()
    }
  }
  it.each([
    ['nested', '- parent\r\n  - [ ] nested\r\n\t- [ ] child\r\n', 2],
    ['quoted', '> - [ ] quote\r\n>   - [x] nested quote\r\n', 2],
    ['continuation', '-\n  [ ] next-line task\n', 1],
    ['duplicates', '- [ ] same\n- [ ] same\n\n```\n- [ ] code\n```\n', 2],
    ['two markers', '- - [ ] double\n', 1],
    ['numbered next line', '1.\n   [x] numbered next\n', 1],
    ['quoted next line', '> -\n>   [ ] quoted next\n', 1],
    ['markers', '* [ ] star\n+ [X] plus\n3) [ ] paren\n', 3],
    ['tab', '-\t[ ] tab\n', 1],
    ['crlf next line', '-\r\n  [x] crlf next\r\n', 1],
  ])('%s — 칸마다 그 칸 글자 하나만 바뀐다', (_, source, count) => {
    const { enabled, disabled, results } = clickAll(source)
    expect({ enabled, disabled }).toEqual({ enabled: count, disabled: 0 })
    for (const next of results) {
      expect(next).not.toBeNull()
      const diff = diffBytes(source, next ?? '')
      expect(Buffer.byteLength(next ?? '')).toBe(Buffer.byteLength(source))
      expect(diff.before).toMatch(/^[ xX]$/)
      expect(diff.after).toMatch(/^[ x]$/)
      expect(source.slice(diff.at - 1, diff.at + 2)).toMatch(/^\[[ xX]\]$/)
    }
  })
})
