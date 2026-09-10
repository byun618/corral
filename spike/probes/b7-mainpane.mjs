// ⑩′ 후속 — verdict.md 재확인 1 이 남긴 "진짜 질문" 하나를 친다:
//   attach 중인 TUI 클라이언트가 소유한 메인 판(w1:p1)에서 왜 0줄인가.
//
// b7-cause 가 낸 세 숫자가 후보를 좁혔다:
//   split 판(포커스 O/X) 둘 다 300/300 회수 → 변수는 "포커스"가 아니다
//   에이전트 판은 split 판인데도 0줄 → 변수는 "split 이냐"도 아니다
//   에이전트 판의 공통점은 알트스크린이고, 알트 실측에서 알트 유지 중 maxOffset 이 0이었다
// → 가설: **알트스크린이 켜져 있는 동안은 어느 판이든 0줄이다.**
//   메인 판이 알트에 들어가 있다면 세 결과가 하나로 설명된다. 그걸 직접 확인한다.
//
// 가설이 틀리면 틀린 대로 적는다. 맞추려고 재지 않는다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b7-mainpane.mjs

import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi, run, readText, readAnsi } from '../lib/pane.mjs'

const raw = new Raw('b7-mainpane')
const api = makeApi(raw)
const R = {}

const panes = async () => (await api('pane.list', {})).panes
const info = async (id) => (await panes()).find((p) => p.pane_id === id) ?? null
const span = (t, tag) => {
  const n = [...String(t).matchAll(new RegExp(`${tag}-(\\d{3})`, 'g'))].map((m) => +m[1])
  return n.length ? { min: Math.min(...n), max: Math.max(...n), count: new Set(n).size } : null
}
const emit = (tag, n = 300) => `for i in $(seq 1 ${n}); do printf '${tag}-%03d\\n' $i; done`

async function shot(paneId, tag) {
  const vis = await readText(api, paneId, 'visible')
  const ru = await readText(api, paneId, 'recent_unwrapped', 5000)
  const i = await info(paneId)
  const v = span(vis.text, tag)
  const r = span(ru.text, tag)
  return {
    maxOffset: i?.scroll?.max_offset_from_bottom ?? null,
    visibleSpan: v,
    recentUnwrappedSpan: r,
    rowsBeyondViewport: r && v ? Math.max(0, r.count - v.count) : r ? r.count : 0,
  }
}

for (const p of (await panes()).slice(1)) await api('pane.close', { pane_id: p.pane_id }).catch(() => {})
await sleep(600)
const MAIN = (await panes())[0].pane_id

// --- ① 메인 판에서 무엇이 돌고 있나 --------------------------------------
try {
  R.mainProcess = await api('pane.process_info', { pane_id: MAIN })
} catch (err) {
  R.mainProcess = { error: String(err).replace(/^Error: /, '') }
}

// --- ② 메인 판이 지금 알트스크린인가 -------------------------------------
// 알트 여부를 직접 알려주는 필드는 없다. 대신 "알트에서 나가라"를 보내고
// 화면·스크롤백이 달라지는지로 판별한다.
{
  await run(api, MAIN, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  await run(api, MAIN, emit('B7PRE'), { settleMs: 3000 })
  R.beforeExitAlt = await shot(MAIN, 'B7PRE')

  // 알트스크린 탈출을 명시적으로 보낸다
  await run(api, MAIN, "printf '\\033[?1049l'", { settleMs: 1000 })
  R.afterExitAltSameContent = await shot(MAIN, 'B7PRE')

  // 나온 뒤 다시 300줄을 찍고 잰다 — 여기서 회수되면 알트가 원인이었던 것이다
  await run(api, MAIN, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  await run(api, MAIN, emit('B7POST'), { settleMs: 3000 })
  R.afterExitAltFresh = await shot(MAIN, 'B7POST')
}

// --- ③ 대조군: 같은 순간 split 판 ----------------------------------------
{
  const sp = await api('pane.split', { direction: 'right' })
  const S = sp.pane.pane_id
  await sleep(1500)
  await run(api, S, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  await run(api, S, emit('B7CTL'), { settleMs: 3000 })
  R.splitControl = await shot(S, 'B7CTL')
  try {
    R.splitProcess = await api('pane.process_info', { pane_id: S })
  } catch (err) {
    R.splitProcess = { error: String(err).replace(/^Error: /, '') }
  }
  await api('pane.close', { pane_id: S }).catch(() => {})
}

// --- ④ split 판을 알트에 넣으면 0줄이 되는가 (가설의 반대 방향 확인) -----
{
  const sp = await api('pane.split', { direction: 'right' })
  const S = sp.pane.pane_id
  await sleep(1500)
  await run(api, S, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  await run(api, S, emit('B7ALT2'), { settleMs: 3000 })
  const beforeAlt = await shot(S, 'B7ALT2')
  await run(api, S, "printf '\\033[?1049h'", { settleMs: 800 })
  const duringAlt = await shot(S, 'B7ALT2')
  await run(api, S, "printf '\\033[?1049l'", { settleMs: 800 })
  const afterAlt = await shot(S, 'B7ALT2')
  R.splitIntoAlt = { beforeAlt, duringAlt, afterAlt }
  await api('pane.close', { pane_id: S }).catch(() => {})
}

// 메인 판 화면 원문도 한 장 남긴다 (판독용)
try {
  const a = await readAnsi(api, MAIN, 'visible')
  const fs = await import('node:fs')
  fs.writeFileSync(new URL('../../specs/LIFE-342-spike/raw/claude/b7-mainpane-visible.ansi', import.meta.url), a.text)
} catch {}

for (const p of (await panes()).slice(1)) await api('pane.close', { pane_id: p.pane_id }).catch(() => {})

R.verdict = {
  mainBeforeExitAlt: R.beforeExitAlt.rowsBeyondViewport,
  mainAfterExitAltFresh: R.afterExitAltFresh.rowsBeyondViewport,
  splitControl: R.splitControl.rowsBeyondViewport,
  splitDuringAlt: R.splitIntoAlt.duringAlt.rowsBeyondViewport,
  splitAfterAlt: R.splitIntoAlt.afterAlt.rowsBeyondViewport,
}
raw.close({ probe: 'b7-mainpane', at: new Date().toISOString(), results: R })
process.exit(0)
