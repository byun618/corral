// S2 — 입력→화면 레이턴시. p50 ≤ 117ms · p95 ≤ 173ms (LIFE-345 실타이핑 승계 floor).
// 표본 ≥ 30타, 놓침 0.
//
// 측정 모양 (기준 S2): 실타이핑 리듬 — 키 사이 간격 p50 ~250ms 순차 타이핑.
// 오라클 (수정 1회차 C3 — **주입 시각 기준**):
//   시작 = **주입 시각**: control `type` 명령이 sendInputEvent(char) **직전에** 찍은 main Date.now.
//          (r1 은 시작을 xterm.onData 로 잡아 주입→onData 구간만큼 레이턴시를 과소평가했다.)
//   끝   = 그 글자가 담긴 에코 프레임의 **xterm write 완료 시각**(renderer Date.now).
//   main·renderer 는 같은 머신이라 Date.now 벽시계가 동일 — 교차 프로세스 스큐 없음.
// 입력 경로는 진짜다: sendInputEvent(char) → xterm.onData → IPC → session.input → herdr →
//   에코 프레임 → IPC → xterm write. 프롬프트를 중화해 에코 외 프레임이 안 끼게 한다.
//
// 매칭 규칙 (advisor #4): 프레임 seq 가 아니라 **내용**으로 — 제시층이 coalesce 하므로 특정
//   seq 는 정당하게 버려질 수 있다. "그 글자가 화면에 나타난 뒤, 주입 이후 첫 write 완료" 를
//   끝점으로 잡고 그 write 의 seq 를 같이 기록한다. onDataDeltaMs 로 주입→onData 드리프트도 남긴다.

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
    // 키 주입 — 진짜 입력 경로 (sendInputEvent → xterm.onData). 응답 `at` = 주입 시각(C3).
    const injected = await app.type(ch)
    const injectAt = injected.at
    // 그 글자가 화면에 나타난 뒤, 주입 이후 첫 write 완료 시각. onData 시각도 참고로 잡는다.
    const appeared = await until(
      async () => {
        const term = await app.termRead()
        if (countChar(term, ch) <= baseCount) return null // 내용으로 매칭 (seq 아님)
        // 주입 이후 write 들을 시각(동률이면 seq)으로 정렬. 첫 write 완료가 그 글자를 그린 프레임.
        const after = term.writes.filter((r) => r.at >= injectAt).sort((a, b) => a.at - b.at || a.seq - b.seq)
        const w = after[0]
        if (!w) return null
        // F-1(2회차): 잡은 write 가 **주입 이후 첫** write 임을 명시 확인·기록. 프롬프트 중화라
        //   에코 외 프레임이 없어 이 값은 1 이 기대치 — 1 이면 첫 write=에코라 과소측정 창이 닫힌다.
        const writesAfterInject = after.length
        const input = term.inputs.slice(baseInputs).find((r) => r.data === ch)
        return { onDataAt: input ? input.at : null, writeAt: w.at, seq: w.seq, writesAfterInject }
      },
      { timeoutMs: 2000, everyMs: 8, what: `echo of ${ch}` },
    )
    if (!appeared.ok) {
      misses += 1
      samples.push({ i, ch, latencyMs: null, miss: true })
    } else {
      const { onDataAt, writeAt, seq, writesAfterInject } = appeared.value
      samples.push({
        i,
        ch,
        injectAt,
        onDataAt,
        writeAt,
        seq,
        writesAfterInject,
        latencyMs: writeAt - injectAt,
        onDataDeltaMs: onDataAt !== null ? onDataAt - injectAt : null,
      })
    }
    await sleep(gap())
  }

  const latencies = samples.filter((s) => !s.miss).map((s) => s.latencyMs)
  const p50 = pct(latencies, 50)
  const p95 = pct(latencies, 95)
  const max = Math.max(...latencies)
  // F-1: 표본마다 '주입 이후 write 수'. 전부 1 이면 첫 write=에코 확정(과소측정 창 닫힘). 기록만 — 판정 무관.
  const wai = samples.filter((s) => !s.miss).map((s) => s.writesAfterInject)
  const writesAfterInject = { min: Math.min(...wai), max: Math.max(...wai), allOne: wai.every((n) => n === 1) }
  const pass = misses === 0 && latencies.length >= 30 && p50 <= 117 && p95 <= 173
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    method:
      '주입 시각 기준 (수정 1회차 C3): 시작=control type 이 sendInputEvent 직전 찍은 main Date.now, 끝=그 글자 담긴 에코 프레임 xterm write 완료(renderer Date.now). 같은 머신이라 벽시계 동일(스큐 없음). 매칭은 내용(그 글자 등장) 후 주입 이후 첫 write, seq 동봉. F-1(2회차): 잡은 write 가 주입 이후 첫 write 임을 writesAfterInject 로 명시 확인(전부 1=첫 write가 에코, 과소측정 창 닫힘). onDataDeltaMs=주입→onData 드리프트(참고). 폴링·타이밍은 fix1 그대로 — 이번 미달은 zsh-autosuggestions 오염이 원인이라 neutralizePrompt 에서 자동제안 끄고 히스토리 비워 해결(§8).',
    samples: samples.length,
    misses,
    p50,
    p95,
    max,
    writesAfterInject,
    floor: { p50: 117, p95: 173 },
    verdict: pass ? '통과' : '미달',
    raw: samples,
  }
  writeRaw('s2-latency.json', result)
  console.log(`\nS2 표본 ${latencies.length} · 놓침 ${misses} · p50 ${p50}ms · p95 ${p95}ms · max ${max}ms · writesAfterInject ${writesAfterInject.min}~${writesAfterInject.max}(allOne=${writesAfterInject.allOne}) → ${result.verdict}`)
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
