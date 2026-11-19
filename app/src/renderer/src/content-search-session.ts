// 내용 전체 검색 세션 (LIFE-803 C4·C6) — 검색 보기의 질의·토글·결과·상태를 한 곳에 든다. React 밖의 순수 객체라 상태 표를 그대로 시험한다.
//
// 상태 표(01-criteria C6) 한 규칙 — **검색 세대**:
// · 질의·토글 변경 → 세대 +1, 앞 요청 취소(main 이 git 을 끝낸다), 빈 질의가 아니면 새 요청(질의는 `SEARCH_DEBOUNCE_MS` 뒤, 토글·Enter 는 바로).
// · 빈 질의 → 세대 +1, 결과·진행 중 요청을 지운다(git 호출 0 — C4ⓓ).
// · 활성 worktree 전환 → 세대 +1, 진행 중 요청 취소, 앞 루트 결과를 지운다. 질의가 있으면 새 루트로 바로 다시 찾는다 — 보기가 숨어 있으면
//   찾지 않고 보일 때 찾는다(r1 R1-09 — 안 보이는 곳에서 git 을 띄우지 않는다).
// · 검색 응답 → **응답의 세대 = 지금 세대 그리고 응답의 루트 = 지금 루트** 일 때만 적용한다.
// · 패널 숨김·다시 보임 → 아무것도 안 한다(세션은 App 이 들고 있다 — C4ⓘ).
import type { ContentSearchFile, ContentSearchInput, ContentSearchOptions, ContentSearchResult } from '../../shared/content-search.js'

/** 입력 중 지연 검색(C4ⓕ). */
export const SEARCH_DEBOUNCE_MS = 300

export type SearchStatus = 'idle' | 'searching' | 'done' | 'error'
export type SearchState = {
  query: string
  options: ContentSearchOptions
  root: string | null
  status: SearchStatus
  /** 마지막으로 적용한 결과(검색 중에도 앞 결과를 보인다 — 같은 루트일 때만). */
  files: readonly ContentSearchFile[]
  lineCount: number
  matchCount: number
  /** 거짓이면 실제 일치 수는 `matchCount` 이상(정규식 둘째 이후·`-o` 상한 — r1 R1-10). */
  matchCountExact: boolean
  truncated: boolean
  error: string | null
  /** 접은 파일(rel). */
  collapsed: ReadonlySet<string>
}

export type SearchRequest = (input: Omit<ContentSearchInput, 'requestId'>) => { result: Promise<ContentSearchResult>; cancel: () => void }
export type SearchSessionDeps = {
  request: SearchRequest
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  debounceMs?: number
}

const EMPTY: Pick<SearchState, 'files' | 'lineCount' | 'matchCount' | 'matchCountExact' | 'truncated' | 'error' | 'collapsed'> = {
  files: [],
  lineCount: 0,
  matchCount: 0,
  matchCountExact: true,
  truncated: false,
  error: null,
  collapsed: new Set(),
}

export class SearchSession {
  private generation = 0
  private inflight: { cancel: () => void } | null = null
  private timer: unknown = null
  /** 보기가 보이는가 — 숨은 동안 worktree 가 바뀌면 `refreshOnShow` 를 세우고 보일 때 찾는다. */
  private active = true
  private refreshOnShow = false
  private listeners = new Set<() => void>()
  private snapshot: SearchState = { query: '', options: { caseSensitive: false, wholeWord: false, regex: false }, root: null, status: 'idle', ...EMPTY }

  constructor(private readonly deps: SearchSessionDeps) {}

  get state(): SearchState {
    return this.snapshot
  }

  /** 지금 검색 세대(시험·계측). */
  get currentGeneration(): number {
    return this.generation
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SearchState => this.snapshot

  private set(next: Partial<SearchState>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  /** 세대 +1 — 앞 세대의 대기·진행 중 요청을 지운다(취소). */
  private bump(): number {
    this.generation += 1
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer)
      this.timer = null
    }
    this.inflight?.cancel()
    this.inflight = null
    return this.generation
  }

  /** 질의·옵션이 바뀌었다 — 빈 질의면 비우고, 아니면 `delay` 대로 찾는다. */
  private changed(delay: 'debounce' | 'now'): void {
    const generation = this.bump()
    if (this.snapshot.query === '' || this.snapshot.root === null) {
      this.set({ status: 'idle', ...EMPTY })
      return
    }
    this.set({ status: 'searching', error: null })
    if (delay === 'now') this.run(generation)
    else this.timer = this.deps.setTimer(() => this.run(generation), this.deps.debounceMs ?? SEARCH_DEBOUNCE_MS)
  }

  private run(generation: number): void {
    if (generation !== this.generation) return
    this.timer = null
    const root = this.snapshot.root
    if (root === null || this.snapshot.query === '') return
    const handle = this.deps.request({ root, query: this.snapshot.query, ...this.snapshot.options })
    this.inflight = handle
    void handle.result.then((result) => {
      // 적용 시점 확인 — 세대·루트가 그대로일 때만(C6 「검색 응답」).
      if (generation !== this.generation || root !== this.snapshot.root) return
      this.inflight = null
      if (result.ok) {
        if (result.root !== root) return
        this.set({ status: 'done', files: result.files, lineCount: result.lineCount, matchCount: result.matchCount, matchCountExact: result.matchCountExact, truncated: result.truncated, error: null, collapsed: new Set() })
        return
      }
      if (result.code === 'cancelled') return
      this.set({ status: 'error', ...EMPTY, error: result.error })
    })
  }

  setQuery(query: string): void {
    if (query === this.snapshot.query) return
    this.set({ query })
    this.changed('debounce')
  }

  setOption(name: keyof ContentSearchOptions, value: boolean): void {
    if (this.snapshot.options[name] === value) return
    this.set({ options: { ...this.snapshot.options, [name]: value } })
    this.changed('now')
  }

  /** Enter — 지연 없이 지금 찾는다(같은 질의여도 다시). */
  submit(): void {
    this.changed('now')
  }

  /** 활성 worktree 전환 — 앞 루트의 결과·요청을 지우고, 질의가 있으면 새 루트로 다시 찾는다. */
  setRoot(root: string | null): void {
    if (root === this.snapshot.root) return
    this.bump()
    this.set({ root, status: 'idle', ...EMPTY })
    const wanted = this.snapshot.query !== '' && root !== null
    this.refreshOnShow = wanted && !this.active
    if (wanted && this.active) this.changed('now')
  }

  /** 보기가 보인다/숨는다. 숨은 동안 루트가 바뀌어 미뤄 둔 검색이 있으면 보일 때 찾는다. 같은 루트로 숨겼다 보이면 아무것도 안 한다(C4ⓘ). */
  setActive(active: boolean): void {
    this.active = active
    if (!active || !this.refreshOnShow) return
    this.refreshOnShow = false
    this.changed('now')
  }

  toggleCollapsed(rel: string): void {
    const collapsed = new Set(this.snapshot.collapsed)
    if (collapsed.has(rel)) collapsed.delete(rel)
    else collapsed.add(rel)
    this.set({ collapsed })
  }

  dispose(): void {
    this.refreshOnShow = false
    this.bump()
  }
}
