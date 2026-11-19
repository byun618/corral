// 세션 히스토리 구독 (LIFE-808 C11·C17·C18) — 「세션」 보기가 **보일 때만** main 에 묻는다. 상시 타이머 없음.
//   · 보기가 열릴 때 1회 · 새로고침 단추 1회 · 에이전트 필터를 바꾸면 1회(끈 provider 는 main 이 훑지 않는다 — C18)
//   · 파일이 안 바뀌었으면 main 캐시가 파싱을 막는다(path·size·mtime)
//
// 늦은 응답(C11 상태 표 — `.agents/rules/coding.md` 비동기 적용 규칙):
//   · 목록 = 마지막으로 끝난 스캔 결과. 새 스캔 결과가 도착했을 때만 교체(새로고침 중에는 이전 목록 + 불러오는 중 표지).
//     적용 시점: 응답의 요청 번호 = 마지막 요청 번호일 때만.
//   · 상세 = 「현재 선택 세션」의 마지막 응답. 선택이 실제로 바뀔 때만 이전 상세를 지운다.
//     적용 시점: 응답의 세션 = 현재 선택이고 그 요청이 그 선택의 마지막 요청일 때만, 아니면 버린다.
//     새로고침은 선택이 있으면 상세도 같은 번호 규칙으로 다시 묻는다(R2-5 — 오류로 끝난 상세 포함). 응답 전까지 이전 상세를 둔다.
//   · 범위·검색어 = 사용자 입력(동기 — 목록에 바로 적용).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_HISTORY_AGENTS,
  enabledProviders,
  isHistoryProvider,
  readHistoryAgents,
  type HistoryAgents,
  type HistoryProvider,
  type HistoryScope,
  type SessionHistoryDetailResult,
  type SessionHistoryListResult,
  type SessionKey,
} from '../../../shared/session-history.js'

export type HistoryListState = { kind: 'loading' } | { kind: 'ready'; result: SessionHistoryListResult; refreshing: boolean }
export type HistoryDetailState = { kind: 'none' } | { kind: 'loading'; key: SessionKey } | { kind: 'ready'; key: SessionKey; result: SessionHistoryDetailResult }

export type SessionHistoryApi = {
  list: HistoryListState
  agents: HistoryAgents
  setAgent: (input: { provider: HistoryProvider; on: boolean }) => void
  hideEmpty: boolean
  setHideEmpty: (on: boolean) => void
  scope: HistoryScope
  setScope: (scope: HistoryScope) => void
  query: string
  setQuery: (query: string) => void
  refresh: () => void
  selected: SessionKey | null
  select: (key: SessionKey | null) => void
  detail: HistoryDetailState
}

const sameKey = (a: SessionKey | null, b: SessionKey | null): boolean => a !== null && b !== null && a.provider === b.provider && a.id === b.id

export function useSessionHistory({ active }: { active: boolean }): SessionHistoryApi {
  const [prefsReady, setPrefsReady] = useState(false)
  const [agents, setAgents] = useState<HistoryAgents>({ ...DEFAULT_HISTORY_AGENTS })
  const [hideEmpty, setHideEmptyState] = useState(true)
  const [scope, setScope] = useState<HistoryScope>('worktree')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<HistoryListState>({ kind: 'loading' })
  const [selected, setSelected] = useState<SessionKey | null>(null)
  const [detail, setDetail] = useState<HistoryDetailState>({ kind: 'none' })
  const listSeq = useRef(0)
  const detailSeq = useRef(0)
  const selectedRef = useRef<SessionKey | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve()
      .then(() => window.corral.getUiPrefs())
      .then((prefs) => {
        if (cancelled) return
        setAgents(readHistoryAgents(prefs.sessionHistoryAgents))
        setHideEmptyState(prefs.sessionHistoryHideEmpty !== false)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPrefsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const scan = useCallback((providers: HistoryProvider[]) => {
    listSeq.current += 1
    const mine = listSeq.current
    setList((current) => (current.kind === 'ready' ? { ...current, refreshing: true } : { kind: 'loading' }))
    const apply = (result: SessionHistoryListResult): void => {
      if (mine !== listSeq.current) return
      setList({ kind: 'ready', result, refreshing: false })
    }
    void Promise.resolve()
      .then(() => window.corral.sessionHistoryList({ providers }))
      .then(apply)
      .catch((error: unknown) => apply({ kind: 'error', message: String(error).slice(0, 200) }))
  }, [])

  /** 켠 목록이 바뀔 때만 다시 훑는다(agents 객체 정체가 아니라). */
  const providerKey = enabledProviders(agents).join(',')
  useEffect(() => {
    if (!active || !prefsReady) return
    const providers = providerKey.split(',').filter(isHistoryProvider)
    if (providers.length === 0) {
      // 둘 다 끄면 훑지 않는다 — 몸통은 「에이전트를 하나 이상 고르세요」(C18). 늦게 오는 이전 스캔은 버린다.
      listSeq.current += 1
      return
    }
    scan(providers)
  }, [active, prefsReady, providerKey, scan])

  /** 상세 요청 — 번호를 올리고, 응답은 그 번호·현재 선택이 그대로일 때만 적용한다. */
  const requestDetail = useCallback((key: SessionKey) => {
    detailSeq.current += 1
    const mine = detailSeq.current
    const apply = (result: SessionHistoryDetailResult): void => {
      if (mine !== detailSeq.current || !sameKey(key, selectedRef.current)) return
      setDetail({ kind: 'ready', key, result })
    }
    void Promise.resolve()
      .then(() => window.corral.sessionHistoryDetail(key))
      .then(apply)
      .catch((error: unknown) => apply({ kind: 'error', message: String(error).slice(0, 200) }))
  }, [])

  const refresh = useCallback(() => {
    const providers = enabledProviders(agents)
    if (providers.length > 0) scan(providers)
    if (selectedRef.current !== null) requestDetail(selectedRef.current)
  }, [agents, scan, requestDetail])

  const setAgent = useCallback(({ provider, on }: { provider: HistoryProvider; on: boolean }) => {
    const next = { ...agents, [provider]: on }
    setAgents(next)
    window.corral.setUiPrefs({ sessionHistoryAgents: next })
  }, [agents])

  const setHideEmpty = useCallback((on: boolean) => {
    setHideEmptyState(on)
    window.corral.setUiPrefs({ sessionHistoryHideEmpty: on })
  }, [])

  const select = useCallback((key: SessionKey | null) => {
    if (sameKey(key, selectedRef.current)) return
    selectedRef.current = key
    setSelected(key)
    if (key === null) {
      detailSeq.current += 1
      setDetail({ kind: 'none' })
      return
    }
    setDetail({ kind: 'loading', key })
    requestDetail(key)
  }, [requestDetail])

  return { list, agents, setAgent, hideEmpty, setHideEmpty, scope, setScope, query, setQuery, refresh, selected, select, detail }
}
