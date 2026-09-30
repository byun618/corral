// LIFE-456 — 저장소가 상태를 **잃지 않고 일관되게** 들고 있나 (기준 S1·S5·S15).
//
// c3 가 짚은 두 결함(H3 탭 지연 · H4 키 없는 이벤트의 리셋)에 회귀 테스트가 없었다.
// 여기서 그 둘을 못박는다 — 실행 원자료는 `raw/claude/` 쪽이고, 이 파일은 규칙이다.

import { describe, expect, it } from 'vitest'
import { RETAINED_LIMIT, WorkspaceStore } from './store.js'

const snapshot = (input: {
  panes: Array<{ id: string; tab: string; status?: string; cwd?: string }>
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
    ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }),
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

  it('보존 기록은 잃은 순간의 pane cwd 를 싣는다 — workspace 가 사라진 뒤 사이드바가 worktree 를 찾는 열쇠 (LIFE-467 R1)', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done', cwd: '/repo/sub' }] }))
    store.applyEvent({ event: 'pane_exited', data: { pane_id: 'w1:p1' } })
    expect(store.retainedRows().map((r) => [r.paneId, r.cwd])).toEqual([['w1:p1', '/repo/sub']])
  })

  it('**워크스페이스가 연쇄로 사라져도 남는다** — 탭이 하나뿐이면 같은 손짓이 이 길로 온다', () => {
    // 네이티브 실측: 탭이 하나뿐인 워크스페이스에서 `herdr tab close` 를 하면 herdr 는
    // `workspace_closed` 를 먼저 보내고 `tab_closed` 는 멱등 무시로 온다. 이벤트 종류로
    // 가르면 **같은 손짓이 탭 수에 따라 다르게 판정된다** — 그래서 종류가 아니라 억제 표로 가른다.
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(store.retainedRows().map((r) => r.paneId)).toEqual(['w1:p1'])
  })

  it('**탭이 하나뿐인 워크스페이스를 corral 이 닫으면 안 남는다** — 표를 pane 보다 먼저 걷지 않는다', () => {
    // 탭이 하나면 herdr 는 `workspace_closed` 로 온다. 억제 표는 탭 id 에 찍혀 있으므로
    // workspace 연쇄가 **탭 표를 pane 보존 판정보다 먼저 지우면** 완료 행이 되살아난다.
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }, { id: 'w1:p2', tab: 'w1:t1', status: 'done' }],
    }))
    store.suppressRetention('w1:t1') // corral 의 closeRowByTab 이 찍는 표
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(store.retainedRows()).toEqual([])
  })

  it('**사용자가 접은 워크스페이스는 안 남는다** — 치움은 억제 표로 가른다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }, { id: 'w1:p2', tab: 'w1:t2', status: 'done' }],
    }))
    store.suppressRetention('w1') // corral 의 closeWorktreeByWorkspace 가 찍는 표
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    // pane 이 둘이어도 둘 다 안 남는다 — 표가 먼저 소진되지 않는다.
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

// --- 수정 라운드 1 (F1·F4·F5·F6) — 각 지적의 **반례**. 수정 전 실패해야 한다. ----------

describe('F1 — blocked 사유는 진입 경로와 무관하게 한 번 물어본다', () => {
  it('부팅 snapshot 으로 처음 본 blocked pane 도 「사유를 물어야 할 것」에 오른다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }))
    expect(store.blockedNeedingReason().map((row) => row.paneId)).toEqual(['w1:p1'])
  })

  it('재동기로 들어온 blocked 도 오른다 — live push 진입만 보던 것이 결함이었다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'idle' }] }))
    store.reconcile(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }), Date.now() + 1000)
    expect(store.blockedNeedingReason().map((row) => row.paneId)).toEqual(['w1:p1'])
  })

  it('사유가 채워지면 목록에서 빠진다 — 매 주기 다시 묻지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }))
    const entry = store.blockedNeedingReason()[0]
    expect(entry).toBeDefined()
    store.applyBlockedRule({ paneId: 'w1:p1', entry: entry?.entry ?? 0, ruleId: 'bash_permission_prompt' })
    expect(store.blockedNeedingReason()).toEqual([])
  })

  it('blocked 를 떠났다 다시 들어오면 **새 진입**이라 다시 묻는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }))
    const first = store.blockedNeedingReason()[0]?.entry ?? 0
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } })
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'blocked' } })
    const second = store.blockedNeedingReason()[0]?.entry ?? 0
    expect(second).not.toBe(first)
  })
})

