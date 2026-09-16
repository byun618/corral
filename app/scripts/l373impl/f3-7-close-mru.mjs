// F3-7 · F3-7b — `⌘W`(main 이 삼키는 키)와 MRU 홀드가 **붙어 있을 때** 서로를 막나 (§10-R26-2).
//
//   F3-7   `⌘W` 로 pane 을 닫은 **직후** `⌃Tab` 홀드 → `Tab` 이동 → **`Control` keyup 확정**. 3/3
//   F3-7b  역순 — MRU 확정 **직후** `⌘W` 가 pane 을 닫는다. 3/3
//
// 왜 재나: `⌘W` 는 main 의 `before-input-event` 에서 `preventDefault()` 로 삼킨다. 그 순간
// Chromium 은 `suppress_events_until_keydown_` 를 세워 **다음 keyDown 까지 모든 키 이벤트를
// 버린다**(R26-1 실측). 이론상 그 다음 keyDown(`⌃Tab`)이 억제를 풀지만 — 이 일감에서 이론이
// 실측에 진 사례가 이미 여럿이라 그대로 재 본다. 반대 방향(F3-7b)은 확정 직후의 `⌘W` 다.
//
// 키는 **`sendInputEvent`(제어 채널 `key`)로만** 보낸다. 홀드는 누름/뗌을 따로 보내 만든다.
// 격리: `life373-` 세션 전용. M0(내 유령)·M0-b(종료 후).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, press, quiesce } from './app-steps.mjs'
import { ensureWorkspace, layout as herdrLayout, m0End, m0Start, paneList, resetPanes, tabList, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f37-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
/** 붙어 있음을 재는 값 — `⌘W` 와 다음 키 사이의 간격. 사람 손보다 짧다(최악을 본다). */
const 붙는간격MS = 60
const ROUNDS = 3

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 붙는간격MS, F3_7: [], F3_7b: [] }

/** 키 하나 — 진짜 입력 경로. `type` 을 주면 누름/뗌 한쪽만 보낸다. */
const tap = async (app, keyCode, modifiers = [], settle = 400, type = 'keyDown') => {
  const sent = await app.send({ cmd: 'key', keyCode, modifiers, type })
  await sleep(settle)
  return sent
}
/** `Control` 을 놓는다 — 홀드의 확정 신호. 누름은 안 보낸다(이미 쥐고 있는 셈이다). */
const release = (app, settle = 1200) => tap(app, 'Control', [], settle, 'keyUp')
/** `⌘W` — 누름·뗌을 같이 보낸다(기본값). main 이 삼키는 그 키다. */
const closePane = (app, settle = 붙는간격MS) => tap(app, 'W', ['meta'], settle, undefined)

const mruView = async (app) =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const box = document.querySelector('[data-mru]')
        return {
          열림: box !== null,
          줄수: box === null ? 0 : box.querySelectorAll('[data-mru-row]').length,
          선택: box === null ? null : (box.querySelector('[data-mru-selected="true"]')?.dataset.mruRow ?? null),
          선택번호: box === null ? null : (box.querySelector('[data-mru-selected="true"]')?.dataset.mruIndex ?? null),
        }
      })()`,
    })
  ).result

/** 화면이 지금 가리키는 pane — **활성 영역 안에서** 읽는다 (영역마다 표시가 하나씩 있다). */
const 화면포커스 = async (app) =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const active = document.querySelector('.tab-group.is-active-group')
        const node = (active === null ? null : active.querySelector('[data-pane-selected="true"]'))
          ?? document.querySelector('[data-pane-selected="true"]')
        return {
          선택: node === null ? null : node.dataset.termPaneBox,
          활성영역: active === null ? null : active.dataset.tabGroup,
          화면pane수: document.querySelectorAll('[data-term-pane-box]').length,
        }
      })()`,
    })
  ).result

const 오라클 = () => ({ pane수: paneList().length, 탭수: tabList().length, focused: herdrLayout().focused_pane_id })

결과.workspace = ensureWorkspace()
결과.초기화 = await resetPanes()
const app = await startApp({ name: 'f3-7', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(800)
await quiesce(app)

// --- 준비 — 탭 2개 · pane 여러 개 (닫아도 MRU 목록이 2줄 이상 남아야 한다) ----------------
await press(app, { key: 't' })
await sleep(2500)
await press(app, { key: 'd' })
await sleep(1500)
await press(app, { key: 'd', shift: true })
await sleep(1500)
await quiesce(app)
결과.준비 = { 오라클: 오라클(), 화면: await 화면포커스(app) }
console.log('# 준비', JSON.stringify(결과.준비))

/**
 * 회차마다 pane 이 하나씩 닫히므로 **앱이 보는 pane** 을 3 이상, 탭을 2 이상으로 채운다.
 *
 * 세션 전체 pane 수(제3 오라클)로 세면 안 된다 — 격리 세션에는 앱이 안 여는 workspace(`/tmp`)
 * 도 살아서, 앱 쪽 목록이 1줄로 말라도 오라클은 3을 넘는다(1회차에서 그렇게 말랐다).
 */
const 앱탭들 = (state) => state.repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])
async function 보충(app) {
  for (let 안전 = 0; 안전 < 4; 안전++) {
    const 탭 = 앱탭들(await app.state())
    const pane수 = 탭.flatMap((t) => t.panes).length
    if (탭.length >= 2 && pane수 >= 3) return { 탭수: 탭.length, pane수 }
    await press(app, { key: 탭.length < 2 ? 't' : 'd' })
    await sleep(2500)
    await quiesce(app)
  }
  const 탭 = 앱탭들(await app.state())
  return { 탭수: 탭.length, pane수: 탭.flatMap((t) => t.panes).length }
}

