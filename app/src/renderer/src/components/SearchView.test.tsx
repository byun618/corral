// @vitest-environment happy-dom
// LIFE-803 C4 — 검색 보기: 입력칸 + 토글 3개(aria-pressed), 파일별 묶음(이름·디렉터리·일치 수, 접기), 일치 줄 행(줄 번호·미리보기·강조), 요약·잘림 안내,
// 빈 질의·결과 없음·오류·검색 중 상태, Enter 즉시·IME 조합 중 Enter 무시, ⌘⇧F 포커스 토큰(전체 선택), 행 클릭 → 열기(줄·열).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewSegments, searchNotice, searchSummary, SearchView, type SearchOpenInput } from './SearchView.js'
import { SearchSession } from '../content-search-session.js'
import type { ContentSearchResult } from '../../../shared/content-search.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let requests: { query: string; resolve: (result: ContentSearchResult) => void }[] = []
let opened: SearchOpenInput[] = []
const session = (): SearchSession =>
  new SearchSession({
    request: (input) => {
      let resolve: (result: ContentSearchResult) => void = () => undefined
      const result = new Promise<ContentSearchResult>((done) => {
        resolve = done
      })
      requests.push({ query: input.query, resolve })
      return { result, cancel: () => undefined }
    },
    setTimer: () => null,
    clearTimer: () => undefined,
  })
