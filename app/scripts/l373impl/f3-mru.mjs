// F3 통과선 — `⌃Tab` MRU 전환이 실제로 도나 (LIFE-373 ③). 화면에서 본 것만 적는다.
//
//   ⓐ F3-1 캡처        — xterm 에 포커스가 있어도 `⌃Tab` 이 잡힌다 (main `before-input-event`)
//   ⓑ F3-2 홀드 이동   — `Tab`/`⇧Tab` 이 wrap 하고, `Control` keyup 이 확정한다
//   ⓒ F3-2 Enter 확정 · Esc 취소
//   ⓓ F3-5 취소 무결성 — 취소 전후 상태 스냅숏(화면 + 제3 오라클)이 **완전히 같다**
//   ⓔ F3-3 폴백       — `Control` 유실(=control 없는 keydown) · 무동작 타임아웃 · 창 blur
//   ⓕ F3-6 키 유출    — 홀드 중 **페이지가 키를 하나도 못 본다** + 홀드 전후 pane 내용·히스토리 불변
//   ⓖ F3-4 단위·범위  — 목록이 pane 단위이고 상한이 12 인가
//
// **키는 `sendInputEvent` 로만 보낸다** (제어 채널 `key`). 합성 `KeyboardEvent` 는 신뢰 이벤트가
// 아니라 브라우저 기본 동작을 안 거치고, `⌘W` 처럼 메뉴가 쥔 키는 아예 재지 못한다.
// 홀드는 **누름과 뗌을 따로** 보내 만든다 (`type` 인자, R5 에 diff 있음):
//   · `⌃Tab` = keyDown Tab(control) 만. 뗌을 붙여 보내면 홀드가 한 걸음마다 끊긴다
//   · 놓기   = keyUp Control 하나 — **이 뗌이 확정 신호**다 (F3-2)
//
// 격리: `life373-` 세션 전용. M0: 유령 앱 0 에서만 유효하다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, focusedPane, press, quiesce } from './app-steps.mjs'
import { layout as herdrLayout, m0End, m0Start, paneList, resetPanes, tabList, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f3-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const MARKER = 'echo LIFE373-MRU-LEAK'
const HISTORY = path.join(os.homedir(), '.zsh_history')

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 단계: [] }

/** control 소켓으로 pane 화면을 읽는다 — 평문이라 `ctl` 을 안 쓴다 (제3 오라클). */
const paneText = (paneId, lines = 40) =>
  execFileSync('herdr', ['--session', SESSION, 'pane', 'read', paneId, '--format', 'text', '--lines', String(lines)], {
    encoding: 'utf8',
  })

/** 셸 히스토리 지문 — 크기·mtime·마지막 줄. 유출된 `Enter` 는 여기 자국을 남긴다. */
function historyFingerprint() {
  try {
    const stat = fs.statSync(HISTORY)
    const tail = fs.readFileSync(HISTORY, 'utf8').trimEnd().split('\n').at(-1) ?? ''
    return { 파일: HISTORY, 크기: stat.size, mtime: stat.mtimeMs, 마지막줄: tail.slice(-120) }
  } catch (error) {
    return { 파일: HISTORY, 없음: String(error instanceof Error ? error.message : error) }
  }
}

/** 키 하나 — 진짜 입력 경로. `type` 을 주면 누름/뗌 한쪽만 보낸다. */
async function tap(app, keyCode, modifiers = [], settle = 400, type = 'keyDown') {
  const sent = await app.send({ cmd: 'key', keyCode, modifiers, type })
  await sleep(settle)
  return sent
}
/** `Control` 을 놓는다 — 홀드의 확정 신호. **누름은 안 보낸다**(이미 쥐고 있는 셈이다). */
const release = (app, settle = 1500) => tap(app, 'Control', [], settle, 'keyUp')

