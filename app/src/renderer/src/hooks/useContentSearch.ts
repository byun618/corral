// 내용 전체 검색 세션을 App 이 든다(LIFE-803) — 패널을 숨겼다 다시 보여도 질의·결과가 그대로(C4ⓘ). 활성 worktree 가 바뀌면 세션에 알린다(C6).
// `visible` = 검색 보기가 보이는가 — 숨은 동안의 worktree 전환은 보일 때 찾는다(r1 R1-09). 보임을 루트보다 먼저 알린다.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { requestContentSearch } from '../content-search-client.js'
import { SearchSession, type SearchState } from '../content-search-session.js'

export type ContentSearchApi = { session: SearchSession; state: SearchState }

export function useContentSearch({ root, visible }: { root: string | null; visible: boolean }): ContentSearchApi {
  const [session] = useState(() => new SearchSession({ request: requestContentSearch, setTimer: (run, ms) => window.setTimeout(run, ms), clearTimer: (handle) => window.clearTimeout(typeof handle === 'number' ? handle : undefined) }))
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot)
  useEffect(() => session.setActive(visible), [session, visible])
  useEffect(() => session.setRoot(root), [session, root])
  useEffect(() => () => session.dispose(), [session])
  return { session, state }
}
