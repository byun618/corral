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

  it('ⓑ 다음 행 첫 칸이 공백이면 잇지 않는다', () => {
    const readRow = grid({ cols: 20, rows: [rows[0] ?? '', ' ' + url.slice(20)] })
    expect(texts({ readRow, y: 0 })).toEqual([url.slice(0, 20)])
    expect(texts({ readRow, y: 1 })).toEqual([])
  })

  it('ⓑ 첫 행 마지막 칸이 URL 문자가 아니면(넓은 글자 등) 잇지 않는다', () => {
    const readRow: ReadRow = (y) => {
      if (y === 0) return [...'https://ex.co/'].map((chars) => ({ chars, width: 1 })).concat([{ chars: '가', width: 2 }, { chars: '', width: 0 }])
      if (y === 1) return [...'tail'].map((chars) => ({ chars, width: 1 }))
      return undefined
    }
    expect(texts({ readRow, y: 0 })).toEqual(['https://ex.co/'])
    expect(texts({ readRow, y: 1 })).toEqual([])
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