/** 홀드 중 화면 — 목록이 떴나, 어느 줄이 골라졌나, 단서(칩)는 있나. */
async function mruView(app) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const box = document.querySelector('[data-mru]')
        const active = document.activeElement
        return {
          열림: box !== null,
          칩: document.querySelector('[data-mru-chip]') !== null,
          줄수: box === null ? 0 : box.querySelectorAll('[data-mru-row]').length,
          더있음: box === null ? null : (box.querySelector('.mru-more')?.textContent ?? null),
          선택: box === null ? null : (box.querySelector('[data-mru-selected="true"]')?.dataset.mruRow ?? null),
          선택번호: box === null ? null : (box.querySelector('[data-mru-selected="true"]')?.dataset.mruIndex ?? null),
          행: box === null ? [] : [...box.querySelectorAll('[data-mru-row]')].map((el) => ({
            번호: el.dataset.mruIndex,
            paneId: el.dataset.mruRow,
            고름: el.dataset.mruSelected === 'true',
            글자: el.textContent,
            위치글리프: el.querySelector('.mru-row-place')?.textContent ?? '',
            worktree: el.querySelector('.mru-row-worktree')?.textContent ?? '',
          })),
          포커스요소: active === null ? null : active.tagName + (active.className ? '.' + String(active.className).split(' ')[0] : ''),
        }
      })()`,
    })
  ).result
}

/** 화면 + 제3 오라클 상태 한 장 — F3-5 는 이 두 장이 **같기만** 하면 통과다. */
async function 상태스냅(app, label) {
  const 화면 = (
    await app.send({
      cmd: 'eval',
      code: `(() => ({
        선택pane: document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null,
        활성영역: document.querySelector('.tab-group.is-active-group')?.dataset.tabGroup ?? null,
        활성탭: [...document.querySelectorAll('.main-tab.is-active')].map((el) => el.dataset.mainTab),
        pane수: document.querySelectorAll('[data-term-pane-box]').length,
      }))()`,
    })
  ).result
  const 오라클 = {
    focused: herdrLayout().focused_pane_id,
    panes: paneList()
      .map((pane) => ({ id: pane.pane_id, tab: pane.tab_id, focused: pane.focused }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tabs: tabList()
      .map((tab) => ({ id: tab.tab_id, focused: tab.focused }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
  return { label, 화면, 오라클 }
}

/**
 * **xterm 이 키를 봤나** — 감시자를 xterm 의 textarea 에 직접 단다 (F3-6 의 화면 쪽 끝).
 *
 * document 에 달면 안 된다: 홀드 핸들러도 document 캡처라 **설계상** 거기까지는 키가 온다.
 * PTY 로 가는 문은 그 아래 textarea 이고, 캡처에서 `stopPropagation()` 하면 여기에 안 닿는다.
 * 감시자는 캡처·버블 둘 다 단다 — 어느 쪽으로든 닿으면 잡힌다.
 */
const 키감시시작 = (app) =>
  app.send({
    cmd: 'eval',
    code: `(() => {
      window.__l373keys = []
      const push = (event) => window.__l373keys.push({ key: event.key, ctrl: event.ctrlKey, phase: event.eventPhase })
      const nodes = [...document.querySelectorAll('.xterm-helper-textarea')]
      for (const node of nodes) {
        if (node.__l373 === true) continue
        node.__l373 = true
        node.addEventListener('keydown', push, true)
        node.addEventListener('keydown', push, false)
      }
      return nodes.length
    })()`,
  })
const 키감시읽기 = async (app) => (await app.send({ cmd: 'eval', code: '(() => window.__l373keys ?? null)()' })).result

/** 그 pane 을 품은 탭 — 전체 worktree 를 훑는다 (확정 대상이 다른 worktree 에 있을 수 있다). */
const 주인탭 = (state, paneId) =>
  state.repos
    .flatMap((repo) => repo.worktrees)
    .flatMap((worktree) => worktree.workspace?.tabs ?? [])
    .find((tab) => tab.panes.some((pane) => pane.paneId === paneId))?.tabId ?? null

const 기록 = (label, data) => {
  결과.단계.push({ label, at: new Date().toISOString(), ...data })
  console.log('#', label, JSON.stringify(data).slice(0, 300))
}

결과.초기화 = await resetPanes()

const app = await startApp({ name: 'f3-mru', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(800)
await quiesce(app)

// --- 준비: pane 2 + 탭 2 = MRU 목록 3줄 이상 -----------------------------------------
await press(app, { key: 'd' }) // ⌘D — 이 탭 안에서 우분할
await sleep(1500)
await press(app, { key: 't' }) // ⌘T — 빈 탭 (새 pane 이 선택된다)
await sleep(2500)
await quiesce(app)
결과.준비 = { pane: paneList().map((p) => ({ id: p.pane_id, tab: p.tab_id })), 탭: tabList().map((t) => t.tab_id) }
기록('준비', 결과.준비)
await app.shot('f3-a-setup')

// --- ⓐ F3-1 캡처 (xterm 포커스 상태에서) ---------------------------------------------
{
  const before = await focusedPane(app)
  await 키감시시작(app)
  await tap(app, 'Tab', ['control'], 700)
  const view = await mruView(app)
  기록('ⓐ F3-1 ⌃Tab 캡처', { 포커스였던곳: before, 목록: view, xterm이본키: await 키감시읽기(app) })
  await app.shot('f3-b-open')
  결과.F3_1 = { 열렸나: view.열림, 칩: view.칩, 처음선택: view.선택번호, 포커스였던곳: before }
}

// --- ⓑ F3-2 홀드 이동 + Control keyup 확정 -------------------------------------------
{
  const 자취 = [await mruView(app)]
  for (let i = 0; i < 3; i++) {
    await tap(app, 'Tab', ['control'])
    자취.push(await mruView(app))
  }
  await tap(app, 'Tab', ['control', 'shift'])
  자취.push(await mruView(app))
  const 확정대상 = 자취.at(-1).선택
  await release(app)
  const after = await 상태스냅(app, 'Control keyup 확정 뒤')
  const view = await mruView(app)
  결과.F3_2 = {
    자취: 자취.map((row) => ({ 번호: row.선택번호, paneId: row.선택, 줄수: row.줄수 })),
    확정대상,
    닫혔나: !view.열림,
    확정됐나: after.화면.선택pane === 확정대상,
    확정뒤: after,
  }
  기록('ⓑ F3-2 이동·확정', 결과.F3_2)
  await app.shot('f3-c-commit')
}

// --- ⓒ·ⓓ F3-5 취소 무결성 (Esc) ------------------------------------------------------
{
  const before = await 상태스냅(app, '취소 전')
  await tap(app, 'Tab', ['control'], 700)
  await tap(app, 'Tab', ['control'])
  const 홀드중 = await mruView(app)
  await 키감시시작(app)
  await tap(app, 'Escape', ['control'], 1200)
  const after = await 상태스냅(app, '취소 뒤')
  const view = await mruView(app)
  결과.F3_5 = {
    전: before,
    홀드중: { 선택번호: 홀드중.선택번호, 선택: 홀드중.선택 },
    후: after,
    닫혔나: !view.열림,
    상태변화0: JSON.stringify(before.화면) === JSON.stringify(after.화면) && JSON.stringify(before.오라클) === JSON.stringify(after.오라클),
    포커스돌아옴: (await focusedPane(app)).포커스pane,
    xterm이본키: await 키감시읽기(app),
  }
  기록('ⓒⓓ F3-5 Esc 취소', 결과.F3_5)
  // 홀드는 끝났다 — 남은 Control 은 없다(Esc 로 끝냈다). 다음 단계가 깨끗하게 시작한다.
}

// --- ⓒ Enter 확정 ---------------------------------------------------------------------
{
  await tap(app, 'Tab', ['control'], 700)
  const 홀드중 = await mruView(app)
  await tap(app, 'Enter', ['control'], 1500)
  const after = await 상태스냅(app, 'Enter 확정 뒤')
  결과.F3_2_enter = {
    대상: 홀드중.선택,
    닫혔나: !(await mruView(app)).열림,
    확정됐나: after.화면.선택pane === 홀드중.선택,
    확정뒤: after,
  }
  기록('ⓒ Enter 확정', 결과.F3_2_enter)
}

// --- ⓔ F3-3 폴백 ① Control 유실 -------------------------------------------------------
{
  await tap(app, 'Tab', ['control'], 700)
  const 홀드중 = await mruView(app)
  await 키감시시작(app)
  // `Control` 이 빠진 keydown — main 이 "keyup 을 놓쳤다"로 읽고 확정해야 한다.
  await tap(app, 'A', [], 1500)
  결과.F3_3_유실 = {
    대상: 홀드중.선택,
    닫혔나: !(await mruView(app)).열림,
    확정됐나: (await 상태스냅(app, 'Control 유실 확정')).화면.선택pane === 홀드중.선택,
    xterm이본키: await 키감시읽기(app),
  }
  기록('ⓔ F3-3 Control 유실 폴백', 결과.F3_3_유실)
}

// --- ⓔ F3-3 폴백 ② 창 blur --------------------------------------------------------------
//
// **두 갈래를 갈라 잰다.** ⓐ `blur` 이벤트가 오면 취소되는가(핸들러가 붙어 있고 도는가) —
// 합성 이벤트로 잰다. ⓑ **진짜 OS blur** 가 그 이벤트를 만드는가 — 창이 OS key window 가
// 안 되는 환경이라(§10-R24-1) 이 하네스로는 못 만든다. 둘을 한 칸에 적으면 공백이 숨는다.
{
  const before = await 상태스냅(app, 'blur 전')
  await tap(app, 'Tab', ['control'], 700)
  const 홀드중 = (await mruView(app)).열림
  const 진짜 = await app.send({ cmd: 'eval', code: '(() => { window.blur(); return document.hasFocus() })()' })
  await sleep(1200)
  const 진짜뒤 = !(await mruView(app)).열림
  if (!진짜뒤) await app.send({ cmd: 'eval', code: `(() => { window.dispatchEvent(new Event('blur')); return 1 })()` })
  await sleep(1200)
  const after = await 상태스냅(app, 'blur 뒤')
  결과.F3_3_blur = {
    홀드가열렸었나: 홀드중,
    진짜blur로닫혔나: 진짜뒤,
    문서포커스: 진짜.result,
    합성blur로닫혔나: !(await mruView(app)).열림,
    상태변화0: JSON.stringify(before.화면) === JSON.stringify(after.화면),
    비고: '진짜 OS blur 는 이 하네스가 못 만든다 (R24-1 — 터미널에서 띄운 창이 OS key window 가 안 된다). 합성 이벤트는 **핸들러가 도는지**까지만 말한다',
  }
  기록('ⓔ F3-3 blur 폴백', 결과.F3_3_blur)
  if (!결과.F3_3_blur.합성blur로닫혔나) await tap(app, 'Escape', ['control'], 800)
}

// --- ⓕ F3-6 키 유출 --------------------------------------------------------------------
{
  const focused = paneList().find((pane) => pane.focused) ?? paneList()[0]
  // 프롬프트에 **실행되면 티 나는 줄**을 올려 둔다 (R15 가 말한 바로 그 자리) — Enter 는 안 보낸다.
  execFileSync('herdr', ['--session', SESSION, 'pane', 'send-text', focused.pane_id, MARKER])
  await sleep(1200)
  const ids = paneList().map((pane) => pane.pane_id)
  const 전 = Object.fromEntries(ids.map((id) => [id, paneText(id)]))
  const 히스토리전 = historyFingerprint()
  await 키감시시작(app)

  // 홀드 A — Tab · ⇧Tab · Esc
  await tap(app, 'Tab', ['control'], 700)
  await tap(app, 'Tab', ['control'])
  await tap(app, 'Tab', ['control', 'shift'])
  await tap(app, 'Escape', ['control'], 1000)
  // 홀드 B — Tab · Enter (**프롬프트 줄이 실행되면 여기서 실행된다**)
  await tap(app, 'Tab', ['control'], 700)
  await tap(app, 'Enter', ['control'], 1800)

  const xterm이본키 = await 키감시읽기(app)
  await sleep(1200)
  const 후 = Object.fromEntries(ids.map((id) => [id, paneText(id)]))
  const 히스토리후 = historyFingerprint()
  const 바뀐pane = ids.filter((id) => 전[id] !== 후[id])
  결과.F3_6 = {
    마커: MARKER,
    마커pane: focused.pane_id,
    xterm이본키,
    xterm키0: Array.isArray(xterm이본키) && xterm이본키.length === 0,
    바뀐pane,
    pane내용동일: 바뀐pane.length === 0,
    히스토리전,
    히스토리후,
    히스토리불변: JSON.stringify(히스토리전) === JSON.stringify(히스토리후),
    마커살아있나: (후[focused.pane_id] ?? '').includes('LIFE373-MRU-LEAK'),
  }
  기록('ⓕ F3-6 키 유출', {
    xterm키0: 결과.F3_6.xterm키0,
    pane내용동일: 결과.F3_6.pane내용동일,
    히스토리불변: 결과.F3_6.히스토리불변,
  })
  await app.shot('f3-d-leak')
  // 프롬프트 줄은 지우고 나간다 — 남겨 두면 다음 사람이 모르고 Enter 를 친다.
  try {
    execFileSync('herdr', ['--session', SESSION, 'pane', 'send-text', focused.pane_id, '\u0015'])
  } catch (error) {
    결과.F3_6.정리실패 = String(error instanceof Error ? error.message : error)
  }
}

// --- ⓖ F3-4 단위·범위 -------------------------------------------------------------------
{
  await tap(app, 'Tab', ['control'], 700)
  const view = await mruView(app)
  const 오라클pane = paneList().length
  결과.F3_4 = {
    줄수: view.줄수,
    상한12: view.줄수 <= 12,
    더있음: view.더있음,
    오라클pane수: 오라클pane,
    // pane 단위인가 — 줄마다 다른 paneId 이고, 그 id 가 전부 herdr 의 pane 이다.
    전부pane인가: view.행.every((row) => paneList().some((pane) => pane.pane_id === row.paneId)),
    행: view.행,
  }
  기록('ⓖ F3-4 단위·범위', { 줄수: view.줄수, 오라클pane수: 오라클pane, 상한12: 결과.F3_4.상한12 })
  await app.shot('f3-e-list')
  await tap(app, 'Escape', ['control'], 800)
}

// --- ⓗ R3-i 다른 worktree 확정 — worktree 전환 후 reveal ----------------------------------
//
// 목록은 **열려 있는 모든 worktree** 를 본다 (F3-4 전체 범위). 두 번째 worktree 를 열어
// `⇄` 행이 서는지, 그 행을 확정하면 화면이 그 worktree 로 갈아끼워지는지 본다.
{
  const 열기전 = await app.state()
  const 후보 = 열기전.repos.flatMap((repo) => repo.worktrees).find((worktree) => worktree.workspace === null)
  if (후보 === undefined) {
    결과.R3_i = { 못쟀다: '열 수 있는 다른 worktree 가 없다 (이 레포에 worktree 가 하나뿐)' }
    기록('ⓗ R3-i', 결과.R3_i)
  } else {
    const 처음worktree = 열기전.repos
      .flatMap((repo) => repo.worktrees)
      .find((worktree) => worktree.workspace !== null)
    await app.click(`[data-worktree="${후보.path}"]`)
    await sleep(4000)
    await quiesce(app)
    // 새 worktree 에 탭이 없으면 하나 만든다 — pane 이 있어야 목록에 선다.
    let 새workspace = (await app.state()).repos
      .flatMap((repo) => repo.worktrees)
      .find((worktree) => worktree.path === 후보.path)?.workspace ?? null
    if (새workspace !== null && 새workspace.tabs.length === 0) {
      await press(app, { key: 't' })
      await sleep(3000)
      새workspace = (await app.state()).repos
        .flatMap((repo) => repo.worktrees)
        .find((worktree) => worktree.path === 후보.path)?.workspace ?? null
    }
    // 원래 worktree 로 되돌아간다 — 거기서 `⇄` 행을 봐야 한다.
    await app.click(`[data-worktree="${처음worktree.path}"]`)
    await sleep(2500)
    await quiesce(app)
    const 되돌아온뒤 = await 상태스냅(app, '되돌아온 뒤')
    // 홀드를 열고 `⇄` 행까지 간다.
    await tap(app, 'Tab', ['control'], 700)
    let view = await mruView(app)
    const 목표 = view.행.find((row) => row.위치글리프 === '⇄') ?? null
    let 걸음 = 0
    while (목표 !== null && view.선택 !== 목표.paneId && 걸음 < view.줄수 + 1) {
      await tap(app, 'Tab', ['control'])
      view = await mruView(app)
      걸음 += 1
    }
    const 확정전 = await mruView(app)
    await release(app)
    await sleep(2500)
    const 확정뒤 = await 상태스냅(app, 'R3-i 확정 뒤')
    const 끝상태 = await app.state()
    결과.R3_i = {
      연worktree: 후보.path,
      되돌아온뒤,
      다른worktree행: 목표,
      확정대상: 확정전.선택,
      확정뒤,
      // **확정 뒤 화면이 그 pane 의 worktree 인가** — 그 pane 을 품은 탭이 화면의 활성 탭이 되고
      // 선택 pane 도 그것이면, 화면 전체가 그 worktree 의 배치로 갈아끼워졌다는 뜻이다 (R3-i).
      그pane의탭: 주인탭(끝상태, 확정전.선택),
      활성탭: 확정뒤.화면.활성탭,
      선택pane: 확정뒤.화면.선택pane,
      열린worktree수: 끝상태.repos.flatMap((repo) => repo.worktrees).filter((worktree) => worktree.workspace !== null).length,
      확정됐나: 확정뒤.화면.선택pane === 확정전.선택,
      reveal됐나: 확정뒤.화면.활성탭.includes(주인탭(끝상태, 확정전.선택) ?? '\u0000'),
    }
    기록('ⓗ R3-i 다른 worktree 확정', {
      다른worktree행: 목표?.paneId ?? null,
      확정대상: 확정전.선택,
      확정됐나: 결과.R3_i.확정됐나,
      reveal됐나: 결과.R3_i.reveal됐나,
      열린worktree수: 결과.R3_i.열린worktree수,
    })
    await app.shot('f3-f-cross-worktree')
    // 연 worktree 는 닫고 나간다 — 남기면 다음 런의 M0 가 흔들린다.
    if (새workspace !== null) {
      await app.send({ cmd: 'eval', code: '(() => 1)()' })
      결과.R3_i.닫기 = await (async () => {
        try {
          execFileSync('herdr', ['--session', SESSION, 'workspace', 'close', 새workspace.workspaceId])
          return '닫았다'
        } catch (error) {
          return String(error instanceof Error ? error.message : error)
        }
      })()
    }
  }
}

// --- ⓔ F3-3 폴백 ③ 무동작 타임아웃 (10초) ------------------------------------------------
{
  const before = await 상태스냅(app, '타임아웃 전')
  await tap(app, 'Tab', ['control'], 700)
  const 열렸나 = (await mruView(app)).열림
  await sleep(11_500)
  const after = await 상태스냅(app, '타임아웃 뒤')
  결과.F3_3_타임아웃 = {
    열렸나,
    닫혔나: !(await mruView(app)).열림,
    상태변화0: JSON.stringify(before.화면) === JSON.stringify(after.화면) && JSON.stringify(before.오라클) === JSON.stringify(after.오라클),
  }
  기록('ⓔ F3-3 타임아웃 폴백', 결과.F3_3_타임아웃)
}

결과.끝 = await 상태스냅(app, '끝')
결과.로그 = app.entries().filter((entry) => entry.tag === 'input.raw' || entry.tag === 'shortcut.intercepted')
await app.stop()
await sleep(1500)
결과.M0_끝 = m0End()
writeRaw('f3-mru.json', 결과)
console.log('\nF3 요약')
console.log(' F3-1 캡처   ', JSON.stringify(결과.F3_1))
console.log(' F3-2 이동·확정', 결과.F3_2?.닫혔나, 결과.F3_2?.확정됐나, '| Enter', 결과.F3_2_enter?.확정됐나)
console.log(' F3-3 폴백   ', '유실', 결과.F3_3_유실?.확정됐나, '| blur', 결과.F3_3_blur?.닫혔나, '| 타임아웃', 결과.F3_3_타임아웃?.닫혔나)
console.log(' F3-4 범위   ', 결과.F3_4?.줄수, '줄 / 오라클', 결과.F3_4?.오라클pane수)
console.log(' F3-5 취소   ', 결과.F3_5?.상태변화0)
console.log(' R3-i 다른 wt', 결과.R3_i?.확정됐나, '| reveal', 결과.R3_i?.reveal됐나, '| 열린 worktree', 결과.R3_i?.열린worktree수)
console.log(' F3-6 유출   ', 'xterm키0', 결과.F3_6?.xterm키0, '| pane동일', 결과.F3_6?.pane내용동일, '| 히스토리', 결과.F3_6?.히스토리불변)
