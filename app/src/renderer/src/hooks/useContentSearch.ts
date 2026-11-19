// 내용 전체 검색 세션을 App 이 든다(LIFE-803) — 패널을 숨겼다 다시 보여도 질의·결과가 그대로(C4ⓘ). 활성 worktree 가 바뀌면 세션에 알린다(C6).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { requestContentSearch } from '../content-search-client.js'
import { SearchSession, type SearchState } from '../content-search-session.js'

export type ContentSearchApi = { session: SearchSession; state: SearchState }

export function useContentSearch(root: string | null): ContentSearchApi {
  const [session] = useState(() => new SearchSession({ request: requestContentSearch, setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: (handle) => window.clearTimeout(typeof handle === 'number' ? handle : undefined) }))
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  useEffect(() => session.setRoot(root), [session, root])
  useEffect(() => () => session.dispose(), [session])
  return { session, state }
}
