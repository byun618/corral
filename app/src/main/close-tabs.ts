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
  /** 닫기 직전 재확인에서 대상이 아니게 됐다(LIFE-628 F2 — 그 사이 카드에 붙었다) — 닫지 않고 다음으로. `closed` 에 넣지 않는다. */
  | { outcome: 'skipped' }
  | { outcome: 'rejected'; rejection: { code: string; message: string } }
  | { outcome: 'error'; error: string }

/** 탭 하나를 판정하기 **전** 준비(LIFE-628 G3 — 권위 재독). `ready` 면 판정 → 닫기, `skipped` 면 다음 탭, `error` 면 멈춘다. */
export type ClosePrepareOutcome = { outcome: 'ready' } | { outcome: 'skipped' } | { outcome: 'error'; error: string }

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
  /**
   * 있으면 탭마다 닫기 직전 재판정 **앞에** 부른다 — 순서 = 준비 → 프로세스 판정 → 닫기. 준비(예: 귀속 재독)가 판정과 닫기 사이에
   * 끼지 않게 하려는 것이다(LIFE-628 G3). 준비 뒤 `panesOf` 를 다시 본다.
   */
  prepare?: (tabId: string) => Promise<ClosePrepareOutcome>
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
    if (input.prepare !== undefined) {
      const ready = await input.prepare(tabId)
      switch (ready.outcome) {
        case 'ready':
          break
        case 'skipped':
          continue
        case 'error':
          return { outcome: 'error', closed, error: ready.error }
      }
      if (input.panesOf(tabId) === null) continue
    }
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
      case 'skipped':
        continue
      case 'rejected':
        return { outcome: 'rejected', closed, rejection: outcome.rejection }
      case 'error':
        return { outcome: 'error', closed, error: outcome.error }
    }
  }
  return { outcome: 'closed', closed }
}

/** `pane.process_info` 판정 한 벌 — 어댑터 `probeForeground` 의 모양 중 게이트가 쓰는 칸. */
export type ForegroundRead = {
  ok: boolean
  shellPid: number | null
  foregroundGroupId: number | null
  foreground: ReadonlyArray<{ name: string; cmdline: string | null }>
  error: string | null
  /** herdr 가 `pane_not_found` 로 답했다 — 그 pane 에 런타임(PTY)이 없다(LIFE-628 F4: 재기동이 저장 cwd 없이 살린 pane). */
  missing: boolean
}

/**
 * 게이트의 pane 한 칸 판정 (LIFE-628 F4) — 실행 중이면 확인 창에 보일 프로세스 목록, 아니면 null.
 *   · 셸만(포그라운드 그룹 = 셸 pid) → null
 *   · `pane_not_found`(런타임 없음) → null — 프로세스가 없으니 멈출 것도 없다. 「프로세스 확인 실패」 로 묻지 않는다.
 *   · 그 밖의 판정 실패 → 실행 중으로 기운다(LIFE-346 — 모르면 묻는다)
 */
export function runningForeground(probe: ForegroundRead): string[] | null {
  if (!probe.ok) return probe.missing ? null : [`(프로세스 확인 실패: ${probe.error})`]
  if (probe.shellPid !== null && probe.foregroundGroupId === probe.shellPid) return null
  const foreground = probe.foreground.map((item) => item.cmdline ?? item.name)
  // 셸 아닌 포그라운드인데 목록이 비어 오면(probe 가 그룹만 안다) 무엇인지 몰라도 실행 중이다 — 빈 칸으로 두지 않는다.
  return foreground.length > 0 ? foreground : ['(알 수 없는 프로세스)']
}

