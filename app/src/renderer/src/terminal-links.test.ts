// @vitest-environment happy-dom
// LIFE-565 — 평문 URL 감지(C1ⓓ)·줄 넘김 결합(C4ⓐⓑ)·⌘ 한정 활성화(C3ⓐ)·스킴 무필터(C3ⓒ).
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findLinksOnRow, openTerminalLink, registerTerminalLinks, terminalLinkHandler, trimUrlTail, type LinkCell, type ReadRow } from './terminal-links.js'

/** 문자열 행들을 cols 폭의 칸 격자로 — 짧은 행은 빈 칸('')으로 채운다. ASCII 전용. */
function grid(input: { cols: number; rows: string[] }): ReadRow {
  const cells: LinkCell[][] = input.rows.map((row) => {
    const line: LinkCell[] = [...row].map((chars) => ({ chars, width: 1 }))
    while (line.length < input.cols) line.push({ chars: '', width: 1 })
    return line
  })
  return (y) => cells[y]
}

const texts = (input: { readRow: ReadRow; y: number }): string[] => findLinksOnRow(input).map((link) => link.text)

describe('trimUrlTail — 끝 구두점 (C1ⓓ)', () => {
  it.each([
    ['https://x.y/a).', 'https://x.y/a'],
    ['https://x.y/a.', 'https://x.y/a'],
    ['https://x.y/a,', 'https://x.y/a'],
    ['https://x.y/a?', 'https://x.y/a'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)).', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['https://x.y/[a]]', 'https://x.y/[a]'],
    ['https://x.y/?q=1', 'https://x.y/?q=1'],
    // R1-05 — 마크다운 굵게의 닫는 `**` 는 뗀다. `_` 는 경로 끝에 합법이라 남긴다(RESULT fix r1).
    ['https://x.y/a**', 'https://x.y/a'],
    ['https://x.y/a**.', 'https://x.y/a'],
    ['https://x.y/a_', 'https://x.y/a_'],
  ])('%s → %s', (raw, expected) => {
    expect(trimUrlTail(raw)).toBe(expected)
  })
})

describe('findLinksOnRow — 한 행', () => {
  it('평문 URL 의 범위는 1 기반·끝 포함', () => {
    const readRow = grid({ cols: 40, rows: ['see https://example.com/a now'] })
    expect(findLinksOnRow({ readRow, y: 0 })).toEqual([
      { text: 'https://example.com/a', range: { start: { x: 5, y: 1 }, end: { x: 25, y: 1 } } },
    ])
  })

  it('괄호·꺾쇠·따옴표 안 URL 은 바깥 구두점을 떼어 낸다 (C1ⓓ)', () => {
    expect(texts({ readRow: grid({ cols: 60, rows: ['(see https://x.y/a).'] }), y: 0 })).toEqual(['https://x.y/a'])
    expect(texts({ readRow: grid({ cols: 60, rows: ['<https://x.y>'] }), y: 0 })).toEqual(['https://x.y'])
    expect(texts({ readRow: grid({ cols: 60, rows: ["'https://x.y/q' and \"http://localhost:5173/\""] }), y: 0 })).toEqual([
      'https://x.y/q',
      'http://localhost:5173/',
    ])
  })

  it('R1-05 — 마크다운 굵게 안 URL, `\'` 에서는 끊는다(셸 따옴표 우선)', () => {
    expect(texts({ readRow: grid({ cols: 60, rows: ['**https://x.y/a**'] }), y: 0 })).toEqual(['https://x.y/a'])
    expect(texts({ readRow: grid({ cols: 60, rows: ["'https://x.y/it's'"] }), y: 0 })).toEqual(['https://x.y/it'])
  })

  it('스킴을 거르지 않는다 — 허용 판단은 main 술어 한 곳 (C3ⓒ)', () => {
    expect(texts({ readRow: grid({ cols: 60, rows: ['ftp://x.y/f file:///etc/hosts'] }), y: 0 })).toEqual(['ftp://x.y/f', 'file:///etc/hosts'])
  })

  it('스킴 중간이나 빈 호스트는 잡지 않는다', () => {
    expect(texts({ readRow: grid({ cols: 60, rows: ['https:// alone'] }), y: 0 })).toEqual([])
    expect(texts({ readRow: grid({ cols: 60, rows: ['no url here'] }), y: 0 })).toEqual([])
  })

  it('범위 밖 행은 빈 결과', () => {
    expect(findLinksOnRow({ readRow: grid({ cols: 10, rows: ['x'] }), y: 5 })).toEqual([])
  })
})

