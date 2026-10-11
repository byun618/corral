// k9-ab 자체 시험 (LIFE-580 수정 r1 — R1-A1). 리뷰어 음성 대조 두 건이 **통과하지 못하는지**와 정상 양성 대조가 통과하는지 본다.
//   ① 구동 실패(상태 보고가 늘 실패) → 미달  ② `--rounds 0` → 사용법 오류  ③ B 목록 push 0 → 미달  ④ 스모크 소표본 → 미달  ⑤ 정상 → 통과
// 실제 앱·herdr 없이 `runK9` 에 가짜 deps 를 넣는다. 시계는 실제 시간을 20배로 늘린 가상 시계 — 판정 코드는 실행과 같다.
// 가짜의 latency(20 ms)·루프 표본은 고정값이라 **실성능 수치가 아니다** — 판정기의 판별력만 본다.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { judgeK9, parseK9Args, runK9 } from './k9-ab.mjs'

const SCALE = 20

function fakeDeps({ reportFails = false, pushLists = true } = {}) {
  const start = Date.now()
  const now = () => start + (Date.now() - start) * SCALE
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / SCALE)))
  const until = async (check, { timeoutMs = 20_000, label = 'until' } = {}) => {
    const t0 = now()
    for (;;) {
      const value = await check()
      if (value) return { value, ms: now() - t0 }
      if (now() - t0 > timeoutMs) throw new Error(`${label} 시간 초과`)
      await sleep(10)
    }
  }
  const term = { lines: [''], writes: [] }
  let seq = 0
  let mobileOn = false
  let client = null
  const drivePane = 'p2'
  const listFor = (dot) => ({ type: 'list', seq: (seq += 1), list: { available: true, repos: [{ id: 'r', name: 'r', tasks: [{ id: 't', name: 't', channels: [{ id: drivePane, dot }] }] }], waiting: [] } })
  return {
    now,
    sleep,
    until,
    ctl: async (_root, request) => {
      switch (request.cmd) {
        case 'eval':
          return { ok: true, result: false }
        case 'click':
          return { ok: true, hit: true }
        case 'state':
          return { ok: true, state: { terminal: { phase: 'streaming' } } }
        case 'loop-delay':
          return { ok: true, loopDelay: { started: false, count: 200, p50: 10, p99: 12, max: 15, mean: 10 } }
        case 'type': {
          const at = now()
          term.lines[0] += request.text
          term.writes.push({ at: at + 20, seq: term.writes.length + 1 })
          return { ok: true, at }
        }
        case 'term-read':
          return { ok: true, term: { lines: [...term.lines], writes: [...term.writes] } }
        default:
          return { ok: true }
      }
    },
    herdr: async (_root, method) => {
      if (method === 'pane.list') return { panes: [{ pane_id: 'p1', tab_id: 't1', workspace_id: 'w' }, { pane_id: drivePane, tab_id: 't2', workspace_id: 'w' }] }
      if (method === 'tab.create') return { root_pane: { pane_id: drivePane } }
      if (method === 'pane.send_text') term.lines[0] = ''
      return {}
    },
    setMobile: async (_root, _fake, on) => {
      mobileOn = on
    },
    freshPane: async () => ({ paneId: 'p1' }),
    revokeAll: async () => {},
    phone: async (_root, { onList, onClose }) => {
      const openedAt = now()
      client = { onList, onClose, closed: false }
      onList({ message: listFor('idle'), recvAt: now() })
      return {
        close: async () => {
          if (client !== null && !client.closed) client.onClose({ at: now() })
          client = null
        },
        openedAt,
      }
    },
    reportAgent: async (_root, { state }) => {
      if (reportFails) throw new Error('herdr 보고 실패(가짜)')
      if (mobileOn && client !== null && pushLists) {
        const target = client
        // 서버 뭉침 흉내 — 150 ms 뒤 도착.
        setTimeout(() => {
          if (target.closed) return
          target.onList({ message: listFor(state), recvAt: now() })
        }, 150 / SCALE)
      }
      return now()
    },
  }
}

const config = (patch = {}) => ({ root: '/tmp/l580g-t', fake: '/tmp/l580g-ft', out: '/tmp/l580g-t/out', rounds: 3, samples: 36, aIdleRef: false, ...patch })

