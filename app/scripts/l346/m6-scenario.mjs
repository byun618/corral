// M6 — N10(Step 2 완료 시나리오) · N9(회귀: LIFE-345 가 그대로 돈다) · A1(종료 대기 피드백)
//
// **Orca 를 한 번도 쓰지 않고** corral 안에서만 한 바퀴를 돈다:
//   ① `+ 새 행` → claude   ② 터미널이 붙는다   ③ 프롬프트를 친다   ④ 응답을 화면에서 확인
//   ⑤ 그 행을 종료   ⑥ 목록에서 사라짐 + 터미널 표면이 정직해짐
//
// 누르는 것도 치는 것도 전부 **렌더러**를 지난다 (`click`·`key`). 한 회차 내내 순번·시각이
// 이어지는 스크린샷을 남긴다 — 그게 이 항목이 요구하는 "한 번의 연속 기록" 이다.

import {
  alive,
  clickLog,
  clickWhenVisible,
  createRowByUi,
  firstWorkspaceId,
  herdrTruth,
  paneProcesses,
  request,
  sleep,
  startApp,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

/**
 * 표식은 **프롬프트에 없는 글자**여야 한다.
 *
 * 1회차에는 `Reply with exactly L346OK...` 를 치고 화면에서 `L346OK` 를 찾았는데, 그건 내가 친
 * 글자가 에코된 것이라 502ms 만에 "응답을 봤다" 가 됐다. 그래서 대문자로 바꿔 달라고 시키고
 * **대문자**를 찾는다 — 프롬프트에는 소문자만 있다.
 */
const MARK = 'L346OK'
const PROMPT = `print the uppercase of the word ${MARK.toLowerCase()} and nothing else`

await tidySession()
const app = await startApp({ name: 'm6-scenario' })
const workspaceId = await firstWorkspaceId(app)
const timeline = []
const shots = []

const mark = async (label, note = {}) => {
  const shot = await app.shot(label)
  shots.push({ seq: shot.seq, at: shot.at, label, file: shot.file })
  timeline.push({ at: Date.now(), step: label, ...note })
  return shot
}

const startedAt = Date.now()
await mark('01-before')

// ── ① 새 행 (claude) ──────────────────────────────────────────────────────
const before = new Set((await herdrTruth()).tabs)
await createRowByUi(app, workspaceId, 'claude')
await mark('02-created')
const tabId = (
  await until(async () => (await herdrTruth()).tabs.find((id) => !before.has(id)) ?? null, { what: '새 탭', everyMs: 60 })
).value
const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null

// ── ② 기동을 **관측**으로 확인 ────────────────────────────────────────────
const up = await until(
  async () => (await paneProcesses(paneId)).foreground.find((item) => (item.argv0 ?? '') === 'claude') ?? null,
  { what: 'claude 기동', timeoutMs: 60000, everyMs: 400 },
)
await mark('03-launched', { paneId, cmdline: up.value?.cmdline ?? null, ms: up.ms })

// ── ③ 터미널이 붙었나 (N9) ────────────────────────────────────────────────
const attached = await until(
  async () => {
    const state = await app.state()
    return state.terminal.paneId === paneId && state.terminal.alive && state.terminal.frames > 0 ? state.terminal : null
  },
  { what: '터미널 부착', timeoutMs: 30000, everyMs: 200 },
)
// claude 의 TUI 가 입력을 받을 준비가 될 때까지 — 화면에 프롬프트 상자가 그려지는 것으로 본다.
const ready = await until(async () => (await app.find('bypass permissions')).found || (await app.find('for shortcuts')).found, {
  what: 'claude 입력 준비',
  timeoutMs: 60000,
  everyMs: 500,
})
await mark('04-attached', { frames: attached.value?.frames ?? null, grid: attached.value?.grid ?? null, readyMs: ready.ms })

// ── ④ 프롬프트 한 번 왕복 ─────────────────────────────────────────────────
const typedAt = Date.now()
// 한 글자씩 실제 키로 친다. 공백도 **글자로** 보낸다 — `Space` 라는 이름으로 보내면
// control.ts 가 char 이벤트를 안 만들어 화면에 공백이 안 찍힌다 (1회차 화면이 그랬다).
for (const ch of PROMPT) {
  await app.key(ch)
}
await mark('05-typed')
await app.key('Enter')
const answered = await until(async () => (await app.find(MARK)).found, { what: '응답', timeoutMs: 180000, everyMs: 500 })
// 화면을 그대로 떠서 원자료에 싣는다 — "봤다" 를 사람이 다시 확인할 수 있어야 한다.
const screen = (await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })).read.text
await mark('06-answered', { ms: answered.ms, typedAt })

