// LIFE-803 C4ⓓⓕ·C6 — 검색 세션 상태 표(01-criteria C6) 행마다 한 개 이상. 가짜 요청·가짜 타이머로 순서를 직접 쥔다.
import { describe, expect, it } from 'vitest'
import { SearchSession, type SearchRequest } from './content-search-session.js'
import type { ContentSearchResult } from '../../shared/content-search.js'

type Call = { input: Parameters<SearchRequest>[0]; resolve: (result: ContentSearchResult) => void; cancelled: boolean }

function harness() {
  const calls: Call[] = []
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  const session = new SearchSession({
    request: (input) => {
      let resolve: (result: ContentSearchResult) => void = () => undefined
      const result = new Promise<ContentSearchResult>((done) => {
        resolve = done
      })
      const call: Call = { input, resolve, cancelled: false }
      calls.push(call)
      return { result, cancel: () => { call.cancelled = true } }
    },
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const found = timers.find((timer) => timer === handle)
      if (found !== undefined) found.cleared = true
    },
  })
  const fire = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run()
  }
  return { session, calls, timers, fire }
}
const ok = (root: string, rel: string): Extract<ContentSearchResult, { ok: true }> => ({ ok: true, root, files: [{ rel, lines: [{ line: 1, column: 1, preview: 'foo', ranges: [{ start: 0, end: 3 }], matches: 1, clippedStart: false, clippedEnd: false }] }], lineCount: 1, matchCount: 1, truncated: false, ms: 1 })
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('상태 표 — 질의·토글 변경', () => {
  it('질의 입력은 지연 뒤 한 번(값 300 ms), 그 사이 다시 치면 앞 대기를 지운다', () => {
    const { session, calls, timers, fire } = harness()
    session.setRoot('/w')
    session.setQuery('f')
    session.setQuery('fo')
    expect(timers.map((timer) => [timer.ms, timer.cleared])).toEqual([[300, true], [300, false]])
    expect(calls).toHaveLength(0)
    fire()
    expect(calls.map((call) => call.input.query)).toEqual(['fo'])
    expect(session.state.status).toBe('searching')
  })
  it('토글은 바로 찾고 앞 요청을 취소한다(세대 +1)', () => {
    const { session, calls, fire } = harness()
    session.setRoot('/w')
    session.setQuery('foo')
    fire()
    const before = session.currentGeneration
    session.setOption('regex', true)
    expect(session.currentGeneration).toBe(before + 1)
    expect(calls[0]?.cancelled).toBe(true)
    expect(calls[1]?.input).toEqual({ root: '/w', query: 'foo', caseSensitive: false, wholeWord: false, regex: true })
  })
  it('Enter(submit)는 지연 없이 바로', () => {
    const { session, calls } = harness()
    session.setRoot('/w')
    session.setQuery('foo')
    session.submit()
    expect(calls).toHaveLength(1)
  })
})

describe('상태 표 — 빈 질의', () => {
  it('결과·진행 중 요청을 지우고 git 호출 0(C4ⓓ)', async () => {
    const { session, calls, fire } = harness()
    session.setRoot('/w')
    session.setQuery('foo')
    fire()
    calls[0]?.resolve(ok('/w', 'a.txt'))
    await flush()
    expect(session.state.files).toHaveLength(1)
    session.setQuery('x')
    fire()
    session.setQuery('')
    fire()
    expect(calls[1]?.cancelled).toBe(true)
    expect(calls).toHaveLength(2)
    expect(session.state).toMatchObject({ status: 'idle', files: [], matchCount: 0 })
  })
  it('처음부터 빈 질의로 Enter 해도 요청 0', () => {
    const { session, calls } = harness()
    session.setRoot('/w')
    session.submit()
    expect(calls).toHaveLength(0)
  })
})

describe('상태 표 — 검색 응답(세대·루트 확인)', () => {
  it('현재 세대 응답만 적용 — 늦게 온 앞 세대 응답은 버린다', async () => {
    const { session, calls } = harness()
    session.setRoot('/w')
    session.setQuery('a')
    session.submit()
    session.setQuery('b')
    session.submit()
    calls[1]?.resolve(ok('/w', 'b.txt'))
    await flush()
    calls[0]?.resolve(ok('/w', 'a.txt'))
    await flush()
    expect(session.state.files.map((file) => file.rel)).toEqual(['b.txt'])
    expect(session.state.status).toBe('done')
  })
  it('오류는 오류 상태로(결과 0), 취소 응답은 아무것도 바꾸지 않는다', async () => {
    const { session, calls } = harness()
    session.setRoot('/w')
    session.setQuery('fo(')
    session.submit()
    calls[0]?.resolve({ ok: false, code: 'git_failed', error: "fatal: -e option, 'fo(': missing closing parenthesis" })
    await flush()
    expect(session.state).toMatchObject({ status: 'error', files: [], error: "fatal: -e option, 'fo(': missing closing parenthesis" })
    session.submit()
    calls[1]?.resolve({ ok: false, code: 'cancelled', error: '취소됨' })
    await flush()
    expect(session.state.status).toBe('searching')
  })
  it('잘림 표시를 싣는다', async () => {
    const { session, calls } = harness()
    session.setRoot('/w')
    session.setQuery('e')
    session.submit()
    calls[0]?.resolve({ ...ok('/w', 'a.txt'), truncated: true })
    await flush()
    expect(session.state.truncated).toBe(true)
  })
})

describe('상태 표 — 활성 worktree 전환', () => {
  it('진행 중 요청 취소·앞 루트 결과 지움, 질의가 있으면 새 루트로 바로, 앞 루트의 늦은 응답은 새 루트에 안 보인다', async () => {
    const { session, calls } = harness()
    session.setRoot('/a')
    session.setQuery('foo')
    session.submit()
    calls[0]?.resolve(ok('/a', 'from-a.txt'))
    await flush()
    session.submit()
    session.setRoot('/b')
    expect(calls[1]?.cancelled).toBe(true)
    expect(session.state.files).toEqual([])
    expect(calls[2]?.input.root).toBe('/b')
    calls[1]?.resolve(ok('/a', 'late-a.txt'))
    await flush()
    expect(session.state.files).toEqual([])
    calls[2]?.resolve(ok('/b', 'from-b.txt'))
    await flush()
    expect(session.state.files.map((file) => file.rel)).toEqual(['from-b.txt'])
    expect(session.state.query).toBe('foo')
  })
  it('루트가 없어지면 idle', () => {
    const { session, calls } = harness()
    session.setRoot('/a')
    session.setQuery('foo')
    session.setRoot(null)
    session.submit()
    expect(calls).toHaveLength(0)
    expect(session.state.status).toBe('idle')
  })
})

describe('상태 표 — 패널 숨김/다시 보임·접기', () => {
  it('세션은 보기 밖에 있다 — 구독을 끊었다 다시 붙여도 질의·결과가 그대로', async () => {
    const { session, calls } = harness()
    session.setRoot('/w')
    session.setQuery('foo')
    session.submit()
    calls[0]?.resolve(ok('/w', 'a.txt'))
    await flush()
    const off = session.subscribe(() => undefined)
    off()
    session.subscribe(() => undefined)
    expect(session.state).toMatchObject({ query: 'foo', status: 'done' })
    expect(session.state.files).toHaveLength(1)
  })
  it('파일 묶음 접기/펴기', () => {
    const { session } = harness()
    session.toggleCollapsed('a.txt')
    expect(session.state.collapsed.has('a.txt')).toBe(true)
    session.toggleCollapsed('a.txt')
    expect(session.state.collapsed.has('a.txt')).toBe(false)
  })
})
