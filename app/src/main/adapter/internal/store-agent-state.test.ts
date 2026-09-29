// LIFE-456 — 저장소가 상태를 **잃지 않고 일관되게** 들고 있나 (기준 S1·S5·S15).
//
// c3 가 짚은 두 결함(H3 탭 지연 · H4 키 없는 이벤트의 리셋)에 회귀 테스트가 없었다.
// 여기서 그 둘을 못박는다 — 실행 원자료는 `raw/claude/` 쪽이고, 이 파일은 규칙이다.

import { describe, expect, it } from 'vitest'
import { RETAINED_LIMIT, WorkspaceStore } from './store.js'

const snapshot = (input: {
  panes: Array<{ id: string; tab: string; status?: string }>
  tabStatus?: string
  workspaceStatus?: string
}): unknown => ({
  workspaces: [{ workspace_id: 'w1', label: 'repo', number: 1, focused: true, agent_status: input.workspaceStatus ?? 'unknown' }],
  tabs: [...new Set(input.panes.map((pane) => pane.tab))].map((tabId, index) => ({
    tab_id: tabId, workspace_id: 'w1', label: tabId, number: index + 1, agent_status: input.tabStatus ?? 'unknown',
  })),
  panes: input.panes.map((pane) => ({
    pane_id: pane.id, tab_id: pane.tab, workspace_id: 'w1',
    ...(pane.status === undefined ? {} : { agent_status: pane.status }),
  })),
})

const paneOf = (store: WorkspaceStore, paneId: string) =>
  store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.paneId === paneId)
const tabOf = (store: WorkspaceStore, tabId: string) =>
  store.rows().flatMap((w) => w.tabs).find((t) => t.tabId === tabId)

describe('done 을 잃지 않는다 (S1)', () => {
  it('스냅샷의 done 이 그대로 pane 에 실린다 — unknown 으로 접히지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    expect(paneOf(store, 'w1:p1')?.agentStatus).toBe('done')
  })

  it('전이 이벤트의 done 도 그대로 실린다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }] }))
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } })
    expect(paneOf(store, 'w1:p1')?.agentStatus).toBe('done')
  })
})

describe('H3 — 탭·워크스페이스가 pane 전이를 30초 기다리지 않는다 (S5ⓐ)', () => {
  it('pane 이 blocked 가 되면 같은 순간 탭도 blocked 다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'idle' }], tabStatus: 'idle' }))
    expect(tabOf(store, 'w1:t1')?.agentStatus).toBe('idle')

    // herdr 은 탭 봉투를 안 보냈다 — 전에는 재동기(30초)까지 탭이 idle 로 남았다.
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'blocked' } })
    expect(paneOf(store, 'w1:p1')?.agentStatus).toBe('blocked')
    expect(tabOf(store, 'w1:t1')?.agentStatus).toBe('blocked')
    expect(store.rows()[0]?.agentStatus).toBe('blocked')
  })

  it('탭 값은 그 탭 pane 들의 롤업이다 — 형제 pane 중 가장 급한 것이 이긴다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'idle' }, { id: 'w1:p2', tab: 'w1:t1', status: 'done' }],
    }))
    expect(tabOf(store, 'w1:t1')?.agentStatus).toBe('done')
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } })
    expect(tabOf(store, 'w1:t1')?.agentStatus).toBe('working')
  })

  it('herdr 이 준 탭 값과 pane 집합이 어긋나면 **pane 집합이 이긴다**', () => {
    const store = new WorkspaceStore()
    // herdr 은 탭을 idle 이라 하는데 그 탭의 pane 은 blocked 다 (재동기 사이의 낡은 롤업).
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }], tabStatus: 'idle' }))
    expect(tabOf(store, 'w1:t1')?.agentStatus).toBe('blocked')
  })
})

