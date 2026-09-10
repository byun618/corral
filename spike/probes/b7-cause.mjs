// ⑩′ B7 원인 재측정 — verdict.md §8 이 지정한 항목.
//
// 지금까지의 B7 은 attach 중인 herdr TUI 가 소유한 메인 판(w1:p1) 하나만 쟀고,
// 거기서 "뷰포트 밖 0줄"이 나왔다. 형제 브랜치(codex)는 pane.split 로 만든 판에서
// 120줄을 회수했다. 같은 herdr 0.9.0 · 같은 기계다. 그래서 변수가 무엇인지 가른다.
//
// 같은 세션에서 같은 300줄을 아래에 각각 찍고 나란히 잰다:
//   ① attach 메인 판 (w1:p1)          — 지금까지 쟀던 그 판
//   ② pane.split 판, 포커스 있음        — codex 가 쟀던 종류
//   ③ pane.split 판, 포커스 없음        — "메인이냐"와 "포커스냐"를 가르는 대조군
//   ④ 에이전트 판 (agent.start)        — 문서가 말하는 "전체화면 에이전트 + idle" 경로
//   ⑤ 알트스크린 범위 (split 판에서)     — 지금까지 메인 판에서만 쟀던 것
//
// 결론을 정해두고 재지 않는다. 어느 쪽이 나오든 그대로 적는다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b7-cause.mjs

import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi, run, readText } from '../lib/pane.mjs'

const raw = new Raw('b7-cause')
const api = makeApi(raw)
const R = {}
const N = 300

const info = async (id) => (await api('pane.list', {})).panes.find((p) => p.pane_id === id) ?? null
const panes = async () => (await api('pane.list', {})).panes

/** 태그가 붙은 줄 번호의 최소·최대·개수. 회수 "범위"가 곧 이 항목의 답이다. */
const span = (t, tag) => {
  const n = [...String(t).matchAll(new RegExp(`${tag}-(\\d{3})`, 'g'))].map((m) => +m[1])
  return n.length ? { min: Math.min(...n), max: Math.max(...n), count: new Set(n).size } : null
}

/** sh 로 300줄. seq -f 는 이식성이 없어 printf 루프를 쓴다. */
const emit = (tag, n = N) => `for i in $(seq 1 ${n}); do printf '${tag}-%03d\\n' $i; done`

/**
 * 한 판을 재는 한 벌. 판 종류만 바뀌고 읽는 방법은 완전히 같다 —
 * 그래야 차이가 판 성질에서 온 것이라고 말할 수 있다.
 */
async function measure(paneId, tag, { emitFirst = true } = {}) {
  if (emitFirst) {
    await run(api, paneId, "printf '\\033[2J\\033[H'", { settleMs: 400 })
    await run(api, paneId, emit(tag), { settleMs: 3000 })
  }
  const before = await info(paneId)
  const reads = {}
  for (const source of ['visible', 'recent', 'recent_unwrapped']) {
    try {
      const r = await readText(api, paneId, source, source === 'visible' ? undefined : 5000)
      reads[source] = {
        bytes: r.text.length,
        truncated: r.truncated,
        span: span(r.text, tag),
        firstLine: r.text.split('\n').find((x) => x.trim())?.slice(0, 40) ?? null,
      }
    } catch (err) {
      reads[source] = { error: String(err).replace(/^Error: /, '') }
    }
  }
  // pane.scroll 이 실제로 화면을 뒤로 옮기는가 — 옮겨지면 서버가 과거를 들고 있는 것이다
  const scrollTried = []
  for (const off of [10, 80]) {
    try {
      const res = await api('pane.scroll', { pane_id: paneId, offset_from_bottom: off })
      await sleep(200)
      const v = await readText(api, paneId, 'visible')
      scrollTried.push({
        requested: off,
        reported: res.pane?.scroll?.offset_from_bottom ?? null,
        maxOffset: res.pane?.scroll?.max_offset_from_bottom ?? null,
        topLine: v.text.split('\n').find((x) => x.trim())?.slice(0, 40) ?? null,
      })
    } catch (err) {
      scrollTried.push({ requested: off, error: String(err).replace(/^Error: /, '') })
    }
  }
  await api('pane.scroll', { pane_id: paneId, offset_from_bottom: 0 }).catch(() => {})
  const viewport = reads.visible?.span
  const recovered = reads.recent_unwrapped?.span
  return {
    paneId,
    tag,
    focused: before?.focused ?? null,
    maxOffsetFromBottom: before?.scroll?.max_offset_from_bottom ?? null,
    reads,
    scrollTried,
    viewMoved: new Set(scrollTried.map((s) => s.topLine).filter(Boolean)).size > 1,
    // 이 프로브가 답해야 할 한 숫자: 뷰포트 밖으로 몇 줄이 더 나왔는가
    rowsBeyondViewport:
      recovered && viewport ? Math.max(0, recovered.count - viewport.count) : recovered ? recovered.count : 0,
  }
}

