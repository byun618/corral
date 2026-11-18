// 터미널 검색 막대의 상태 (LIFE-812) — 비동기 적용을 **한 규칙**으로 짠다(coding.md · 01-criteria 「상태 표」).
//
// 규칙: 요청을 낼 때마다 표(ticket)를 하나 뗀다(`latest + 1`). 응답은 **적용하는 순간**
//   ⓐ 막대가 아직 열려 있고 ⓑ 그 표가 마지막으로 뗀 표일 때만 적용한다.
// 주인(pane)은 컨트롤러 하나에 하나로 고정이다 — pane 이 바뀌거나 사라지면(탭 전환·pane 닫힘·worktree 전환) 컨트롤러를 버리고(`dispose`)
// 새로 만든다. 그래서 「같은 주인」은 「버려지지 않은 컨트롤러」와 같다.
// 표를 무효로 만드는 것은 실제로 일어난 일뿐이다: 새 요청(질의 변경·다음/이전)·닫기·버리기.
// 닫기·질의 변경·버리기는 main 에도 취소를 보낸다(fix1 R1-4) — main 이 이미 받은 이동(reveal)·재시도 대기는 거기서 낡는다(main 의 검색 표).
// 응답을 기다리는 동안 누른 다음/이전은 버리지 않고 줄 세워, 응답이 오면 **그 응답의 현재 일치**에서 이어 묻는다(fix1 R1-3 — n 번 = n 칸).
//
// | 사건 | 세우는 것 | 지우는 것 | 적용 시점 확인 |
// | 열기 | open, 막대 포커스(컴포넌트) | — | — |
// | 질의 변경·열 수 변경(reflow — fix3 R3-2) | 새 표 | 이전 결과(강조·k/총) | 응답 표 = 마지막 표 · 열림 |
// | 검색 응답 | 결과 | — | 같은 확인 |
// | 다음/이전 | 대기 중이면 줄에 쌓음 · 아니면 새 표 → 응답 뒤 현재 일치, 줄이 비면 결과로 이동 요청 | — | 같은 확인 |
// | 이동(스크롤) 응답 | (강조는 다음 프레임의 scrollTop 으로 다시 그린다) | — | main: 그 검색 표가 아직 그 pane 의 마지막 표인가 |
// | 닫기 | 포커스 → 주인 pane(컴포넌트) | 결과·쌓인 다음/이전·대기 요청의 적용 권리(표 무효 + main 취소) | — |
// | 버리기 | — | 대기 요청의 적용 권리(표 무효 + main 취소) | — |

import {
  TERMINAL_SEARCH_MAX_QUERY_BYTES,
  queryBytes,
  type TerminalRevealRequest,
  type TerminalRevealResult,
  type TerminalSearchRequest,
  type TerminalSearchResult,
} from '../../shared/terminal-search.js'

export const SEARCH_DEBOUNCE_MS = 120
/**
 * 응답 대기 중 쌓아 두는 다음/이전의 상한(fix2 R2-3). 의도적 연타 몇 번은 그대로 칸 수가 되고(대기 1 + 쌓임 4 = 5칸),
 * 느린 pane 에서 키를 누르고 있어 반복 키가 수십 개 와도 뗀 뒤 몇 초씩 계속 넘어가지 않는다 — 넘친 것은 버린다.
 */
export const MAX_QUEUED_STEPS = 4

export type TerminalSearchState = {
  open: boolean
  query: string
  /** 마지막 적용 결과 — 질의가 바뀌면 지운다. */
  result: TerminalSearchResult | null
  /** 응답을 기다리는 요청이 있나. */
  pending: boolean
  /** 질의가 상한을 넘어 요청하지 않았다(C1ⓔ). */
  tooLong: boolean
}

export type TerminalSearchDeps = {
  paneId: string
  search: (request: TerminalSearchRequest) => Promise<TerminalSearchResult>
  reveal: (input: TerminalRevealRequest) => Promise<TerminalRevealResult>
  /** main 의 이 pane 검색 표를 낡게 한다(대기 중 재시도·이동 요청을 버린다). */
  cancel: () => void
  onChange: (state: TerminalSearchState) => void
}

export const CLOSED_SEARCH: TerminalSearchState = { open: false, query: '', result: null, pending: false, tooLong: false }

export class TerminalSearchController {
  private state: TerminalSearchState = CLOSED_SEARCH
  private latest = 0
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 응답을 기다리는 동안 누른 다음/이전(R1-3). */
  private queued: Array<'forward' | 'backward'> = []
  /** main 에 보낸 것이 있어 취소할 거리가 있나 — 아무것도 안 보낸 pane 이 내려갈 때 IPC 를 아낀다. */
  private issued = false
  private readonly deps: TerminalSearchDeps

  constructor(deps: TerminalSearchDeps) {
    this.deps = deps
  }

  get snapshot(): TerminalSearchState {
    return this.state
  }

  open(): void {
    if (this.disposed || this.state.open) return
    this.set({ ...CLOSED_SEARCH, open: true })
  }

  close(): void {
    if (!this.state.open) return
    this.invalidate()
    this.set(CLOSED_SEARCH)
  }