describe('F4 — 지난 진입의 늦은 explain 응답은 버린다', () => {
  it('진입 토큰이 다르면 사유를 안 쓴다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }))
    const stale = store.blockedNeedingReason()[0]?.entry ?? 0
    // 그 삽화가 끝나고 새 blocked 삽화가 시작된다.
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } })
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'blocked' } })
    // 옛 삽화의 응답이 이제야 도착한다 — 새 삽화의 사유를 덮으면 안 된다.
    const result = store.applyBlockedRule({ paneId: 'w1:p1', entry: stale, ruleId: 'trust_directory' })
    expect(result.changed).toBe(false)
    expect(paneOf(store, 'w1:p1')?.agentState.blockedReason).toBeNull()
  })

  it('같은 진입의 응답은 그대로 쓴다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'blocked' }] }))
    const entry = store.blockedNeedingReason()[0]?.entry ?? 0
    expect(store.applyBlockedRule({ paneId: 'w1:p1', entry, ruleId: 'bash_permission_prompt' }).changed).toBe(true)
    expect(paneOf(store, 'w1:p1')?.agentState.blockedReason).toBe('permission')
  })
})

describe('F5 — 재동기로 workspace 가 사라져도 보존하지 않는다', () => {
  it('빈 snapshot 으로 workspace 째 사라지면 보존 0 — 닫힘이 아니라 뒤늦은 앎이다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.reconcile({ workspaces: [], tabs: [], panes: [] }, Date.now() + 1000)
    // 양성 대조 — 정리 경로가 실제로 돌았다.
    expect(store.rows()).toEqual([])
    expect(store.retainedRows()).toEqual([])
  })

  it('대조군: 닫힘 이벤트로 workspace 가 사라지면 보존한다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.applyEvent({ event: 'workspace_closed', data: { workspace_id: 'w1' } })
    expect(store.retainedRows().map((row) => row.paneId)).toEqual(['w1:p1'])
  })
})

describe('F6 — 억제 표는 확정 거절·실패면 되돌린다', () => {
  it('닫기가 거절되면 표를 걷는다 — 뒤의 진짜 완료를 삼키지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.suppressRetention('w1:t1')
    store.releaseSuppression('w1:t1') // 거절·실패 → 되돌린다
    store.applyEvent({ event: 'tab_closed', data: { tab_id: 'w1:t1', workspace_id: 'w1' } })
    expect(store.retainedRows().map((row) => row.paneId)).toEqual(['w1:p1'])
  })

  it('결과 불명(timeout)이면 표를 **그대로 둔다** — 닫혔을 수도 있다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.suppressRetention('w1:t1')
    // timeout 은 확정 거절이 아니다 — 되돌리지 않는다.
    store.applyEvent({ event: 'tab_closed', data: { tab_id: 'w1:t1', workspace_id: 'w1' } })
    expect(store.retainedRows()).toEqual([])
  })
})