describe('k9-ab 판정기 판별력 (R1-A1)', () => {
  it('① 음성 대조 — 상태 보고가 늘 실패하면 즉시 실행 실패 · 미달', async () => {
    const result = await runK9({ config: config(), deps: fakeDeps({ reportFails: true }) })
    assert.equal(result.verdict, '미달')
    assert.match(result.reasons.join('\n'), /상태 보고 실패/)
    // 즉시 — 첫 회차 표본 루프에서 끊긴다(3회를 다 돌지 않는다).
    assert.ok(result.raw.length <= 1, `회차 ${result.raw.length}`)
  })

  it('② 음성 대조 — `--rounds 0` · 음수 · 숫자 아님 · `--samples 0` 은 사용법 오류', () => {
    const base = ['--root', '/tmp/l580g-t', '--fake', '/tmp/l580g-ft', '--out', '/tmp/l580g-t/o']
    for (const extra of [['--rounds', '0'], ['--rounds', '-1'], ['--rounds', 'NaN'], ['--rounds', '1.5'], ['--samples', '0']]) {
      assert.equal(parseK9Args([...base, ...extra]).ok, false, extra.join(' '))
    }
    assert.equal(parseK9Args(base).ok, true)
    // 판정기도 회차 0 을 통과시키지 않는다(사용법 검사를 우회해도).
    assert.equal(judgeK9({ rounds: [], samples: 36 }).pass, false)
  })

  it('③ 음성 대조 — B 에서 첫 목록 뒤 push 가 0 이면 미달(B 수신)', async () => {
    const result = await runK9({ config: config({ rounds: 3 }), deps: fakeDeps({ pushLists: false }) })
    assert.equal(result.verdict, '미달')
    assert.match(result.reasons.join('\n'), /B 수신/)
  })

  it('④ 스모크(rounds 1 · samples 4)는 표본이 나와도 판정 최소에 못 미쳐 미달', async () => {
    const result = await runK9({ config: config({ rounds: 1, samples: 4 }), deps: fakeDeps() })
    assert.equal(result.verdict, '미달')
    assert.match(result.reasons.join('\n'), /회차 A 1 · B 1 < 3/)
    assert.match(result.reasons.join('\n'), /회당 표본 4 < 36/)
    assert.equal(result.raw.length, 2)
    assert.ok(result.raw.every((row) => row.samples.length === 4 && row.samples.every((sample) => !sample.miss)))
  })

  it('⑥ 음성 대조 — 루프 지연 표본 0 · latency 가 유한하지 않으면 그 회차는 무효', () => {
    const row = (mode, patch = {}) => ({
      round: 1,
      mode,
      windowStart: 0,
      windowEnd: 10_000,
      samples: Array.from({ length: 36 }, (_, i) => ({ i, latencyMs: 30 })),
      loopDelay: { started: false, count: 100, p99: 12 },
      reports: Array.from({ length: 12 }, (_, i) => ({ state: i % 2 === 0 ? 'working' : 'idle', causeAt: i * 800, ok: true })),
      lists: Array.from({ length: 12 }, (_, i) => ({ recvAt: i * 800 + 150, dot: i % 2 === 0 ? 'working' : 'idle' })),
      closedAt: null,
      ...patch,
    })
    const good = [1, 2, 3].flatMap((round) => [{ ...row('A'), round }, { ...row('B'), round }])
    assert.equal(judgeK9({ rounds: good, samples: 36 }).pass, true)
    const noLoop = good.map((item, i) => (i === 1 ? { ...item, loopDelay: { started: false, count: 0, p99: 0 } } : item))
    assert.match(judgeK9({ rounds: noLoop, samples: 36 }).reasons.join('\n'), /루프 지연 표본 없음/)
    const nan = good.map((item, i) => (i === 0 ? { ...item, samples: item.samples.map((sample, j) => (j === 0 ? { ...sample, latencyMs: Number.NaN } : sample)) } : item))
    assert.match(judgeK9({ rounds: nan, samples: 36 }).reasons.join('\n'), /표본 35\/36/)
    const closed = good.map((item, i) => (i === 1 ? { ...item, closedAt: 5_000 } : item))
    assert.match(judgeK9({ rounds: closed, samples: 36 }).reasons.join('\n'), /구독 연결이 측정 중 닫혔다/)
  })

  it('⑤ 양성 대조 — 구동·수신·표본·루프가 다 있으면 통과 · A 무구동 참고 회차는 판정 밖', async () => {
    const result = await runK9({ config: config({ aIdleRef: true }), deps: fakeDeps() })
    assert.deepEqual(result.reasons, [])
    assert.equal(result.verdict, '통과')
    assert.equal(result.raw.length, 6)
    assert.equal(result.reference.length, 1)
    assert.equal(result.reference[0].mode, 'A')
    assert.ok(result.perRound.every((row) => row.reportsPerSec >= 1))
  })
})
