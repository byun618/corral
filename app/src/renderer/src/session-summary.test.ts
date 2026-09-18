// 접힘 요약의 **상태 클러스터** (기준 C7, 수정 라운드 5 P6).
//
// C7 이 이름 댄 반례 두 개가 여기 산다:
//   ⓐ 상태 4종이 다 있는 묶음에서 **바깥 `+N` 이 실제로 뜬다** (클러스터 상한이 무관측이면 안 된다)
//   ⓑ 같은 상태·같은 종류 5개에서 아이콘이 **1개**로 접힌다

import { describe, expect, it } from 'vitest'
import type { AgentStatus, PaneRow, TabRow } from '../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { collapsedSummary, MAX_CLUSTERS, MAX_ICONS_PER_CLUSTER, SUMMARY_STATUS_ORDER } from './session-summary.js'

let seq = 0

function tab(input: { status: AgentStatus; agent?: string | null }): TabRow {
  seq += 1
  const agent = 'agent' in input ? (input.agent ?? null) : 'claude'
  const pane: PaneRow = {
    paneId: `wA:p${seq}`,
    tabId: `wA:t${seq}`,
    workspaceId: 'wA',
    title: '',
    agent,
    agentStatus: input.status,
    cwd: null,
    focused: false,
    agentSession: null,
    digest: EMPTY_SESSION_DIGEST,
  }
  return {
    tabId: `wA:t${seq}`,
    workspaceId: 'wA',
    label: String(seq),
    number: seq,
    order: seq,
    agentStatus: input.status,
    focused: false,
    panes: [pane],
    digest: EMPTY_SESSION_DIGEST,
  }
}

describe('collapsedSummary — 상태 클러스터 (C7)', () => {
  it('상태로 묶고 `blocked → working → unknown → idle` 순으로 준다 (생성 순서가 아니다)', () => {
    const tabs = [tab({ status: 'idle' }), tab({ status: 'working' }), tab({ status: 'blocked' })]
    expect(collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) }).clusters.map((cluster) => cluster.status)).toEqual(['blocked', 'working', 'idle'])
  })

  it('순서표는 corral 의 네 상태 전부를 덮는다', () => {
    expect([...SUMMARY_STATUS_ORDER].sort()).toEqual(['blocked', 'idle', 'unknown', 'working'])
  })

  it('같은 상태의 세션은 한 클러스터로 뭉친다', () => {
    const tabs = [tab({ status: 'working' }), tab({ status: 'working' }), tab({ status: 'idle' })]
    const summary = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) })
    expect(summary.clusters.map((cluster) => [cluster.status, cluster.count])).toEqual([
      ['working', 2],
      ['idle', 1],
    ])
  })

  // 반례 ⓑ — 같은 상태·같은 종류 5개. 아이콘이 5개로 늘어나면 깨진다.
  it('반례 ⓑ: 같은 상태·같은 종류 5개 → 아이콘 1개 + `+4`', () => {
    const tabs = Array.from({ length: 5 }, () => tab({ status: 'working', agent: 'claude' }))
    const [cluster] = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['claude'])
    expect(cluster?.hiddenIcons).toBe(4)
    expect(cluster?.count).toBe(5)
  })

  it('종류가 여럿이면 **빈도순**으로 대표를 뽑는다 (동률이면 먼저 나온 것)', () => {
    const tabs = [
      tab({ status: 'working', agent: 'codex' }),
      tab({ status: 'working', agent: 'claude' }),
      tab({ status: 'working', agent: 'claude' }),
    ]
    const [cluster] = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['claude', 'codex'])
    expect(cluster?.hiddenIcons).toBe(1)
  })

  it('아이콘은 클러스터당 최대 3 — 종류가 4개여도 3개까지다', () => {
    const tabs = [
      tab({ status: 'idle', agent: 'claude' }),
      tab({ status: 'idle', agent: 'codex' }),
      tab({ status: 'idle', agent: 'grok' }),
      tab({ status: 'idle', agent: 'shell' }),
    ]
    const [cluster] = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) }).clusters
    expect(cluster?.icons).toHaveLength(MAX_ICONS_PER_CLUSTER)
    expect(cluster?.hiddenIcons).toBe(1)
  })

  it('모르는 종류는 아이콘을 지어내지 않는다 — 숨은 수로 간다 (H-6)', () => {
    const tabs = [tab({ status: 'working', agent: 'droid' }), tab({ status: 'working', agent: 'claude' })]
    const [cluster] = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['claude'])
    expect(cluster?.hiddenIcons).toBe(1)
  })

  // 반례 ⓐ — 상태 4종이 다 있으면 클러스터가 3으로 잘리고 **바깥 `+N` 이 뜬다**.
  it('반례 ⓐ: 상태 4종 → 클러스터 3 + 바깥 `+N` (잘린 클러스터의 세션 합)', () => {
    const tabs = [
      tab({ status: 'blocked' }),
      tab({ status: 'working' }),
      tab({ status: 'unknown' }),
      tab({ status: 'idle' }),
      tab({ status: 'idle' }),
    ]
    const summary = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) })
    expect(summary.clusters.map((cluster) => cluster.status)).toEqual(['blocked', 'working', 'unknown'])
    expect(summary.clusters).toHaveLength(MAX_CLUSTERS)
    expect(summary.hiddenSessions).toBe(2) // 잘려나간 idle 클러스터의 **세션 수**
    expect(summary.total).toBe(5)
  })

  it('`+N` 두 층은 서로 다른 수다 — 총수도 아니다', () => {
    const tabs = [
      tab({ status: 'blocked', agent: 'claude' }),
      tab({ status: 'blocked', agent: 'claude' }),
      tab({ status: 'working' }),
      tab({ status: 'unknown' }),
      tab({ status: 'idle' }),
      tab({ status: 'idle' }),
      tab({ status: 'idle' }),
    ]
    const summary = collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) })
    expect(summary.clusters[0]?.hiddenIcons).toBe(1) // 클러스터 안에서 아이콘이 안 붙은 수
    expect(summary.hiddenSessions).toBe(3) // 잘려나간 클러스터의 세션 합
    expect(summary.total).toBe(7)
  })

  it('클러스터가 3 이하면 바깥 `+N` 은 0이다 — 없는 수를 그리지 않는다', () => {
    const tabs = [tab({ status: 'working' }), tab({ status: 'idle' })]
    expect(collapsedSummary({ panes: tabs.flatMap((tab) => tab.panes) }).hiddenSessions).toBe(0)
  })

  it('빈 목록이면 클러스터도 비어 있다', () => {
    expect(collapsedSummary({ panes: [] })).toEqual({ clusters: [], hiddenSessions: 0, total: 0 })
  })
})

// Same tab identity must not collapse independently running panes into one session.
it('two panes in one tab retain separate state clusters and count', () => {
  const first = tab({ status: 'working', agent: 'claude' }).panes[0]!
  const second = { ...tab({ status: 'blocked', agent: 'codex' }).panes[0]!, tabId: first.tabId }
  const summary = collapsedSummary({ panes: [first, second] })
  expect(summary.total).toBe(2)
  expect(summary.clusters.map(({ status, count, icons }) => [status, count, icons[0]?.kind]))
    .toEqual([['blocked', 1, 'codex'], ['working', 1, 'claude']])
})
