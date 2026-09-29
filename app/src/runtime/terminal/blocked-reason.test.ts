// LIFE-456 R2-F2 — **같은 pane 에 두 사유가 나오지 않는다.** 이번엔 대역이 아니라 실제 store 로.
//
// 라운드 1 의 이 파일은 GUI 쪽을 `blockedReason({labels, ruleId: pickBlockedRule(x).ruleId})` 로
// **손으로 다시 조립해서** 쟀다. 그건 CLI 쪽 조립과 글자까지 같은 식이라 **무슨 짓을 해도
// 두 값이 갈릴 수 없었다** — 고쳤다고 적은 속성을 재지 못하는 테스트였다(리뷰 R2 claude C3).
//
// 진짜 갈림은 함수가 아니라 **무엇을 먹였나**에 있었다:
//   · GUI `putPane`          → labels 만
//   · GUI `agent_status_changed` → 아무것도
//   · GUI `explainBlocked`   → ruleId 만
//   · CLI `terminal show`    → labels + ruleId **둘 다**
// 그래서 여기서는 **진짜 `WorkspaceStore` 를 굴려** 그 결과와 CLI 조립을 비교한다.
// 공개 CLI 전 구간(guard 포함)은 단위 테스트가 아니라 `app/scripts/l456/cli-blocked-reason.mjs`
// 와 네이티브 대조 원자료가 맡는다 (R2-F1).

import { describe, expect, it } from 'vitest'
import { pickBlockedRule } from '../../shared/agent-state.js'
import { WorkspaceStore } from '../../main/adapter/internal/store.js'
import { blockedReasonOf } from './index.js'

/** herdr 스냅샷 한 장 — pane 하나가 blocked 이고 labels 가 실려 있다. */
const snapshot = (labels: Record<string, string> | null): unknown => ({
  workspaces: [{ workspace_id: 'w1', label: 'repo', number: 1, focused: true }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 }],
  panes: [{
    pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'blocked',
    ...(labels === null ? {} : { state_labels: labels }),
  }],
})

/** **진짜 GUI 경로**: 스냅샷 → (explain 응답이 있으면) 훑기가 집는 삽화에 규칙 적용 → 렌더러 행. */
const guiReason = (explain: Record<string, unknown> | null, labels: Record<string, string> | null): string | null => {
  const store = new WorkspaceStore()
  store.applySnapshot(snapshot(labels))
  if (explain !== null) {
    const pending = store.blockedNeedingReason()
    // 훑기가 이 pane 을 집지 않으면 explain 은 애초에 안 돈다 — 그 자체가 결함이었다.
    expect(pending.map((row) => row.paneId)).toContain('w1:p1')
    const entry = pending.find((row) => row.paneId === 'w1:p1')?.entry ?? 0
    store.applyBlockedRule({ paneId: 'w1:p1', entry, ruleId: pickBlockedRule(explain).ruleId })
  }
  const pane = store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.paneId === 'w1:p1')
  return pane?.agentState.blockedReason ?? null
}

/** **CLI 조립 그대로**: `terminal show` 가 `index.ts` 에서 만드는 인자 두 개. */
const cliReason = (explain: Record<string, unknown> | null, labels: Record<string, string> | null): string =>
  blockedReasonOf({ labels: labels ?? {}, ruleId: pickBlockedRule(explain).ruleId })

const explainOf = (matched: string, rules: Array<[string, number, number]>): Record<string, unknown> => ({
  matched_rule: { id: matched, state: 'blocked' },
  evaluated_rules: rules.map(([id, priority, conditions]) => ({
    id, priority, matched: true, state: 'blocked',
    evidence: { contains: Array.from({ length: conditions }, (_, i) => `c${String(i)}`) },
  })),
})