describe('H4 — 키 없는 이벤트가 값을 unknown 으로 지우지 않는다 (S5ⓑ)', () => {
  it('`agent_status` 없는 tab_created 가 알던 탭 값을 안 지운다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }], tabStatus: 'blocked' }))
    // 키가 아예 없는 봉투 — herdr 이 그 필드를 말하지 않은 것이다.
    store.applyEvent({ event: 'tab_created', data: { tab_id: 'w1:t2', workspace_id: 'w1', label: '2', number: 2 } })
    expect(tabOf(store, 'w1:t2')?.agentStatus).toBe('unknown') // 아는 pane 이 없으니 unknown 이 맞다
    expect(tabOf(store, 'w1:t1')?.agentStatus).toBe('blocked') // 알던 탭은 그대로다
  })

  it('`agent_status` 없는 workspace 봉투가 워크스페이스 값을 안 지운다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }], workspaceStatus: 'working' }))
    store.applyEvent({ event: 'workspace_updated', data: { workspace_id: 'w1', label: 'repo', number: 1 } })
    // pane 롤업이 진실이라 working 이 남는다 — 키 없는 봉투가 unknown 으로 밀지 못한다.
    expect(store.rows()[0]?.agentStatus).toBe('working')
  })
})

describe('retained — 닫힌 pane 의 마지막 기록 (S15ⓓ)', () => {
  const closed = (store: WorkspaceStore, paneId: string) =>
    store.applyEvent({ event: 'pane_closed', data: { pane_id: paneId } })

  it('마지막 상태가 done 이면 남는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    closed(store, 'w1:p1')
    expect(store.retainedRows().map((r) => r.paneId)).toEqual(['w1:p1'])
    expect(store.retainedRows()[0]?.agentStatus).toBe('done')
  })

  it('done 이 아니면 안 남는다 — 완료만 남길 값이 있다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }, { id: 'w1:p2', tab: 'w1:t2', status: 'idle' }],
    }))
    closed(store, 'w1:p1')
    closed(store, 'w1:p2')
    expect(store.retainedRows()).toEqual([])
  })

  it('**명시적으로 닫으면 안 남는다** — 닫기가 안 먹은 것처럼 보이면 안 된다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.suppressRetention('w1:p1')
    closed(store, 'w1:p1')
    expect(store.retainedRows()).toEqual([])
  })

  it('탭을 명시적으로 닫으면 그 탭의 pane 도 안 남는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.suppressRetention('w1:t1')
    closed(store, 'w1:p1')
    expect(store.retainedRows()).toEqual([])
  })

  it('최신 우선이고 상한(20)에서 잘린다', () => {
    const store = new WorkspaceStore()
    const panes = Array.from({ length: RETAINED_LIMIT + 5 }, (_, i) => ({ id: `w1:p${i}`, tab: `w1:t${i}`, status: 'done' }))
    store.applySnapshot(snapshot({ panes }))
    for (const pane of panes) closed(store, pane.id)
    expect(store.retainedRows()).toHaveLength(RETAINED_LIMIT)
    // 마지막에 닫은 것이 맨 앞이다.
    expect(store.retainedRows()[0]?.paneId).toBe(`w1:p${panes.length - 1}`)
  })

  it('**마지막 pane 이 exit 해 탭·workspace 까지 사라져도 남는다** — 그게 흔한 완료 경로다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    // 사용자가 셸에 exit 를 친 경로: pane_exited 한 건만 오고 탭·workspace 가 연쇄로 사라진다.
    store.applyEvent({ event: 'pane_exited', data: { pane_id: 'w1:p1' } })
    expect(store.rows()).toEqual([])
    expect(store.retainedRows().map((r) => r.paneId)).toEqual(['w1:p1'])
  })

  it('workspace 를 통째로 닫으면 보존하지 않는다 — 완료가 아니라 치움이다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(store.retainedRows()).toEqual([])
  })

  it('**탭이 닫혀 사라진 done pane 도 남는다** — herdr 는 `tab_closed` 한 건만 준다', () => {
    // 네이티브 관문에서 잡은 결함: `herdr tab close w1H:t3` 로 grok(done) 탭을 닫았는데
    // 보존 행이 0 이었다. 보존이 `pane_closed` 갈래에만 붙어 있었기 때문이다.
    // 에이전트 pane 은 탭 하나에 하나씩 살아서 **이 길이 완료가 사라지는 흔한 길**이다.
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }, { id: 'w1:p2', tab: 'w1:t2', status: 'idle' }],
    }))
    store.applyEvent({ event: 'tab_closed', data: { tab_id: 'w1:t1', workspace_id: 'w1' } })
    expect(store.retainedRows().map((r) => r.paneId)).toEqual(['w1:p1'])
  })

  it('**재동기 정리로 없어진 것은 안 남긴다** — 닫힘을 못 본 채 사진으로만 아는 자리다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    // **`applySnapshot` 이 아니라 `reconcile` 로 잰다.** 부트스트랩 스냅샷은 `reset()` 을
    // 부르므로 보존을 통째로 비운다 — 그걸로 재면 "정리가 안 남겼다" 와 "리셋이 지웠다" 가
    // 같은 모양이 되어 테스트가 엉뚱한 이유로 통과한다(처음에 그렇게 썼다).
    store.reconcile(snapshot({ panes: [] }), Date.now() + 1000)
    // 양성 대조 — 정리 경로가 **실제로 돌았다**(행이 없어졌다).
    expect(store.rows().flatMap((w) => w.tabs.flatMap((t) => t.panes))).toEqual([])
    expect(store.retainedRows()).toEqual([])
  })

  it('**30초 재동기가 보존 기록을 지우지 않는다** — 지우면 S15ⓓ 는 30초짜리다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }, { id: 'w1:p2', tab: 'w1:t2', status: 'idle' }],
    }))
    store.applyEvent({ event: 'tab_closed', data: { tab_id: 'w1:t1', workspace_id: 'w1' } })
    expect(store.retainedRows().map((r) => r.paneId)).toEqual(['w1:p1'])
    // 재동기가 남은 pane 만 실어 온다 — 보존 행은 산 목록이 아니라 별도 장부다.
    store.reconcile(snapshot({ panes: [{ id: 'w1:p2', tab: 'w1:t2', status: 'idle' }] }), Date.now() + 1000)
    expect(store.retainedRows().map((r) => r.paneId)).toEqual(['w1:p1'])
  })

  it('**한 탭에 done pane 이 둘이면 둘 다 안 남는다** — 억제 표가 먼저 소진되면 안 된다', () => {
    // 표를 pane 마다 지우면 첫 pane 이 탭 표를 먹어 치우고 둘째가 살아 남는다 —
    // 갈라진 탭(사용자 세션에 실제로 있다: w1F:t2, pane 2개)을 닫으면 완료 행 하나가
    // 되살아난다. 「닫기가 안 먹은 것처럼 보이면 안 된다」가 그 자리에서 깨진다.
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }, { id: 'w1:p2', tab: 'w1:t1', status: 'done' }],
    }))
    store.suppressRetention('w1:t1')
    store.applyEvent({ event: 'tab_closed', data: { tab_id: 'w1:t1', workspace_id: 'w1' } })
    expect(store.retainedRows()).toEqual([])
  })

  it('보존 기록은 완료 시각·이력을 함께 들고 간다 (S15ⓐⓑⓒ)', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }] }))
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } })
    closed(store, 'w1:p1')
    const row = store.retainedRows()[0]
    expect(typeof row?.agentState.enteredDoneAt).toBe('number')
    expect(row?.agentState.history.map((h) => h.status)).toEqual(['working'])
  })
})

describe('전이 기록 (S1 관측 시각 · S15)', () => {
  it('전이 이벤트는 observedVia=event, 스냅샷은 snapshot 이다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }] }))
    expect(paneOf(store, 'w1:p1')?.agentState.observedVia).toBe('snapshot')
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } })
    expect(paneOf(store, 'w1:p1')?.agentState.observedVia).toBe('event')
  })

  it('done 진입이 완료 시각으로 남고 이력이 쌓인다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }] }))
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'done' } })
    const afterDone = paneOf(store, 'w1:p1')?.agentState
    expect(afterDone?.enteredDoneAt).not.toBeNull()
    expect(afterDone?.history.map((h) => h.status)).toEqual(['working'])

    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'idle' } })
    const afterSeen = paneOf(store, 'w1:p1')?.agentState
    expect(afterSeen?.enteredDoneAt).toBe(afterDone?.enteredDoneAt)
    expect(afterSeen?.history.map((h) => h.status)).toEqual(['done', 'working'])
  })

  it('사유는 herdr 이 안 주면 null 이다 (S3 공백)', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }))
    expect(paneOf(store, 'w1:p1')?.agentState.blockedReason).toBeNull()
  })
})