// 시작 상태를 깨끗하게 (메인 판만 남긴다)
for (const p of (await panes()).slice(1)) await api('pane.close', { pane_id: p.pane_id }).catch(() => {})
await sleep(800)
const MAIN = (await panes())[0].pane_id

// --- ① attach 메인 판 -----------------------------------------------------
R.mainPane = await measure(MAIN, 'B7MAIN')
console.log('① 메인:', R.mainPane.rowsBeyondViewport, '줄, maxOffset', R.mainPane.maxOffsetFromBottom)

// --- ② split 판, 포커스 있음 ----------------------------------------------
const sp = await api('pane.split', { direction: 'right' })
const SPLIT = sp.pane.pane_id
await sleep(1500)
await api('pane.focus', { pane_id: SPLIT }).catch(() => {})
await sleep(300)
R.splitFocused = await measure(SPLIT, 'B7SPLF')
console.log('② split 포커스:', R.splitFocused.rowsBeyondViewport, '줄, maxOffset', R.splitFocused.maxOffsetFromBottom)

// --- ③ split 판, 포커스 없음 ----------------------------------------------
// 같은 판에 다시 찍고, 읽기 전에 포커스를 메인으로 넘긴다.
await api('pane.focus', { pane_id: SPLIT }).catch(() => {})
await sleep(200)
await run(api, SPLIT, "printf '\\033[2J\\033[H'", { settleMs: 400 })
await run(api, SPLIT, emit('B7SPLU'), { settleMs: 3000 })
await api('pane.focus', { pane_id: MAIN }).catch(() => {})
await sleep(500)
R.splitUnfocused = await measure(SPLIT, 'B7SPLU', { emitFirst: false })
console.log('③ split 비포커스:', R.splitUnfocused.rowsBeyondViewport, '줄, focused=', R.splitUnfocused.focused)