describe('R2-F2 — GUI(실제 store)와 CLI 가 같은 사유를 말한다', () => {
  const cases: Array<{ name: string; explain: Record<string, unknown> | null; labels: Record<string, string> | null; expect: string }> = [
    {
      name: '규칙 id 만 있다 (실측상 claude·codex·grok 이 늘 이 갈래다)',
      explain: explainOf('bash_permission_prompt', [['bash_permission_prompt', 850, 7]]),
      labels: null,
      expect: 'permission',
    },
    {
      name: '거친 승자를 지나 구체적 규칙을 집는다 (grok 권한 화면 모양)',
      explain: explainOf('osc_title_blocked', [
        ['osc_title_blocked', 1300, 1], ['option_dialog_blocked', 1200, 1], ['permission_scope_selector', 1180, 4],
      ]),
      labels: null,
      expect: 'permission',
    },
    {
      name: '갈래 없는 규칙 — 양쪽 다 unknown',
      explain: explainOf('live_blocked_form', [['live_blocked_form', 980, 3]]),
      labels: null,
      expect: 'unknown',
    },
    {
      name: 'herdr 가 labels 만 준다면 (지금 세 provider 는 안 주지만, 오면 양쪽이 같이 읽어야 한다)',
      explain: null,
      labels: { a: 'Do you trust this directory?' },
      expect: 'trust',
    },
  ]
  for (const item of cases) {
    it(item.name, () => {
      expect(guiReason(item.explain, item.labels)).toBe(item.expect)
      expect(cliReason(item.explain, item.labels)).toBe(item.expect)
    })
  }

  it('**labels 가 채운 사유도 explain 으로 교정된다** — 이것이 R2-F2 의 반례다', () => {
    // labels 는 `trust` 라고 말하는데 화면은 권한 상자다(규칙이 그렇게 말한다).
    // 라운드 1 코드에서는 `putPane` 이 labels 로 사유를 채운 순간 그 pane 이
    // `blockedNeedingReason` 에서 빠져 **explain 이 아예 안 돌았고**, 사유는 `trust` 로 굳었다.
    const labels = { a: 'Do you trust this directory?' }
    const explain = explainOf('bash_permission_prompt', [['bash_permission_prompt', 850, 7]])

    // 훑기가 이 pane 을 집어야 한다 — 사유가 이미 차 있어도.
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot(labels))
    const pane0 = store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes)[0]
    expect(pane0?.agentState.blockedReason).toBe('trust')            // labels 가 먼저 채운다
    expect(store.blockedNeedingReason().map((r) => r.paneId)).toContain('w1:p1')  // 그래도 물어본다

    expect(guiReason(explain, labels)).toBe('permission')            // explain 이 이긴다
    expect(cliReason(explain, labels)).toBe('permission')            // CLI 도 같다
  })

  it('한 번 답을 받으면 같은 삽화를 다시 묻지 않는다 (F1 — 폴링 금지)', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot(null))
    const entry = store.blockedNeedingReason()[0]?.entry ?? 0
    // 갈래가 없는 규칙이라 사유는 `unknown` 이고 값도 안 바뀐다 — 그래도 「답은 받았다」다.
    store.applyBlockedRule({ paneId: 'w1:p1', entry, ruleId: 'osc_title_blocked' })
    expect(store.blockedNeedingReason()).toHaveLength(0)
  })

  it('blocked 를 떠났다 돌아오면 **새 삽화**라 다시 묻고, 옛 입력을 안 들고 간다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot({ a: 'Do you trust this directory?' }))
    const first = store.blockedNeedingReason()[0]?.entry ?? 0
    store.applyBlockedRule({ paneId: 'w1:p1', entry: first, ruleId: 'bash_permission_prompt' })
    expect(store.blockedNeedingReason()).toHaveLength(0)

    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'working' } })
    store.applyEvent({ event: 'pane_agent_status_changed', data: { pane_id: 'w1:p1', agent_status: 'blocked' } })

    const pane = store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes)[0]
    expect(pane?.agentState.blockedReason).toBeNull()   // 옛 labels·ruleId 를 안 들고 간다
    const pending = store.blockedNeedingReason()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.entry).not.toBe(first)
  })
})
