// 닫기 확인 모달의 문구 (LIFE-495 K5 · D15 · K3ⓒ) — 순수 함수. 모달 자체(`ConfirmClose.tsx`)와 게이트(main)는 그대로다.
//
// 문구의 뜻 = Orca 220 `CloseTerminalDialog.tsx`·`PinnedTabCloseDialog.tsx`, 말은 corral UI 언어(한국어).
//   · 에이전트가 도는 pane 이 하나라도 있으면 「에이전트를 멈출까」(220 은 split 에 섞이면 에이전트 우선 — 같다)
//   · 그 밖의 실행 중이면 「실행 중인 명령을 멈출까」
//   · 실행 중은 없는데 핀 탭이면 「고정된 탭을 닫을까」(핀이면서 실행 중이면 실행 중 문구 + 고정 안내 한 줄 — 창은 한 번)
// 「다시 묻지 않음」은 없다(P4·D28 — 설정 페이지가 없다).
//
// **에이전트 판정** (K5ⓒ): 게이트가 실행 중으로 판정한 pane 중 corral 의 pane 에이전트 귀속(`PaneRow.agent` — herdr 가 그 pane 에서
// 감지한 에이전트 이름)이 있는 것. 220 의 `agentStatusByPaneKey[...].agentType !== 'unknown'` 에 대응한다. 실행 중 판정 자체는 바꾸지
// 않는다(셸 아닌 포그라운드 = 실행 중, main `probeRunningPanes`).

import type { RunningPane } from '../../shared/types.js'

export type CloseCopy = {
  kind: 'agent' | 'command' | 'pinned' | 'worktree'
  title: string
  /** 본문 문단들(위에서부터). */
  body: string[]
  confirm: string
}

export function closeCopy(input:
  | { kind: 'worktree' }
  | { kind: 'tabs'; tabCount: number; running: readonly RunningPane[]; agentPaneIds: ReadonlySet<string>; pinnedCount: number }): CloseCopy {
  if (input.kind === 'worktree') {
    // worktree 닫기 모달 문구는 범위 밖 — 그대로 둔다(K5ⓐ).
    return { kind: 'worktree', title: '이 worktree 를 닫을까', body: ['포그라운드에 도는 프로세스가 있다. 닫으면 같이 종료된다.'], confirm: '닫기' }
  }
  const many = input.tabCount > 1
  const pinnedNote = input.pinnedCount === 0 ? [] : [many ? '고정된 탭이 섞여 있다.' : '이 탭은 고정돼 있다.']
  const agent = input.running.some((pane) => input.agentPaneIds.has(pane.paneId))
  if (agent) {
    return {
      kind: 'agent',
      title: '에이전트를 멈출까',
      body: [many ? '탭을 닫으면 에이전트의 현재 작업이 멈춘다.' : '이 탭을 닫으면 에이전트의 현재 작업이 멈춘다.', '닫은 터미널은 자동으로 재개되지 않는다.', ...pinnedNote],
      confirm: '에이전트 멈추기',
    }
  }
  if (input.running.length > 0) {
    return {
      kind: 'command',
      title: '실행 중인 명령을 멈출까',
      body: [many ? '탭을 닫으면 안에서 실행 중인 명령이 멈춘다.' : '이 탭을 닫으면 안에서 실행 중인 명령이 멈춘다.', ...pinnedNote],
      confirm: '멈추고 닫기',
    }
  }
  return { kind: 'pinned', title: '고정된 탭을 닫을까', body: ['이 탭은 고정돼 있다. 정말 닫을까?'], confirm: '닫기' }
}
