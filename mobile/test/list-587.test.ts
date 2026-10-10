// LIFE-587 — 둘째 줄 접두어와 「재료 없음 대체 글」 겹침 제거(K1) · 대화 머리 상태 이름 불변(K2).
// K1 기대값은 specs/LIFE-587-waiting-label-dup/01-criteria.md 「K1 표」. K2 기준표는 기준 commit 5b0355944 에서 뽑은 출력(`fixtures/587-header-baseline.ts`).
import { describe, expect, it } from 'vitest'
import { DOTS, type Channel, type WaitKind } from '../src/core/list'
import { buildListView, headerStatus, statusLabel } from '../src/core/list-view'
import { baseline } from './fixtures/587-header-baseline'

function channel(id: string, patch: Partial<Channel>): Channel {
  const dot = patch.dot ?? 'idle'
  return { id, key: `s:${id}`, status: 'live', kind: 'claude', title: id, dot, dotUnseen: dot, depth: 0, origin: null, spawnedBy: null, parent: null, preview: { kind: 'none' }, waiting: null, model: null, timeAt: null, activityAt: 1, outcome: null, ...patch }
}

// [이름, 채널, 접두어, 글] — K1 표 1~13행.
const K1: [string, Partial<Channel>, string | null, string][] = [
  ['1 blocked null', { dot: 'blocked', waiting: null }, '대기 중', ''],
  ['1 blocked other', { dot: 'blocked', waiting: 'other' }, '대기 중', ''],
  ['2 blocked login', { dot: 'blocked', waiting: 'login' }, '로그인 대기', ''],
  ['3 failed', { dot: 'failed' }, '실패', ''],
  ['4 interrupted', { dot: 'interrupted' }, '중단됨', ''],
  ['5 done', { dot: 'done' }, '완료', ''],
  ['6 unverifiable', { dot: 'unverifiable' }, '확인 불가', ''],
  ['7 monitoring', { dot: 'monitoring' }, '백그라운드', ''],
  ['8 question null', { dot: 'waiting', waiting: 'question', preview: { kind: 'question', text: null } }, '질문', ''],
  ['9 approval null', { dot: 'waiting', waiting: 'approval', preview: { kind: 'approval', text: null } }, '맥에서 승인', ''],
  ['10 working', { dot: 'working' }, null, '작업 중'],
  ['11 idle', { dot: 'idle' }, null, '한가'],
  ['12 closed', { status: 'closed', dot: 'idle' }, null, '닫힌 세션'],
  ['13 question 글', { dot: 'waiting', waiting: 'question', preview: { kind: 'question', text: '어느 쪽?' } }, '질문', '어느 쪽?'],
  ['13 approval 도구', { dot: 'waiting', waiting: 'approval', preview: { kind: 'approval', text: 'Bash · ls' } }, '맥에서 승인', 'Bash · ls'],
  ['13 failed 사유', { dot: 'failed', preview: { kind: 'error', text: '529' } }, '실패', '529'],
  ['13 working 도구', { dot: 'working', preview: { kind: 'tool', text: 'Read a.ts' } }, null, 'Read a.ts'],
  ['13 idle 내 지시', { dot: 'idle', preview: { kind: 'prompt', text: '정리해 줘' } }, '나', '정리해 줘'],
]

describe('LIFE-587 K1 둘째 줄', () => {
  it('K1 표 전 행 — [접두어, 글] 이 표와 같다 · 재료 있는 행의 mono 도 그대로', () => {
    const channels = K1.map(([name, patch]) => channel(name, patch))
    const view = buildListView({
      list: { available: true, repos: [{ id: 'r', name: 'r', tasks: [{ id: 't', name: 't', isDefault: false, channels }] }], waiting: [] },
      isUnread: () => false,
      isCollapsed: () => false,
      flashUntil: {},
      now: 0,
      waitingExpanded: false,
    })
    const rows = view.repos[0]?.tasks[0]?.rows ?? []
    expect(rows.map((row) => (row.kind === 'channel' ? [row.channel.id, row.prefix?.text ?? null, row.text] : null))).toEqual(K1.map(([name, , prefix, text]) => [name, prefix, text]))
    expect(rows.map((row) => (row.kind === 'channel' ? row.mono : null))).toEqual(K1.map(([name]) => name === '13 approval 도구' || name === '13 working 도구'))
  })

  it('기다림 섹션 행도 같은 규칙 — 사유 없는 대기는 접두어만', () => {
    const blocked = channel('b', { dot: 'blocked' })
    const view = buildListView({
      list: { available: true, repos: [{ id: 'r', name: 'r', tasks: [{ id: 't', name: 't', isDefault: false, channels: [blocked] }] }], waiting: ['b'] },
      isUnread: () => false,
      isCollapsed: () => false,
      flashUntil: {},
      now: 0,
      waitingExpanded: false,
    })
    expect(view.waiting.map((row) => [row.prefix?.text ?? null, row.text])).toEqual([['대기 중', '']])
  })
})

describe('LIFE-587 K2 대화 머리 불변', () => {
  const waits: (WaitKind | null)[] = [null, 'question', 'approval', 'login', 'other']

  it('statusLabel · headerStatus — 9점 × 닫힘/열림 × waiting 4종+null(× unknown) 이 기준 commit 출력과 같다', () => {
    const label: unknown[] = []
    const header: unknown[] = []
    for (const dot of DOTS)
      for (const closed of [false, true])
        for (const waiting of waits) {
          label.push([dot, closed, waiting, statusLabel({ dot, waiting, closed })])
          for (const unknown of [false, true]) header.push([dot, closed, waiting, unknown, headerStatus({ channel: channel('h', { dot, waiting, status: closed ? 'closed' : 'live' }), unknown })])
        }
    expect(label).toHaveLength(90)
    expect(header).toHaveLength(180)
    expect(label).toEqual(baseline.statusLabel)
    expect(header).toEqual(baseline.headerStatus)
  })
})
