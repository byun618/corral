// LIFE-582 r11 F2 — 「지켜보는 중」 입력창·대기 줄 문구가 서버가 실제로 하는 일과 맞는다.
// 서버 큐(app `input.ts` · `agentQuiescent`)는 herdr 가 idle·done 이 아닐 때만 기다린다. 지켜보는 중(턴 끝 + 백그라운드)은 herdr 한가(바로 들어감)와
// working(Grok — 기다림)을 둘 다 덮으므로 입력창은 「끝나면 들어갑니다」 라고 약속하지 않는다. 대기 줄은 서버가 실제로 기다릴 때(`queued` · wait ≠ gate)만.
import { describe, expect, it } from 'vitest'
import { composerMode, sentLine, type SentEntry } from '../src/core/input'
import type { Channel } from '../src/core/list'

const channel = (patch: Partial<Channel>): Channel => ({ id: 'w1:p1', key: 's:w1:p1', status: 'live', kind: 'claude', title: 't', dot: 'idle', dotUnseen: 'idle', depth: 0, origin: null, spawnedBy: null, parent: null, preview: { kind: 'none' }, waiting: null, model: null, timeAt: null, activityAt: 1, outcome: null, ...patch })
const placeholder = (dot: Channel['dot']): string | null => {
  const mode = composerMode({ channel: channel({ dot, dotUnseen: dot }), conn: 'connected', unknown: false, question: null, step: 0, noSession: false })
  return mode.kind === 'open' || mode.kind === 'locked' ? mode.placeholder : null
}
const entry = (patch: Partial<SentEntry>): SentEntry => ({ id: 'm1', channel: 'w1:p1', op: 'send', text: '안녕', state: 'queued', wait: null, reason: null, acked: true, sentAt: 0, at: 0, tailId: 5, provisional: false, ...patch })
const line = (input: { wait: SentEntry['wait']; monitoring: boolean; acked?: boolean }) => sentLine({ entry: entry({ wait: input.wait, acked: input.acked ?? true }), hhmm: () => '00:00', monitoring: input.monitoring })

describe('F2 상태별 입력창 문구', () => {
  it('한가 · 작업 중 · 지켜보는 중', () => {
    expect([placeholder('idle'), placeholder('working'), placeholder('monitoring')]).toEqual([
      '지시 보내기',
      '지시 보내기 — 이 턴이 끝나면 들어갑니다',
      '지시 보내기 — 백그라운드 작업은 계속 돕니다',
    ])
  })
  it('지켜보는 중 입력창은 「끝나면 들어갑니다」 라고 약속하지 않는다', () => {
    expect(placeholder('monitoring')).not.toContain('들어갑니다')
  })
})

describe('F2 상태별 대기 줄 — 실제로 기다릴 때만', () => {
  it('서버가 기다림(turn) — 작업 중 / 지켜보는 중(herdr working 에 머묾)', () => {
    expect(line({ wait: 'turn', monitoring: false })).toEqual({ tone: 'question', text: '대기 중 · 이 턴이 끝나면 들어갑니다', action: 'cancel', faded: false })
    expect(line({ wait: 'turn', monitoring: true })).toEqual({ tone: 'question', text: '대기 중 · 백그라운드 작업까지 끝나면 들어갑니다', action: 'cancel', faded: false })
  })
  it('넣기 직전 확인(gate) — 한가로 보고 들어가는 중이므로 대기 줄이 아니다(취소는 아직 된다)', () => {
    for (const monitoring of [false, true]) {
      expect(line({ wait: 'gate', monitoring })).toEqual({ tone: 'muted', text: '보내는 중…', action: 'cancel', faded: true })
    }
    expect(line({ wait: 'gate', monitoring: true, acked: false })).toMatchObject({ text: '보내는 중…', action: null })
  })
})