// ── ⑤ 선택된 행을 종료 (N9 추가 · A1) ─────────────────────────────────────
const processes = await paneProcesses(paneId)
const agentPid = up.value?.pid ?? null
await clickWhenVisible(app, `[data-close-tab="${tabId}"]`)
await until(async () => (await app.query('[data-modal="close-confirm"]')).found.length > 0, {
  what: '확인 모달',
  everyMs: 100,
})
await sleep(300)
await mark('07-confirm')
await clickWhenVisible(app, '[data-confirm="close"]')
// A1 — 누른 뒤 ~0.65초 동안 화면이 멈춘 것처럼 보이면 안 된다. "종료 중…" 을 **보는 것**이 근거다.
// (빈 배열은 truthy 다 — 1회차에 그대로 돌려줘서 "0ms 에 봤다" 로 적혔다. 길이를 본다.)
const closingBadge = await until(
  async () => {
    const found = (await app.query(`[data-closing="${tabId}"]`)).found
    return found.length > 0 ? found : null
  },
  { what: '종료 중 표시', timeoutMs: 5000, everyMs: 40 },
)
await mark('08-closing', { 종료중표시: closingBadge.value ?? null, 표시까지ms: closingBadge.ms })

const dead = await until(() => !alive(processes.shellPid) && !alive(agentPid), { what: 'PID 사멸', everyMs: 25 })
const gone = await until(
  async () => !(await app.state()).workspaces.some((row) => row.tabs.some((tab) => tab.tabId === tabId)),
  { what: '목록에서 사라짐', everyMs: 40 },
)
await sleep(600)
await mark('09-closed')

const finalState = await app.state()
const out = {
  at: new Date().toISOString(),
  전체ms: Date.now() - startedAt,
  tabId,
  paneId,
  n10: {
    통과선: 'Orca 없이 corral 안에서만 생성 → 입력 → 응답 → 종료 → 목록에서 사라짐',
    생성: true,
    기동관측ms: up.ms,
    기동cmdline: up.value?.cmdline ?? null,
    프롬프트: PROMPT,
    응답표식: MARK,
    응답까지ms: answered.ok ? answered.ms : null,
    응답봄: answered.ok,
    /** 응답 순간의 pane 화면 전문 — 에코가 아니라 대답인지 사람이 다시 볼 수 있게 */
    응답시점화면: screen.split('\n').filter((line) => line.trim().length > 0).slice(-14),
    프롬프트에표식있나: PROMPT.includes(MARK),
    목록에서사라짐ms: gone.ok ? gone.ms : null,
    herdr최종: await herdrTruth(),
  },
  n9: {
    터미널부착ms: attached.ms,
    프레임수: attached.value?.frames ?? null,
    격자: attached.value?.grid ?? null,
    입력준비ms: ready.ms,
    /** 선택돼 있던 행을 종료한 뒤 터미널 표면 — 죽은 화면을 산 것처럼 두지 않는다 */
    종료후: {
      paneId: finalState.terminal.paneId,
      alive: finalState.terminal.alive,
      deadReason: finalState.terminal.deadReason,
      inputBlocked: finalState.terminal.inputBlocked,
      선택: finalState.selectedPaneId,
    },
  },
  a1: { 종료중표시: closingBadge.value ?? null, 표시까지ms: closingBadge.ms, 사멸까지ms: dead.ms },
  샷: shots,
  타임라인: timeline,
}
console.log(JSON.stringify({ n10: out.n10, n9종료후: out.n9.종료후, a1: out.a1 }, null, 2))

out.클릭증거 = clickLog()
writeRaw('n10-scenario.json', out)
await app.stop()
await tidySession()
