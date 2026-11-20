// 검색 결과 행 열기의 App 연결 (LIFE-803 C5·C6, r1 R1-03·R1-04) — 상태 표 행이 실제로 붙는 자리를 App 밖으로 뺀 훅(시험이 이 연결을 직접 본다).
//
// · 활성 탭(또는 worktree 저장소)이 대기 요청의 탭이 아니게 되면 그 요청의 적용 권리를 지운다(`revealSlot.activated` — effect).
// · 결과 행 클릭: 요청 뒤 포커스가 옮겨 갔는지는 **한 규칙**(`mayFocus` — App 포커스 순번이 그대로 그리고 활성 요소가 누른 행에서 떠나지 않았다)으로 본다.
//   편집기 첫 마운트의 포커스(`applyReveal`)와 연 탭 포커스 루프(`focusOpened` 의 `held`)가 같은 판정을 쓴다.
// · 이미 붙은 편집기는 다음 프레임에 — 그때 요청이 아직 그 탭의 것이고 활성 worktree 가 그대로일 때만 적용한다.
// · 그 탭이 마크다운 미리보기 모드면 요청을 남기지 않고 base 처럼 연다(C5ⓗ).
import { useEffect } from 'react'
import { fileTabId } from '../file-tabs.js'
import { focusMovedAway, revealSlot as defaultSlot, type RevealSlot } from '../file-reveal.js'
import type { ViewStateStore } from '../components/FileView.js'

export type SearchOpenRequest = { rel: string; line: number; column: number; preview: boolean }

export type SearchOpenDeps = {
  /** 지금 활성 worktree 경로와 그 보기 상태 저장소(렌더 값). */
  worktreePath: string | null
  store: ViewStateStore | null
  /** 활성 그룹의 활성 탭 id(렌더 값). */
  activeTabId: string | null
  /** 적용 시점의 활성 worktree 경로(ref 값). */
  currentWorktreePath: () => string | null
  /** 그 탭이 마크다운 미리보기 모드인가. */
  markdownPreview: (input: { worktreePath: string; tabId: string }) => boolean
  openFile: (input: { rel: string; preview: boolean }) => void
  /** 연 탭에 포커스 — 포커스 순번을 하나 올리고 그 순번을 돌려준다. `held` 가 거짓이 되면 포커스하지 않는다. */
  focusOpened: (input: { worktreePath: string; rel: string; held: () => boolean }) => number
  /** 지금 포커스 순번(App `focusSeqRef`). */
  focusSeq: () => number
  /** 이미 붙은 편집기에 대기 요청 적용(`revealInLiveEditor`). */
  revealLive: (input: { store: ViewStateStore; tabId: string }) => void
  frame?: (run: () => void) => void
  activeElement?: () => Element | null
  slot?: RevealSlot
}

export function useSearchOpen(deps: SearchOpenDeps): (input: SearchOpenRequest) => void {
  const slot = deps.slot ?? defaultSlot
  useEffect(() => {
    slot.activated({ store: deps.store, tabId: deps.activeTabId })
  }, [slot, deps.store, deps.activeTabId])
  return (input) => {
    const worktreePath = deps.worktreePath
    const store = deps.store
    if (worktreePath === null || store === null) return
    const tabId = fileTabId(input.rel)
    const activeElement = deps.activeElement ?? (() => document.activeElement)
    const from = activeElement()
    const held = (): boolean => !focusMovedAway({ from, now: activeElement(), body: document.body })
    if (deps.markdownPreview({ worktreePath, tabId })) {
      slot.discard({ store, tabId })
      deps.openFile({ rel: input.rel, preview: input.preview })
      deps.focusOpened({ worktreePath, rel: input.rel, held })
      return
    }
    const seq = { value: Number.NaN }
    slot.request({ store, tabId, target: { line: input.line, column: input.column }, mayFocus: () => deps.focusSeq() === seq.value && held() })
    deps.openFile({ rel: input.rel, preview: input.preview })
    seq.value = deps.focusOpened({ worktreePath, rel: input.rel, held })
    const frame = deps.frame ?? ((run: () => void) => void requestAnimationFrame(run))
    frame(() => {
      if (slot.current?.tabId !== tabId || slot.current.store !== store || deps.currentWorktreePath() !== worktreePath) return
      deps.revealLive({ store, tabId })
    })
  }
}