// R3-F1 이후 이 describe 가 재는 것은 **분류표**다 — 어떤 코드가 확정 거절인가.
// 「호출부가 sent 를 실제로 넘기는가」는 여기서 안 잰다: 그건 close-retention.test.ts 가
// 실제 CLI caller·실제 GUI wrapper 를 태워서 잰다. 여기 `sent: true` 는 "요청은 나갔다,
// 그 뒤 이 코드가 왔다" 는 뜻이다.
describe('R2-F3 — 닫기 결과를 확정 거절과 결과 불명으로 가른다 (실제 store)', () => {
  const closed = (store: WorkspaceStore) => {
    store.applyEvent({ event: 'pane_closed', data: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' } })
    return store.retainedRows().map((row) => row.paneId)
  }
  const prepared = (): WorkspaceStore => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.suppressRetention('w1:p1')
    return store
  }

  it('확정 거절이면 표를 걷는다 — 뒤의 진짜 완료를 삼키지 않는다', () => {
    const store = prepared()
    const settled = store.settleSuppression({ ids: ['w1:p1'], code: 'method_not_allowed', sent: true })
    expect(settled.effect).toBe('refused')
    expect(store.isSuppressed('w1:p1')).toBe(false)
    expect(closed(store)).toContain('w1:p1')
  })

  it('전송 전에 막힌 것(sent:false)도 확정 거절이다', () => {
    const store = prepared()
    expect(store.settleSuppression({ ids: ['w1:p1'], sent: false }).effect).toBe('refused')
    expect(store.isSuppressed('w1:p1')).toBe(false)
  })

  it('**타임아웃은 결과 불명이라 표를 남긴다** — CLI 가 여기서 반대로 판정했다 (R2-F3)', () => {
    const store = prepared()
    const settled = store.settleSuppression({ ids: ['w1:p1'], code: 'timeout', sent: true })
    expect(settled.effect).toBe('unknown')
    expect(settled.kept).toEqual(['w1:p1'])
    expect(store.isSuppressed('w1:p1')).toBe(true)
    expect(closed(store)).not.toContain('w1:p1')
  })

  for (const code of ['backend_timeout', 'closed', 'request_cancelled', 'outcome_unknown']) {
    it(`\`${code}\` 도 결과 불명이다 — 전송 뒤라 효과가 있었을 수 있다`, () => {
      const store = prepared()
      expect(store.settleSuppression({ ids: ['w1:p1'], code, sent: true }).effect).toBe('unknown')
      expect(store.isSuppressed('w1:p1')).toBe(true)
    })
  }

  // R3-F1 — herdr 가 **닫기 전에** 내는 거절들. 소스에서 효과 전 반환이 보이는 것만 넣었다.
  for (const code of ['confirmation_required', 'tab_close_failed', 'workspace_group_close_required', 'workspace_not_found']) {
    it(`\`${code}\` 는 전송 뒤에 와도 확정 거절이다 — herdr 가 손대기 전에 돌아간다`, () => {
      const store = prepared()
      expect(store.settleSuppression({ ids: ['w1:p1'], code, sent: true }).effect).toBe('refused')
      expect(store.isSuppressed('w1:p1')).toBe(false)
    })
  }

  it('**모르는 코드는 불명으로 떨어진다** — 새 코드가 조용히 「걷는다」로 가지 않게', () => {
    const store = prepared()
    expect(store.settleSuppression({ ids: ['w1:p1'], code: 'some_future_code', sent: true }).effect).toBe('unknown')
    expect(store.settleSuppression({ ids: ['w1:p1'], code: null, sent: true }).effect).toBe('unknown')
    expect(store.isSuppressed('w1:p1')).toBe(true)
  })
})

describe('R2-F9 — 워크스페이스는 **탭 값**을 접는다 (pane 을 모르는 탭도 센다)', () => {
  it('pane 을 모르는 탭이 blocked 면 워크스페이스도 blocked 다', () => {
    const store = new WorkspaceStore()
    // 탭 둘: t1 은 pane 을 아는 idle, t2 는 **pane 목록이 없는** blocked (herdr 값으로 물러선다).
    store.applySnapshot({
      workspaces: [{ workspace_id: 'w1', label: 'repo', number: 1, focused: true, agent_status: 'idle' }],
      tabs: [
        { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1, agent_status: 'idle' },
        { tab_id: 'w1:t2', workspace_id: 'w1', label: '2', number: 2, agent_status: 'blocked' },
      ],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'idle' }],
    })
    expect(tabOf(store, 'w1:t2')?.agentStatus).toBe('blocked')
    // 전에는 워크스페이스가 pane 만 모아 접어서 t2 가 **없는 셈**이 됐고 `idle` 이 나왔다.
    expect(store.rows()[0]?.agentStatus).toBe('blocked')
  })

  it('탭이 자기 pane 으로 접은 값도 그대로 워크스페이스에 올라간다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({
      panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'idle' }, { id: 'w1:p2', tab: 'w1:t2', status: 'done' }],
      workspaceStatus: 'idle',
    }))
    expect(store.rows()[0]?.agentStatus).toBe('done')
  })
})

describe('R2-F12 — 억제 표는 done 이 아니어도 걷힌다', () => {
  it('done 이 아닌 pane 이 사라져도 그 표는 남지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'working' }] }))
    store.suppressRetention('w1:p1')
    store.applyEvent({ event: 'pane_closed', data: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' } })
    // 전에는 `retain` 이 `done` 이 아니면 바로 돌아서서 표가 영영 남았다.
    expect(store.isSuppressed('w1:p1')).toBe(false)
  })

  it('done pane 이 표를 쓰고 사라져도 표는 남지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ panes: [{ id: 'w1:p1', tab: 'w1:t1', status: 'done' }] }))
    store.suppressRetention('w1:p1')
    store.applyEvent({ event: 'pane_closed', data: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' } })
    expect(store.isSuppressed('w1:p1')).toBe(false)
    expect(store.retainedRows()).toHaveLength(0)
  })
})
