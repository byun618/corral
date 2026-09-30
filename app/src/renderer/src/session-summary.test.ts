// 알약의 **상태 무리** (기준 C7 → LIFE-467 K2: 점 상태로 묶는다).
//
// C7 이 이름 댄 반례 두 개가 여기 산다:
//   ⓐ 상태 4종이 다 있는 묶음에서 **바깥 `+N` 이 실제로 뜬다** (무리 상한이 무관측이면 안 된다)
//   ⓑ 같은 상태·같은 종류 5개에서 아이콘이 **1개**로 접힌다

import { describe, expect, it } from 'vitest'
import type { AgentKind } from '../../shared/types.js'
import type { AgentDot } from './agent-dot.js'
import { collapsedSummary, MAX_CLUSTERS, MAX_ICONS_PER_CLUSTER, SUMMARY_STATUS_ORDER, type SummaryItem } from './session-summary.js'

function row(dot: AgentDot, kind: AgentKind | null = 'claude'): SummaryItem {
  return { dot, kind }
}

describe('collapsedSummary — 상태 무리 (C7 · K2)', () => {
  it('점 상태로 묶고 Orca `SUMMARY_STATE_ORDER` 순으로 준다 (생성 순서가 아니다)', () => {
    const rows = [row('idle'), row('working'), row('blocked'), row('waiting')]
    expect(collapsedSummary({ rows }).clusters.map((cluster) => cluster.dot)).toEqual(['waiting', 'blocked', 'working'])
  })

  it('순서표는 Orca 순서 그대로다 — waiting→blocked→working→monitoring→interrupted→(failed)→done→unverifiable→idle', () => {
    expect(SUMMARY_STATUS_ORDER).toEqual(['waiting', 'blocked', 'working', 'monitoring', 'interrupted', 'failed', 'done', 'unverifiable', 'idle'])
  })

  it('done 은 working·monitoring·interrupted 아래, unverifiable·idle 위로 묶인다', () => {
    const rows = [row('idle'), row('done'), row('unverifiable'), row('monitoring')]
    expect(collapsedSummary({ rows }).clusters.map((c) => c.dot)).toEqual(['monitoring', 'done', 'unverifiable'])
  })

  it('같은 상태의 행은 한 무리로 뭉친다', () => {
    const summary = collapsedSummary({ rows: [row('working'), row('working'), row('idle')] })
    expect(summary.clusters.map((cluster) => [cluster.dot, cluster.count])).toEqual([
      ['working', 2],
      ['idle', 1],
    ])
  })

  it('반례 ⓑ: 같은 상태·같은 종류 5개 → 아이콘 1개 + `+4`', () => {
    const [cluster] = collapsedSummary({ rows: Array.from({ length: 5 }, () => row('working', 'claude')) }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['claude'])
    expect(cluster?.hiddenIcons).toBe(4)
    expect(cluster?.count).toBe(5)
  })

  it('종류가 여럿이면 **빈도순**으로 대표를 뽑는다 (동률이면 먼저 나온 것)', () => {
    const [cluster] = collapsedSummary({ rows: [row('working', 'codex'), row('working', 'claude'), row('working', 'claude')] }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['claude', 'codex'])
    expect(cluster?.hiddenIcons).toBe(1)
  })

  it('동률이면 먼저 나온 종류가 앞이다', () => {
    const [cluster] = collapsedSummary({ rows: [row('idle', 'grok'), row('idle', 'codex')] }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['grok', 'codex'])
  })

  it('아이콘은 무리당 최대 3 — 종류가 4개여도 3개까지다', () => {
    const [cluster] = collapsedSummary({ rows: [row('idle', 'claude'), row('idle', 'codex'), row('idle', 'grok'), row('idle', 'shell')] }).clusters
    expect(cluster?.icons).toHaveLength(MAX_ICONS_PER_CLUSTER)
    expect(cluster?.hiddenIcons).toBe(1)
  })

  it('모르는 종류는 아이콘을 지어내지 않는다 — 숨은 수로 간다 (H-6)', () => {
    const [cluster] = collapsedSummary({ rows: [row('working', null), row('working', 'claude')] }).clusters
    expect(cluster?.icons.map((icon) => icon.kind)).toEqual(['claude'])
    expect(cluster?.hiddenIcons).toBe(1)
  })

  it('반례 ⓐ: 상태 4종 → 무리 3 + 바깥 `+N` (잘린 무리의 행 합)', () => {
    const summary = collapsedSummary({ rows: [row('blocked'), row('working'), row('unverifiable'), row('idle'), row('idle')] })
    expect(summary.clusters.map((cluster) => cluster.dot)).toEqual(['blocked', 'working', 'unverifiable'])
    expect(summary.clusters).toHaveLength(MAX_CLUSTERS)
    expect(summary.hiddenSessions).toBe(2)
    expect(summary.total).toBe(5)
  })

  it('`+N` 두 층은 서로 다른 수다 — 총수도 아니다', () => {
    const summary = collapsedSummary({
      rows: [row('blocked', 'claude'), row('blocked', 'claude'), row('working'), row('unverifiable'), row('idle'), row('idle'), row('idle')],
    })
    expect(summary.clusters[0]?.hiddenIcons).toBe(1)
    expect(summary.hiddenSessions).toBe(3)
    expect(summary.total).toBe(7)
  })

  it('무리가 3 이하면 바깥 `+N` 은 0이다 — 없는 수를 그리지 않는다', () => {
    expect(collapsedSummary({ rows: [row('working'), row('idle')] }).hiddenSessions).toBe(0)
  })

  it('빈 목록이면 무리도 비어 있다', () => {
    expect(collapsedSummary({ rows: [] })).toEqual({ clusters: [], hiddenSessions: 0, total: 0 })
  })
})