describe('findLinksOnRow — 줄 넘김 결합 (C4)', () => {
  // 폭 20: 첫 행이 마지막 칸까지 URL 로 찬다.
  const url = 'https://example.com/aaaa/bbbb?q=1'
  const rows = [url.slice(0, 20), url.slice(20) + ' tail']

  it('ⓐ 첫 행·둘째 행 어느 쪽에서 찾아도 전체 URL, 범위는 두 행에 걸친다', () => {
    const readRow = grid({ cols: 20, rows })
    const expected = [{ text: url, range: { start: { x: 1, y: 1 }, end: { x: url.length - 20, y: 2 } } }]
    expect(findLinksOnRow({ readRow, y: 0 })).toEqual(expected)
    expect(findLinksOnRow({ readRow, y: 1 })).toEqual(expected)
  })

  it('ⓐ 세 행에 걸친 URL 도 가운데 행에서 전체', () => {
    const long = 'https://example.com/' + 'x'.repeat(30)
    const readRow = grid({ cols: 20, rows: [long.slice(0, 20), long.slice(20, 40), long.slice(40)] })
    expect(texts({ readRow, y: 1 })).toEqual([long])
  })

  it('ⓐ 앞에 글이 있고 URL 이 행 끝에서 넘어가도 잇는다', () => {
    const readRow = grid({ cols: 20, rows: ['go https://example.c', 'om/path ok'] })
    expect(texts({ readRow, y: 0 })).toEqual(['https://example.com/path'])
    expect(texts({ readRow, y: 1 })).toEqual(['https://example.com/path'])
  })

  it('ⓑ 첫 행이 마지막 칸까지 차지 않으면 잇지 않는다', () => {
    const readRow = grid({ cols: 22, rows: ['https://example.com/a', 'bbbb'] })
    expect(texts({ readRow, y: 0 })).toEqual(['https://example.com/a'])
    expect(texts({ readRow, y: 1 })).toEqual([])
  })

  it('ⓐ 이어지는 행의 들여쓰기(≤ 8칸)는 건너뛰고 잇는다 — 범위는 들여쓰기 뒤 칸부터', () => {
    const readRow = grid({ cols: 20, rows: [rows[0] ?? '', '  ' + url.slice(20)] })
    const expected = [{ text: url, range: { start: { x: 1, y: 1 }, end: { x: url.length - 20 + 2, y: 2 } } }]
    expect(findLinksOnRow({ readRow, y: 0 })).toEqual(expected)
    expect(findLinksOnRow({ readRow, y: 1 })).toEqual(expected)
  })

  it('ⓑ 들여쓰기가 8칸을 넘으면 잇지 않는다', () => {
    const readRow = grid({ cols: 20, rows: [rows[0] ?? '', ' '.repeat(9) + url.slice(20)] })
    expect(texts({ readRow, y: 0 })).toEqual([url.slice(0, 20)])
    expect(texts({ readRow, y: 1 })).toEqual([])
  })

  it('ⓑ 다음 행이 빈 행이면 잇지 않는다', () => {
    const readRow = grid({ cols: 20, rows: [rows[0] ?? '', ''] })
    expect(texts({ readRow, y: 0 })).toEqual([url.slice(0, 20)])
  })

  it('ⓑ 첫 행 마지막 칸이 URL 문자가 아니면(넓은 글자 등) 잇지 않는다', () => {
    const readRow: ReadRow = (y) => {
      if (y === 0) return [...'https://ex.co/a'].map((chars) => ({ chars, width: 1 })).concat([{ chars: '가', width: 2 }, { chars: '', width: 0 }])
      if (y === 1) return [...'tail'].map((chars) => ({ chars, width: 1 }))
      return undefined
    }
    expect(texts({ readRow, y: 0 })).toEqual(['https://ex.co/a'])
    expect(texts({ readRow, y: 1 })).toEqual([])
  })
})

