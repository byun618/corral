// S2 — 입력→화면 레이턴시. p50 ≤ 117ms · p95 ≤ 173ms (LIFE-345 실타이핑 승계 floor).
// 표본 ≥ 30타, 놓침 0.
//
// 측정 모양 (기준 S2): 실타이핑 리듬 — 키 사이 간격 p50 ~250ms 순차 타이핑.
// 오라클 (같은 렌더러 시계로 양끝을 잰다 — 교차 프로세스 스큐 제거):
//   시작 = xterm.onData 발화 시각(그 키가 입력으로 들어온 순간, 렌더러 Date.now)
//   끝   = 그 글자가 담긴 에코 프레임의 **xterm write 완료 시각**(같은 렌더러 Date.now)
// 입력 경로는 진짜다: sendInputEvent(char) → xterm.onData → IPC → session.input → herdr →
//   에코 프레임 → IPC → xterm write. 프롬프트를 중화해 에코 외 프레임이 안 끼게 한다.
//
// 매칭 규칙 (advisor #4): 프레임 seq 가 아니라 **내용**으로 — 제시층이 coalesce 하므로 특정
//   seq 는 정당하게 버려질 수 있다. "그 글자가 화면에 나타난 첫 write 완료" 를 끝점으로 잡는다.

import { startApp, attachPane, firstPaneId, settleXterm, until, pct, sleep, writeRaw } from './lib.mjs'
import { neutralizePrompt } from './fixtures.mjs'

const SAMPLES = 36
// 실타이핑 리듬 — 키 사이 간격을 220~300ms 로 흔든다 (승계 원본 p50 252ms).
const gap = () => 220 + Math.floor(Math.random() * 80)
const CHARS = 'abcdefghijklmnopqrstuvwxyz'

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's2-latency' })
  await attachPane(app, paneId)
  await neutralizePrompt(paneId)
  await settleXterm(app)

  const samples = []
  let misses = 0
  for (let i = 0; i < SAMPLES; i++) {
    const ch = CHARS[i % CHARS.length]
    const before = await app.termRead()
    const baseCount = countChar(before, ch)
    const baseInputs = before.inputs.length
    // 키 주입 — 진짜 입력 경로 (sendInputEvent → xterm.onData).
    await app.send({ cmd: 'type', text: ch })
    // 렌더러가 이 키를 onData 로 받은 시각 + 그 글자가 화면에 나타난 첫 write 완료 시각.
    const appeared = await until(
      async () => {
        const term = await app.termRead()
        if (countChar(term, ch) <= baseCount) return null
        const input = term.inputs.slice(baseInputs).find((r) => r.data === ch)
        if (!input) return null
        const w = term.writes.filter((r) => r.at >= input.at).sort((a, b) => a.at - b.at)[0]
        return w ? { inputAt: input.at, writeAt: w.at, seq: w.seq } : null
      },
      { timeoutMs: 2000, everyMs: 8, what: `echo of ${ch}` },
    )
    if (!appeared.ok) {
      misses += 1
      samples.push({ i, ch, latencyMs: null, miss: true })
    } else {
      const { inputAt, writeAt, seq } = appeared.value
      samples.push({ i, ch, inputAt, writeAt, seq, latencyMs: writeAt - inputAt })
    }
    await sleep(gap())
  }

  const latencies = samples.filter((s) => !s.miss).map((s) => s.latencyMs)
  const p50 = pct(latencies, 50)
  const p95 = pct(latencies, 95)
  const max = Math.max(...latencies)
  const pass = misses === 0 && latencies.length >= 30 && p50 <= 117 && p95 <= 173
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    method: '양끝 모두 렌더러 Date.now (스큐 없음): 시작=xterm.onData(그 키 입력), 끝=그 글자 담긴 에코 프레임 write 완료. 경로: onData→IPC→session.input→herdr echo→frame→IPC→xterm write.',
    samples: samples.length,
    misses,
    p50,
    p95,
    max,
    floor: { p50: 117, p95: 173 },
    verdict: pass ? '통과' : '미달',
    raw: samples,
  }
  writeRaw('s2-latency.json', result)
  console.log(`\nS2 표본 ${latencies.length} · 놓침 ${misses} · p50 ${p50}ms · p95 ${p95}ms · max ${max}ms → ${result.verdict}`)
  await app.stop()
  process.exit(pass ? 0 : 1)
}

/** 커서 줄(마지막 비어있지 않은 줄)에서 특정 글자 개수 — 에코 누적을 센다. */
function countChar(term, ch) {
  if (term === null) return 0
  return term.lines.join('\n').split(ch).length - 1
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