  dispose(): void {
    this.invalidate()
    this.disposed = true
  }

  /** 입력이 바뀌었다 — 이전 결과를 지우고, 잠깐 기다렸다 새로 묻는다. 빈 질의·상한 초과는 묻지 않는다(C4ⓕ·C1ⓔ). */
  setQuery(query: string): void {
    if (!this.state.open || query === this.state.query) return
    this.invalidate()
    const tooLong = queryBytes(query) > TERMINAL_SEARCH_MAX_QUERY_BYTES
    this.set({ ...this.state, query, result: null, pending: false, tooLong })
    if (query === '' || tooLong) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.request({ direction: 'backward', from: 'viewport' })
    }, SEARCH_DEBOUNCE_MS)
  }

  /**
   * 열 수가 바뀌었다(fix3 R3-2) — reflow 로 일치 좌표가 낡았다. 「질의 변경」과 같은 규칙으로 결과를 지우고 같은 질의를 다시 묻는다.
   * 창·경계 드래그로 연달아 와도 지연 타이머 하나로 모인다.
   */
  refresh(): void {
    if (!this.state.open || this.state.query === '' || this.state.tooLong) return
    this.invalidate()
    this.set({ ...this.state, result: null, pending: false })
    this.timer = setTimeout(() => {
      this.timer = null
      this.request({ direction: 'backward', from: 'viewport' })
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Enter(다음)·⇧Enter(이전). 아직 결과가 없으면(대기 중 질의·없음·바쁨·오류) 처음부터 다시 묻는다. */
  step(direction: 'forward' | 'backward'): void {
    if (!this.state.open || this.state.query === '' || this.state.tooLong) return
    // 응답 대기 중이면 줄에 쌓는다 — 지금 현재 일치는 낡았다(그 위에서 다시 물으면 같은 칸을 또 묻는다).
    if (this.state.pending) {
      if (this.queued.length < MAX_QUEUED_STEPS) this.queued.push(direction)
      return
    }
    this.cancelTimer()
    const result = this.state.result
    if (result !== null && result.kind === 'found') this.request({ direction, from: result.current })
    else this.request({ direction: 'backward', from: 'viewport' })
  }

  private request(input: Pick<TerminalSearchRequest, 'direction' | 'from'>): void {
    const ticket = ++this.latest
    const query = this.state.query
    this.issued = true
    this.set({ ...this.state, pending: true })
    void this.deps
      .search({ paneId: this.deps.paneId, query, ...input })
      .catch((error: unknown): TerminalSearchResult => ({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        if (!this.current(ticket)) return
        this.set({ ...this.state, result, pending: false })
        if (result.kind !== 'found') {
          this.queued = []
          return
        }
        const next = this.queued.shift()
        if (next !== undefined) {
          this.request({ direction: next, from: result.current })
          return
        }
        void this.deps
          .reveal({ paneId: this.deps.paneId, row: result.current.start.row, token: result.token })
          .catch((): TerminalRevealResult => ({ scrolled: false, top: null }))
      })
  }

  /** 적용 시점 확인 — 이 규칙 하나뿐이다. */
  private current(ticket: number): boolean {
    return !this.disposed && this.state.open && ticket === this.latest
  }

  /** 닫기·질의 변경·버리기 — 대기 중 요청·쌓인 이동을 버리고 main 에도 취소를 보낸다. */
  private invalidate(): void {
    this.cancelTimer()
    this.latest += 1
    this.queued = []
    if (this.issued) {
      this.issued = false
      this.deps.cancel()
    }
  }

  private cancelTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private set(next: TerminalSearchState): void {
    this.state = next
    if (!this.disposed) this.deps.onChange(next)
  }
}

/** 막대 문구 — `k / 총`·없음·바쁨·오류·상한 (C4ⓑⓗ·C1ⓔ). */
export function searchStatusText(state: TerminalSearchState): string {
  if (state.tooLong) return '검색어가 너무 깁니다'
  const result = state.result
  if (result === null) return state.pending ? '찾는 중…' : ''
  switch (result.kind) {
    case 'found':
      return `${result.index + 1} / ${result.total}`
    case 'none':
      return '결과 없음'
    case 'busy':
      return '출력이 계속 바뀌어 찾지 못했습니다 — Enter 로 다시'
    case 'error':
      return '검색 실패'
    case 'cancelled':
      return ''
  }
}

const FIND_EVENT = 'corral:terminal-find'

/** ⌘F(`terminal.find`) — 그 pane 의 막대를 연다. 막대는 한 번에 하나라 다른 pane 의 막대는 이 알림에 닫힌다. */
export function requestTerminalFind(paneId: string): void {
  window.dispatchEvent(new CustomEvent<string>(FIND_EVENT, { detail: paneId }))
}

/** 찾기 요청을 듣는다 — `listener(paneId)`. 해제 함수를 돌려준다. */
export function onTerminalFind(listener: (paneId: string) => void): () => void {
  const handler = (event: Event): void => {
    if (event instanceof CustomEvent && typeof event.detail === 'string') listener(event.detail)
  }
  window.addEventListener(FIND_EVENT, handler)
  return () => window.removeEventListener(FIND_EVENT, handler)
}