// --- ⑤ 알트스크린 범위 (split 판) -----------------------------------------
// 지금까지 알트는 메인 판에서만 쟀다. 메인은 어차피 0줄이라 알트 얘기를 분리할 수 없었다.
{
  const alt = {}
  await api('pane.focus', { pane_id: SPLIT }).catch(() => {})
  await sleep(200)
  await run(api, SPLIT, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  await run(api, SPLIT, emit('B7HOST'), { settleMs: 3000 })
  alt.beforeAlt = span((await readText(api, SPLIT, 'recent_unwrapped', 5000)).text, 'B7HOST')

  // 알트스크린으로 들어가서 그 안에 찍는다
  await run(api, SPLIT, "printf '\\033[?1049h'", { settleMs: 600 })
  await run(api, SPLIT, emit('B7ALT', 120), { settleMs: 2500 })
  const inAlt = await readText(api, SPLIT, 'recent_unwrapped', 5000)
  alt.duringAlt = {
    hostHistoryVisible: span(inAlt.text, 'B7HOST'),
    altContentVisible: span(inAlt.text, 'B7ALT'),
    maxOffset: (await info(SPLIT))?.scroll?.max_offset_from_bottom ?? null,
  }

  // 알트에서 나온다 — 알트 안 출력이 되살아나는가
  await run(api, SPLIT, "printf '\\033[?1049l'", { settleMs: 800 })
  const afterAlt = await readText(api, SPLIT, 'recent_unwrapped', 5000)
  alt.afterAlt = {
    hostHistoryBack: span(afterAlt.text, 'B7HOST'),
    altContentRecovered: span(afterAlt.text, 'B7ALT'),
    maxOffset: (await info(SPLIT))?.scroll?.max_offset_from_bottom ?? null,
  }
  R.altScreen = alt
  console.log('⑤ 알트:', JSON.stringify(alt))
}

await api('pane.close', { pane_id: SPLIT }).catch(() => {})
await sleep(500)

// --- ④ 에이전트 판 --------------------------------------------------------
// 문서가 말하는 "전체화면 에이전트 + idle" 경로. 에이전트에게 같은 300줄을 찍게 하고
// idle 이 된 뒤 agent.read / pane.read 양쪽으로 읽는다.
{
  const A = { name: 'b7-agent' }
  try {
    for (const a of (await api('agent.list', {})).agents) {
      if (a.name === A.name) await api('agent.stop', { target: A.name }).catch(() => {})
    }
    const ap = await api('pane.split', { direction: 'right' })
    const APANE = ap.pane.pane_id
    await sleep(2000)

    let started = null
    for (let i = 0; i < 10 && !started; i++) {
      try {
        started = await api(
          'agent.start',
          { name: A.name, kind: 'claude', pane_id: APANE, timeout_ms: 120000 },
          { timeoutMs: 130000 },
        )
      } catch (err) {
        if (!String(err).includes('agent_pane_busy')) throw err
        await sleep(1000)
      }
    }
    A.started = !!started

    // launch_pending 은 false 가 되는 게 아니라 필드가 사라진다 (앞선 프로브에서 물렸다)
    const dl = Date.now() + 120000
    let st = null
    while (Date.now() < dl) {
      st = (await api('agent.list', {})).agents.find((x) => x.name === A.name) ?? null
      if (st && !st.launch_pending && ['idle', 'done'].includes(st.agent_status)) break
      // 신뢰 확인 화면에서 서면 푼다 (claude: down + enter)
      if (st?.agent_status === 'blocked') {
        await api('agent.send_keys', { target: A.name, keys: ['down'] })
        await sleep(300)
        await api('agent.send_keys', { target: A.name, keys: ['enter'] })
      }
      await sleep(1500)
    }
    A.statusBeforePrompt = st?.agent_status ?? null

    // 에이전트에게 300줄을 찍게 한다. 첫 프롬프트가 stalled 로 튕기는 일이 있어 재시도한다.
    const prompt = `Bash 툴로 정확히 이 명령만 실행하고 결과 요약은 한 단어로만 답해: ${emit('B7AGT')}`
    A.promptAttempts = []
    for (let i = 0; i < 4; i++) {
      try {
        const r = await api(
          'agent.prompt',
          { target: A.name, text: prompt, wait: { until: ['idle', 'done'], timeout_ms: 180000 } },
          { timeoutMs: 190000 },
        )
        A.promptAttempts.push({ i, ok: true, type: r.type })
        break
      } catch (err) {
        A.promptAttempts.push({ i, ok: false, error: String(err).replace(/^Error: /, '').slice(0, 120) })
        await sleep(4000)
      }
    }
    A.promptOk = A.promptAttempts.some((x) => x.ok)
    await sleep(3000)

    // idle 인 상태에서 읽는다 — 문서가 말한 조건
    A.statusAtRead = (await api('agent.list', {})).agents.find((x) => x.name === A.name)?.agent_status ?? null
    A.agentRead = {}
    for (const source of ['visible', 'recent', 'recent_unwrapped']) {
      try {
        const r = await api('agent.read', {
          target: A.name,
          source,
          format: 'text',
          ...(source === 'visible' ? {} : { lines: 5000 }),
        })
        A.agentRead[source] = { bytes: r.read?.text?.length ?? 0, span: span(r.read?.text ?? '', 'B7AGT') }
      } catch (err) {
        A.agentRead[source] = { error: String(err).replace(/^Error: /, '').slice(0, 200) }
      }
    }
    // 같은 판을 pane.read 로도 읽어 비교한다
    A.paneRead = await measure(APANE, 'B7AGT', { emitFirst: false })
    R.agentPane = A
    await api('agent.stop', { target: A.name }).catch(() => {})
    await sleep(500)
    await api('pane.close', { pane_id: APANE }).catch(() => {})
  } catch (err) {
    R.agentPane = { ...A, failed: String(err).replace(/^Error: /, '') }
  }
  console.log('④ 에이전트:', JSON.stringify(R.agentPane?.agentRead ?? R.agentPane).slice(0, 400))
}

// 정리 — 메인 판만 남긴다
for (const p of (await panes()).slice(1)) await api('pane.close', { pane_id: p.pane_id }).catch(() => {})

R.verdict = {
  mainPaneRowsBeyondViewport: R.mainPane.rowsBeyondViewport,
  splitFocusedRowsBeyondViewport: R.splitFocused.rowsBeyondViewport,
  splitUnfocusedRowsBeyondViewport: R.splitUnfocused.rowsBeyondViewport,
  agentPaneRowsBeyondViewport: R.agentPane?.paneRead?.rowsBeyondViewport ?? null,
  note: '변수가 무엇인지는 이 네 숫자가 말한다. 결론을 맞추려 하지 않았다',
}
raw.close({ probe: 'b7-cause', at: new Date().toISOString(), lines: N, results: R })
process.exit(0)