const RESULT: ContentSearchResult = {
  ok: true,
  root: '/w',
  files: [
    {
      rel: 'very/long/directory/name/that/keeps/going/and/going/file-with-a-long-name.ts',
      lines: [
        { line: 12345, column: 10, preview: '    hello 한글 Foo foo', ranges: [{ start: 13, end: 16 }, { start: 17, end: 20 }], matches: 2, matchesExact: true, clippedStart: false, clippedEnd: false },
        { line: 20, column: 1, preview: 'foo', ranges: [{ start: 0, end: 3 }], matches: 1, matchesExact: true, clippedStart: false, clippedEnd: false },
      ],
    },
    { rel: 'b.txt', lines: [{ line: 1, column: 1, preview: 'foo', ranges: [], matches: 1, matchesExact: true, clippedStart: false, clippedEnd: false }] },
  ],
  lineCount: 3,
  matchCount: 4,
  matchCountExact: true,
  truncated: true,
  ms: 3,
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const q = (selector: string): HTMLElement | null => host.querySelector<HTMLElement>(selector)
const all = (selector: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(selector)]

function Harness({ value, token }: { value: SearchSession; token: number }): React.JSX.Element {
  return <SearchView api={{ session: value, state: value.state }} title="wt" focusToken={token} onOpen={(input) => opened.push(input)} />
}
let current: SearchSession
const render = (token = 0): void => act(() => root.render(<Harness value={current} token={token} />))
const type = (text: string): void => {
  const input = q('[data-search-input]')
  if (!(input instanceof HTMLInputElement)) throw new Error('input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  render()
}
const key = (init: KeyboardEventInit): void => {
  act(() => void q('[data-search-input]')?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
  render()
}

beforeEach(() => {
  requests = []
  opened = []
  current = session()
  current.setRoot('/w')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('입력·토글 (C4ⓐⓓⓕ)', () => {
  it('입력칸 + 토글 3개(aria-pressed), 토글을 누르면 눌림', () => {
    render()
    expect(q('[data-search-input]')).not.toBeNull()
    expect(all('[data-search-toggle]').map((button) => [button.dataset.searchToggle, button.getAttribute('aria-pressed')])).toEqual([
      ['caseSensitive', 'false'],
      ['wholeWord', 'false'],
      ['regex', 'false'],
    ])
    act(() => q('[data-search-toggle="regex"]')?.click())
    render()
    expect(q('[data-search-toggle="regex"]')?.getAttribute('aria-pressed')).toBe('true')
  })
  it('빈 질의 — 결과 0·요청 0, Enter 해도 요청 0', () => {
    render()
    key({ key: 'Enter' })
    expect(requests).toHaveLength(0)
    expect(q('[data-search-results]')?.children.length ?? 0).toBe(0)
  })
  it('Enter 는 바로 찾고, IME 조합 중 Enter 는 찾지 않는다', () => {
    render()
    type('한')
    key({ key: 'Enter', isComposing: true })
    key({ key: 'Enter', keyCode: 229 })
    expect(requests).toHaveLength(0)
    key({ key: 'Enter' })
    expect(requests.map((request) => request.query)).toEqual(['한'])
  })
  it('⌘⇧F 포커스 토큰 — 입력칸에 포커스·기존 글 전체 선택', () => {
    current.setQuery('foo')
    render(0)
    render(1)
    const input = q('[data-search-input]')
    expect(document.activeElement).toBe(input)
    expect(input instanceof HTMLInputElement && [input.selectionStart, input.selectionEnd]).toEqual([0, 3])
  })
})

describe('결과 (C4ⓑⓒⓗ·C3)', () => {
  const ready = async (): Promise<void> => {
    render()
    type('foo')
    key({ key: 'Enter' })
    await act(async () => {
      requests[0]?.resolve(RESULT)
      await pause(0)
    })
    render()
  }
  it('파일별 묶음 — 머리(이름·디렉터리·일치 수)와 줄 행(줄 번호·미리보기), 요약·잘림 안내', async () => {
    await ready()
    expect(all('[data-search-file]').map((file) => file.dataset.searchFile)).toEqual(['very/long/directory/name/that/keeps/going/and/going/file-with-a-long-name.ts', 'b.txt'])
    const head = q('[data-search-file] .search-file-head')
    expect(head?.querySelector('.search-file-name')?.textContent).toBe('file-with-a-long-name.ts')
    expect(head?.querySelector('.search-file-dir')?.textContent).toBe('very/long/directory/name/that/keeps/going/and/going')
    expect(head?.querySelector('[data-search-file-count]')?.textContent).toBe('3')
    expect(all('[data-search-line-no]').map((cell) => cell.textContent)).toEqual(['12345', '20', '1'])
    expect(q('[data-search-summary]')?.textContent).toContain('2개 파일에서 4개 결과')
    expect(q('[data-search-truncated]')).not.toBeNull()
  })
  it('꼬리(일치 수·줄 번호)는 줄지 않는 칸 — 말줄임은 이름·디렉터리·미리보기 칸만(learnings ui)', async () => {
    await ready()
    const count = q('[data-search-file-count]')
    const lineNo = q('[data-search-line-no]')
    // 꼬리는 말줄임 칸(.search-file-label · .search-line-text) 밖의 형제다.
    expect(count?.parentElement?.classList.contains('search-file-head')).toBe(true)
    expect(lineNo?.parentElement?.classList.contains('search-line')).toBe(true)
    expect(count?.closest('.search-file-label')).toBeNull()
    expect(lineNo?.closest('.search-line-text')).toBeNull()
  })
  it('강조 — 범위마다 mark, 앞 공백은 걷는다', async () => {
    await ready()
    const first = q('[data-search-line] .search-line-text')
    expect([...(first?.querySelectorAll('mark') ?? [])].map((mark) => mark.textContent)).toEqual(['Foo', 'foo'])
    expect(first?.textContent).toBe('hello 한글 Foo foo')
    // 범위를 모르는 줄은 강조하지 않는다
    expect(q('[data-search-file="b.txt"] mark')).toBeNull()
  })
  it('묶음 접기/펴기', async () => {
    await ready()
    act(() => q('[data-search-file="b.txt"] .search-file-head')?.click())
    render()
    expect(all('[data-search-file="b.txt"] [data-search-line]')).toHaveLength(0)
    expect(q('[data-search-file="b.txt"] .search-file-head')?.getAttribute('aria-expanded')).toBe('false')
  })
  it('행 클릭 → 그 줄:첫 일치 열로 열기(한 번 = 미리보기, 두 번 = 고정)', async () => {
    await ready()
    const row = q('[data-search-line]')
    act(() => row?.click())
    act(() => void row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(opened).toEqual([
      { rel: 'very/long/directory/name/that/keeps/going/and/going/file-with-a-long-name.ts', line: 12345, column: 10, preview: true },
      { rel: 'very/long/directory/name/that/keeps/going/and/going/file-with-a-long-name.ts', line: 12345, column: 10, preview: false },
    ])
  })
})

describe('상태 글 (C4ⓔ)', () => {
  it('worktree 없음·검색 중·결과 없음·오류 — 각각 다른 글', () => {
    const base = { root: '/w', query: 'foo', files: [], error: null }
    expect(searchNotice({ ...base, root: null, status: 'idle' })).toBe('열린 worktree 가 없습니다.')
    expect(searchNotice({ ...base, status: 'searching' })).toBe('검색 중…')
    expect(searchNotice({ ...base, status: 'done' })).toBe('결과가 없습니다.')
    expect(searchNotice({ ...base, status: 'error', error: "fatal: -e option, 'fo(': missing closing parenthesis" })).toBe("검색할 수 없습니다 — fatal: -e option, 'fo(': missing closing parenthesis")
    expect(searchNotice({ ...base, query: '', status: 'idle' })).toBeNull()
    expect(searchSummary({ files: [], matchCount: 0, matchCountExact: true })).toBeNull()
  })
  it('오류가 화면에 보인다', async () => {
    render()
    type('fo(')
    key({ key: 'Enter' })
    await act(async () => {
      requests[0]?.resolve({ ok: false, code: 'git_failed', error: 'missing closing parenthesis' })
      await pause(0)
    })
    render()
    expect(q('[data-search-empty="error"]')?.textContent).toContain('missing closing parenthesis')
  })
})

describe('r1 R1-10 — 진행 표시·뒤 잘림·부분 일치 수', () => {
  it('뒤가 잘린 줄은 … 로 끝난다', () => {
    expect(previewSegments({ preview: 'abc', ranges: [{ start: 0, end: 1 }], clippedStart: false, clippedEnd: true }).at(-1)).toEqual({ text: '…', hit: false })
  })
  it('일치 수가 부분값이면 요약은 「이상」, 파일 머리는 「+」', async () => {
    expect(searchSummary({ files: RESULT.ok ? RESULT.files : [], matchCount: 4, matchCountExact: false })).toBe('2개 파일에서 4개 이상 결과')
    render()
    type('foo')
    key({ key: 'Enter' })
    await act(async () => {
      requests[0]?.resolve({ ...RESULT, matchCountExact: false, files: [{ rel: 'c.txt', lines: [{ line: 1, column: 1, preview: 'foo', ranges: [], matches: 1, matchesExact: false, clippedStart: false, clippedEnd: false }] }] })
      await pause(0)
    })
    render()
    expect(q('[data-search-file-count]')?.textContent).toBe('1+')
    expect(q('[data-search-summary]')?.textContent).toContain('1개 파일에서 4개 이상 결과')
  })
  it('검색 중이면 이전 결과가 있어도 진행 표시', async () => {
    render()
    type('foo')
    key({ key: 'Enter' })
    expect(q('[data-search-progress]')).not.toBeNull()
    await act(async () => {
      requests[0]?.resolve(RESULT)
      await pause(0)
    })
    render()
    expect(q('[data-search-progress]')).toBeNull()
    key({ key: 'Enter' })
    expect(all('[data-search-file]')).toHaveLength(2)
    expect(q('[data-search-progress]')).not.toBeNull()
  })
})

describe('previewSegments (C3ⓕ)', () => {
  it('앞이 잘린 줄은 … 로 시작, 범위는 미리보기 기준', () => {
    expect(previewSegments({ preview: 'xxneedleyy', ranges: [{ start: 2, end: 8 }], clippedStart: true, clippedEnd: false })).toEqual([
      { text: '…', hit: false },
      { text: 'xx', hit: false },
      { text: 'needle', hit: true },
      { text: 'yy', hit: false },
    ])
  })
  it('겹치는 범위는 한 번만', () => {
    expect(previewSegments({ preview: 'abcdef', ranges: [{ start: 0, end: 3 }, { start: 2, end: 4 }], clippedStart: false, clippedEnd: false })).toEqual([
      { text: 'abc', hit: true },
      { text: 'd', hit: true },
      { text: 'ef', hit: false },
    ])
  })
})