// --- F3-7 — `⌘W` 직후 홀드가 살아 있나 --------------------------------------------------
console.log('\n## F3-7 — ⌘W 직후 ⌃Tab 홀드 → Control keyup 확정')
for (let round = 1; round <= ROUNDS; round++) {
  const 채움 = await 보충(app)
  const 전 = { 오라클: 오라클(), 채움, 화면: await 화면포커스(app) }
  await closePane(app) // ⌘W — 붙는간격MS 만 기다린다
  const 닫은직후 = { 오라클: 오라클(), 화면: await 화면포커스(app) }
  await tap(app, 'Tab', ['control'], 900) // 홀드 시작 (keyDown 만)
  const 열림 = await mruView(app)
  await tap(app, 'Tab', ['control'], 500) // 한 줄 이동
  const 이동 = await mruView(app)
  await release(app)
  const 확정뒤 = { 목록: await mruView(app), 화면: await 화면포커스(app), 오라클: 오라클() }
  const row = {
    round,
    전,
    닫은직후,
    // 닫혔는지는 **회차 끝에서** 센다 — `⌘W` 직후 60ms 표본은 닫힘이 화면·세션에 퍼지기 전이다
    // (S6 실측: 수렴 중앙 205ms · 최대 775ms). `닫은직후` 는 그 창의 기록으로 남긴다.
    닫혔나: 확정뒤.오라클.pane수 === 전.오라클.pane수 - 1,
    열렸나: 열림.열림,
    이동했나: 열림.선택번호 !== null && 이동.선택번호 !== null && 이동.선택번호 !== 열림.선택번호,
    확정대상: 이동.선택,
    확정뒤,
    확정됐나: 확정뒤.목록.열림 === false && 이동.선택 !== null && 확정뒤.화면.선택 === 이동.선택,
    열림,
    이동,
  }
  결과.F3_7.push(row)
  console.log(
    `  ${round}/${ROUNDS} | 닫힘 ${row.닫혔나} | 목록 ${row.열렸나} | 이동 ${row.이동했나} | keyup 확정 ${row.확정됐나} (${row.확정대상} → ${확정뒤.화면.선택})`,
  )
  await sleep(800)
}

// --- F3-7b — 확정 직후 `⌘W` 가 pane 을 닫나 ----------------------------------------------
console.log('\n## F3-7b — MRU 확정 직후 ⌘W')
for (let round = 1; round <= ROUNDS; round++) {
  const 채움 = await 보충(app)
  const 전 = { 오라클: 오라클(), 채움, 화면: await 화면포커스(app) }
  await tap(app, 'Tab', ['control'], 700)
  const 열림 = await mruView(app)
  await tap(app, 'Tab', ['control'], 500)
  const 이동 = await mruView(app)
  await release(app, 붙는간격MS) // 확정하고 **바로** ⌘W 로 간다
  const 확정직후 = { 화면: await 화면포커스(app), 목록: await mruView(app) }
  await closePane(app, 1500)
  await quiesce(app)
  const 뒤 = { 오라클: 오라클(), 화면: await 화면포커스(app) }
  const row = {
    round,
    전,
    확정대상: 이동.선택,
    확정직후,
    확정됐나: 확정직후.목록.열림 === false && 이동.선택 !== null && 확정직후.화면.선택 === 이동.선택,
    뒤,
    닫혔나: 뒤.오라클.pane수 === 전.오라클.pane수 - 1,
  }
  결과.F3_7b.push(row)
  console.log(`  ${round}/${ROUNDS} | 확정 ${row.확정됐나} (${row.확정대상}) | 직후 ⌘W 닫힘 ${row.닫혔나} (pane ${전.오라클.pane수} → ${뒤.오라클.pane수})`)
  await sleep(800)
}

결과.판정 = {
  'F3-7_확정': `${결과.F3_7.filter((r) => r.확정됐나).length}/${ROUNDS}`,
  'F3-7_닫힘': `${결과.F3_7.filter((r) => r.닫혔나).length}/${ROUNDS}`,
  'F3-7_목록열림': `${결과.F3_7.filter((r) => r.열렸나).length}/${ROUNDS}`,
  'F3-7b_확정': `${결과.F3_7b.filter((r) => r.확정됐나).length}/${ROUNDS}`,
  'F3-7b_닫힘': `${결과.F3_7b.filter((r) => r.닫혔나).length}/${ROUNDS}`,
}
console.log('\n판정', JSON.stringify(결과.판정))

await app.stop()
await sleep(1500)
결과.M0_끝 = m0End()
결과.끝오라클 = 오라클()
writeRaw('f3-7-close-mru.json', 결과)
console.log('wrote raw/claude/f3-7-close-mru.json')