/** 넓은 글자(한글)는 2칸 + 폭 0 뒤 칸. 실제 샘플의 `⏺` 는 1칸이었다(f1-wrap-sample-06-shape.txt). */
function wideGrid(input: { cols: number; rows: string[] }): ReadRow {
  const cells: LinkCell[][] = input.rows.map((row) => {
    const line: LinkCell[] = []
    for (const chars of row) {
      if (/[\uac00-\ud7a3]/.test(chars)) line.push({ chars, width: 2 }, { chars: '', width: 0 })
      else line.push({ chars, width: 1 })
    }
    while (line.length < input.cols) line.push({ chars: '', width: 1 })
    return line
  })
  return (y) => cells[y]
}

describe('실제 Claude Code 2.1.280 샘플 모양 (fix r1 R1-01 — raw/claude/f1-wrap-sample-04·06)', () => {
  // 샘플 pane 폭 260. 아래 행은 샘플 화면의 행 13~15·17~19 와 글자 단위로 같다(f1-wrap-sample-06-shape.txt 의 대조).
  const cols = 260
  const u1 = 'https://example.com/l565-wrap/' + ['a'.repeat(150), 'b'.repeat(150), 'c'.repeat(150), 'd'.repeat(100)].join('/')
  const u2 = 'https://example.com/l565-list/' + ['e'.repeat(150), 'f'.repeat(150), 'g'.repeat(150), 'h'.repeat(100)].join('/')

  it('단독 URL — 첫 행 `⏺ ` 뒤 마지막 칸까지, 이어지는 행 2칸 들여쓰기 · 세 행 어디서나 전체 URL', () => {
    const readRow = wideGrid({ cols, rows: ['⏺ ' + u1.slice(0, 258), '  ' + u1.slice(258, 516), '  ' + u1.slice(516), ''] })
    for (const y of [0, 1, 2]) expect(texts({ readRow, y })).toEqual([u1])
    expect(findLinksOnRow({ readRow, y: 2 })[0]?.range).toEqual({ start: { x: 3, y: 1 }, end: { x: 2 + u1.length - 516, y: 3 } })
  })

  it('목록 항목 — `  - 링크: ` 뒤, 이어지는 행 4칸 들여쓰기 · 세 행 어디서나 전체 URL', () => {
    const readRow = wideGrid({ cols, rows: ['  - 링크: ' + u2.slice(0, 250), '    ' + u2.slice(250, 506), '    ' + u2.slice(506), ''] })
    for (const y of [0, 1, 2]) expect(texts({ readRow, y })).toEqual([u2])
  })

  it('음성 대조 — 사용자 입력 에코처럼 259칸에서 접혀 마지막 칸이 비면 잇지 않는다', () => {
    const readRow = wideGrid({ cols, rows: ['  ' + u1.slice(0, 257), '  ' + u1.slice(257)] })
    expect(texts({ readRow, y: 0 })).toEqual([u1.slice(0, 257)])
  })
})

