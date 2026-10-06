// 탭 여럿 닫기의 게이트 (LIFE-495 K2ⓒ·K3ⓒ, fix1 R1-05) — herdr·프로세스 판정은 주입받는다(테스트가 경계만 바꾼다).
//
// 220 의 bulk 닫기는 실행 중 확인 없이 죽인다(`skipRunningProcessConfirm`, 00-analysis F4). corral 은 모든 탭 닫기가 게이트를 지난다:
//   ① 확인 전(`confirmed:false`): 대상 탭의 pane 을 다 판정해 실행 중이 있거나 `alwaysConfirm`(핀)이면 **한 번** 묻는다 — 하나도 닫지 않는다.
//   ② 닫기는 앞에서부터 하나씩, **탭마다 닫기 직전에 그 탭을 다시 판정**한다. 사용자가 확인한 실행 중 pane(`confirmedPaneIds`) 밖의
//      실행 중 pane 이 나오면 거기서 멈추고, 남은 탭(그 탭 포함)을 다시 판정해 `needs-confirm` 으로 돌려준다 — 이미 닫은 탭은 `closed` 로.
//      (fix1 R1-05: 처음 판정 뒤 순차 닫기 동안 시작된 명령이 확인 없이 닫혔다.)
//   ③ herdr 거절·실패에서 멈추고 그때까지 닫은 탭을 돌려준다.
// **남는 위험**: 마지막 판정과 `tab.close` 사이의 짧은 창은 원자적이지 않다 — 단건 게이트(`closeRowByTab`)와 같은 크기다. herdr 가
// 판정과 닫기를 묶어 주지 않는 한 여기서 없앨 수 없다(RESULT 에 적는다). 「확인한 실행 중」은 pane 단위다 — 같은 pane 에서 다른 명령으로
// 바뀐 것은 새로 묻지 않는다.
//
// **실행 중 확인 끄기**(LIFE-516 K4ⓑ — 설정 `skipCloseTerminalWithRunningProcessConfirm`): `confirmRunning:false` 면 ①의 실행 중 사유와
// ②의 재판정을 둘 다 건너뛴다 — 확인 뒤 재판정이 다시 needs-confirm 을 돌려주면 「다시 묻지 않음」 이 성립하지 않는다(00-analysis A6).
// 핀 사유(`alwaysConfirm`)는 그대로 남는다(D2 — 두 설정은 독립). 이때 돌려주는 `running` 은 비어 창이 핀 문구만 보인다.
// 값은 main 이 닫기마다 저장소에서 읽는다(index.ts) — 저장소가 없거나 못 읽으면 기본값(묻는다)이다.

import type { CloseTabsResult, RunningPane } from '../shared/types.js'

export type CloseTabOutcome =
  | { outcome: 'closed' }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

export async function closeTabsGated(input: {
  tabIds: readonly string[]
  confirmed: boolean
  alwaysConfirm: boolean
  /** 실행 중 pane 이 있으면 묻는가(설정 — 기본 true). false 면 판정·재판정 없이 닫는다(핀 사유는 남는다). */
  confirmRunning: boolean
  /** 사용자가 확인 창에서 본 실행 중 pane — 확인 뒤에는 이 밖의 실행 중만 다시 묻는다. */
  confirmedPaneIds: readonly string[]
  /** 그 탭의 지금 pane 들. 탭이 없으면 null(건너뛴다). */
  panesOf: (tabId: string) => readonly string[] | null
  probe: (panes: readonly { tabId: string; paneId: string }[]) => Promise<RunningPane[]>
  close: (tabId: string) => Promise<CloseTabOutcome>
}): Promise<CloseTabsResult> {
  const panesOfTabs = (tabIds: readonly string[]): { tabId: string; paneId: string }[] =>
    tabIds.flatMap((tabId) => (input.panesOf(tabId) ?? []).map((paneId) => ({ tabId, paneId })))
  const targets = input.tabIds.filter((tabId) => input.panesOf(tabId) !== null)
  if (!input.confirmed) {
    const running = input.confirmRunning ? await input.probe(panesOfTabs(targets)) : []
    if (running.length > 0 || input.alwaysConfirm) return { outcome: 'needs-confirm', closed: [], running }
  }
  const confirmed = new Set(input.confirmedPaneIds)
  const closed: string[] = []
  for (const [index, tabId] of targets.entries()) {
    if (input.panesOf(tabId) === null) continue
    const now = input.confirmRunning ? await input.probe(panesOfTabs([tabId])) : []
    if (now.some((pane) => !confirmed.has(pane.paneId))) {
      const remaining = targets.slice(index).filter((id) => input.panesOf(id) !== null)
      return { outcome: 'needs-confirm', closed, running: await input.probe(panesOfTabs(remaining)) }
    }
    const outcome = await input.close(tabId)
    switch (outcome.outcome) {
      case 'closed':
        closed.push(tabId)
        continue
      case 'rejected':
        return { outcome: 'rejected', closed, rejection: outcome.rejection }
      case 'error':
        return { outcome: 'error', closed, error: outcome.error }
    }
  }
  return { outcome: 'closed', closed }
}