describe('결합 경계 (R1-04 리뷰 재현)', () => {
  it('재현 1 (한계 고정) — URL 이 행 끝에서 정확히 끝나고 다음 행이 글자로 시작하면 잘못 잇는다', () => {
    const readRow = grid({ cols: 16, rows: ['https://a.com/xx', 'Then do this'] })
    expect(texts({ readRow, y: 0 })).toEqual(['https://a.com/xxThen'])
  })

  it('재현 2 — 다음 행이 다른 URL 로 시작하면 잇지 않는다 (두 링크)', () => {
    const readRow = grid({ cols: 16, rows: ['https://a.com/xx', 'https://b.com/yy'] })
    expect(texts({ readRow, y: 0 })).toEqual(['https://a.com/xx'])
    expect(texts({ readRow, y: 1 })).toEqual(['https://b.com/yy'])
  })

  it('재현 3 — 꽉 찬 글 행 아래의 URL 이 앞 행 끝 글자에 붙지 않는다', () => {
    const readRow = grid({ cols: 20, rows: ['aaaa bbbb cccc dddee', 'https://x.y/a'] })
    expect(texts({ readRow, y: 0 })).toEqual([])
    expect(findLinksOnRow({ readRow, y: 1 })).toEqual([{ text: 'https://x.y/a', range: { start: { x: 1, y: 2 }, end: { x: 13, y: 2 } } }])
  })

  it('재현 3 변형 — 전폭 `-` 구분선 바로 아래 col 0 URL 도 링크가 된다', () => {
    const readRow = grid({ cols: 20, rows: ['-'.repeat(20), 'https://x.y/a'] })
    expect(texts({ readRow, y: 1 })).toEqual(['https://x.y/a'])
  })

  it('들여쓴 다음 행이 URL 로 시작해도 잇지 않는다', () => {
    const readRow = grid({ cols: 16, rows: ['https://a.com/xx', '  https://b.com/'] })
    expect(texts({ readRow, y: 1 })).toEqual(['https://b.com/'])
  })
})

/** 첫 행 길이를 폭으로 — URL 이 마지막 칸에서 정확히 끝나는 꼴. */
const exact = (rows: string[]): ReadRow => grid({ cols: rows[0]?.length ?? 0, rows })

describe('fix r2 — 리뷰 r2 재현', () => {
  it('R2-01 다음 행이 목록 마커(`-`·`+`·`1.`·`2)`)로 시작하면 잇지 않는다', () => {
    expect(texts({ readRow: exact(['  - see https://example.com/abc', '  - next item here']), y: 0 })).toEqual(['https://example.com/abc'])
    expect(texts({ readRow: exact(['  1. see https://example.com/ab', '  2. next item here']), y: 0 })).toEqual(['https://example.com/ab'])
    expect(texts({ readRow: exact(['  + see https://example.com/ab', '  + next']), y: 0 })).toEqual(['https://example.com/ab'])
    expect(texts({ readRow: exact(['  1) see https://example.com/ab', '  2) next']), y: 0 })).toEqual(['https://example.com/ab'])
  })

  it('R2-01 대조 — 마커 꼴이 아닌 hard-break 조각(`-abc`·`12.html`)은 잇는다', () => {
    expect(texts({ readRow: exact(['  https://example.com/a', '  -abc/x']), y: 0 })).toEqual(['https://example.com/a-abc/x'])
    expect(texts({ readRow: exact(['  https://example.com/p', '  12.html']), y: 0 })).toEqual(['https://example.com/p12.html'])
  })

  it('R2-01 한계 고정 — 들여쓴 일반 글은 신호가 없어 잇는다', () => {
    expect(texts({ readRow: exact(['go to https://example.com/abcd', '  and then more text']), y: 0 })).toEqual(['https://example.com/abcdand'])
  })

  it('R2-03 결합 상한(16행)에 걸려 체인이 안 끝나면 잘린 링크를 내지 않는다', () => {
    const url = 'https://e.co/' + 'x'.repeat(177) // 190자, 폭 10 → 19행
    const rows = Array.from({ length: 19 }, (_, i) => url.slice(i * 10, i * 10 + 10))
    const readRow = grid({ cols: 10, rows })
    for (const y of [0, 5, 10, 18]) expect(texts({ readRow, y })).toEqual([])
  })

  it('R2-03 대조 — 상한 안(16행 이하)이면 전체 URL', () => {
    const url = 'https://e.co/' + 'x'.repeat(137) // 150자 → 15행
    const rows = Array.from({ length: 15 }, (_, i) => url.slice(i * 10, i * 10 + 10))
    expect(texts({ readRow: grid({ cols: 10, rows }), y: 14 })).toEqual([url])
  })

  it('R2-03 체인 밖에서 시작해 체인 안에서 끝난 URL 은 그대로 낸다(가운데 끊김만 문제)', () => {
    const readRow = grid({ cols: 40, rows: ['see https://example.com/x and more text'] })
    expect(texts({ readRow, y: 0 })).toEqual(['https://example.com/x'])
  })

  it('R2-04 경로 중간에서 비 ASCII 글자로 끊기면 링크를 내지 않는다', () => {
    expect(texts({ readRow: wideGrid({ cols: 60, rows: ['https://ko.wikipedia.org/wiki/한글 end'] }), y: 0 })).toEqual([])
    expect(texts({ readRow: wideGrid({ cols: 60, rows: ['https://x.y/search?q=검색 end'] }), y: 0 })).toEqual([])
  })

  it('R2-04 대조 — 조사가 붙은 URL·공백 뒤 한글은 링크로 둔다', () => {
    expect(texts({ readRow: wideGrid({ cols: 60, rows: ['https://example.com에서 확인'] }), y: 0 })).toEqual(['https://example.com'])
    expect(texts({ readRow: wideGrid({ cols: 60, rows: ['https://example.com/docs를 보세요'] }), y: 0 })).toEqual(['https://example.com/docs'])
    expect(texts({ readRow: wideGrid({ cols: 60, rows: ['https://example.com/wiki/ 한글'] }), y: 0 })).toEqual(['https://example.com/wiki/'])
  })
})

describe('활성화 — ⌘ 한정 (D1 · C3ⓐ)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('수식키 없는 클릭은 window.open 을 부르지 않는다', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openTerminalLink(new MouseEvent('mouseup'), 'https://example.com/')
    openTerminalLink(new MouseEvent('mouseup', { ctrlKey: true, altKey: true, shiftKey: true }), 'https://example.com/')
    expect(open).not.toHaveBeenCalled()
  })

  it('⌘+클릭은 URL 그대로 window.open 1회', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openTerminalLink(new MouseEvent('mouseup', { metaKey: true }), 'https://example.com/?l565=1')
    expect(open.mock.calls).toEqual([['https://example.com/?l565=1']])
  })

  it('OSC 8 linkHandler 도 같은 경로 — 스킴 무필터, confirm 미호출 (C2ⓑ · C3ⓑ)', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }
    expect(terminalLinkHandler.allowNonHttpProtocols).toBe(true)
    terminalLinkHandler.activate(new MouseEvent('mouseup', { metaKey: true }), 'file:///etc/hosts', range)
    terminalLinkHandler.activate(new MouseEvent('mouseup'), 'https://example.com/', range)
    expect(open.mock.calls).toEqual([['file:///etc/hosts']])
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('registerTerminalLinks — 실제 xterm 버퍼', () => {
  function write(term: Terminal, data: string): Promise<void> {
    return new Promise((resolve) => term.write(data, resolve))
  }

  it('autowrap 을 끈 절대 좌표 쓰기(frame-to-ansi 꼴)로 두 행에 그린 URL 을 잇는다', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    let provider: Parameters<Terminal['registerLinkProvider']>[0] | undefined
    vi.spyOn(term, 'registerLinkProvider').mockImplementation((p) => {
      provider = p
      return { dispose: () => {} }
    })
    registerTerminalLinks(term)
    const url = 'https://example.com/aaaa/bbbb?q=1'
    await write(term, `\x1b[?7l\x1b[1;1H${url.slice(0, 20)}\x1b[2;1H${url.slice(20)} 한글`)
    const links = await new Promise<Array<{ text: string }> | undefined>((resolve) => provider?.provideLinks(2, resolve))
    expect(links?.map((link) => link.text)).toEqual([url])
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false)
    term.dispose()
  })
})
