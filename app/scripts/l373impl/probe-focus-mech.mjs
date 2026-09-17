// F2-8 ⓑ **기전 실측** — 패딩 띠를 누르면 왜 키가 아무 데도 안 가나 (기준 §R33-2).
//
// 앞 회차(`f2-select.json`, 빌드 d74e801)에서 관측된 것: xterm **밖**(상자 패딩 띠)을 진짜
// 마우스로 누르면 `[data-pane-selected]` 는 옮겨가는데 `document.activeElement` 가 어느 pane
// 에도 없다. 기전에 대해 가설이 **둘** 서 있었고 둘이 서로를 부정한다:
//
//   ㉮ (구현자) `focusToken` 이 0 에 머물러 `TerminalPane` 의 포커스 effect 가 `if (focusToken
//      === 0) return` 에서 되돌아간다 → `term.focus()` 가 **아예 안 불린다**
//   ㉯ (코디네이터) `selectPane` 이 매번 `setFocusToken(t => t + 1)` 을 하고 `PaneLayout` 은
//      비선택 pane 에 `0` 을 넘기므로 선택되는 순간 `0 → N` 이다 → effect 는 **돌아야 한다**
//
// **둘을 가르는 관측은 "`focus()` 가 불렸나" 하나다.** 그래서 페이지에서 `HTMLElement.prototype.
// focus`·`blur` 를 감싸 호출을 전부 기록하고, `focusin`·`focusout`·`mousedown` 을 캡처 단계에서
// 같은 시계(performance.now)로 받아 **한 줄로 세운다**. 앱 코드는 안 고친다 — 고칠 자리를
// 정하려고 재는 것이라, 재려고 고치면 순환이다.
//
//   ㉮ 가 참이면: `focus()` 호출이 **없다**
//   ㉯ 가 참이면: `focus()` 호출이 **있고** 그 뒤 무엇이 포커스를 뺏는다 → 뺏는 걸음이 로그에 남는다
//
// 판별자 ⓑ(글자가 그 pane 에 도착하나)도 같이 잰다 — `[data-pane-selected]` 도 `activeElement`
// 도 판별자가 아니다(§R33-2). pane 마다 `window.corralPaneWrites()` 의 `lastSeq` 를 보고, 타건
// 없이 같은 시간을 기다린 **유휴 대조**를 먼저 잡아 저절로 오는 프레임과 구분한다.
//
// 격리: `life373-` 세션 전용. M0: 유령 앱 0 에서만 유효하다. 배터리 아님 — 회차 하나, 짧다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, quiesce } from './app-steps.mjs'
import { ensureWorkspace, m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-fxmech-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const OUT = process.env.L373_OUT ?? 'probe-focus-mech.json'

/** 페이지에 계측을 심는다 — 호출(`focus`·`blur`)과 이벤트를 같은 시계로 한 배열에 모은다. */
const 계측심기 = `(() => {
  if (window.__fx !== undefined) return '이미'
  const 이름 = (el) => {
    if (el === null || el === undefined) return null
    if (!(el instanceof Element)) return String(el)
    const box = el.closest('[data-term-pane-box]')
    const host = el.closest('[data-term-pane]')
    return {
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className : '',
      pane상자: box === null ? null : box.dataset.termPaneBox,
      xterm안: host !== null,
    }
  }
  const log = []
  window.__fx = { log, 이름 }
  const t = () => Math.round(performance.now() * 10) / 10
  const origFocus = HTMLElement.prototype.focus
  const origBlur = HTMLElement.prototype.blur
  HTMLElement.prototype.focus = function (...args) {
    log.push({ t: t(), 무엇: 'focus()호출', 대상: 이름(this) })
    return origFocus.apply(this, args)
  }
  HTMLElement.prototype.blur = function (...args) {
    log.push({ t: t(), 무엇: 'blur()호출', 대상: 이름(this) })
    return origBlur.apply(this, args)
  }
  for (const type of ['focusin', 'focusout']) {
    document.addEventListener(type, (e) => {
      log.push({ t: t(), 무엇: type, 대상: 이름(e.target), 상대: 이름(e.relatedTarget) })
    }, true)
  }
  document.addEventListener('mousedown', (e) => {
    log.push({ t: t(), 무엇: 'mousedown(캡처)', 대상: 이름(e.target) })
  }, true)
  document.addEventListener('mousedown', (e) => {
    log.push({ t: t(), 무엇: 'mousedown(버블끝)', 대상: 이름(e.target), 기본막힘: e.defaultPrevented })
  }, false)
  return '심었다'
})()`

const 비우기 = `(() => { const n = window.__fx.log.length; window.__fx.log.length = 0; return n })()`
const 읽기 = `(() => window.__fx.log.map((r) => r))()`

async function 화면(app) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const boxes = [...document.querySelectorAll('[data-term-pane-box]')]
        const active = document.activeElement
        const box = active === null ? null : active.closest('[data-term-pane-box]')
        return {
          선택: boxes.filter((el) => el.dataset.paneSelected === 'true').map((el) => el.dataset.termPaneBox),
          포커스: box === null ? null : box.dataset.termPaneBox,
          활성요소: active === null ? null : { tag: active.tagName.toLowerCase(), cls: typeof active.className === 'string' ? active.className : '' },
        }
      })()`,
    })
  ).result
}

/** pane 마다 프레임 도달 — `lastSeq` 가 오른 pane 이 글자를 받은 pane 이다. */
async function 프레임(app) {
  const rows =
    (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result ?? []
  const out = {}
  for (const row of rows) out[row.paneId] = { lastSeq: row.lastSeq, writes: row.writes.length }
  return out
}

function 델타(전, 후) {
  const out = {}
  for (const paneId of new Set([...Object.keys(전), ...Object.keys(후)])) {
    const a = 전[paneId] ?? { lastSeq: 0, writes: 0 }
    const b = 후[paneId] ?? { lastSeq: 0, writes: 0 }
    out[paneId] = { seq증가: b.lastSeq - a.lastSeq, write증가: b.writes - a.writes }
  }
  return out
}

/** `f2-select.mjs` 와 **같은 방식**으로 좌표를 고른다 (히트테스트 — 기하 추정 금지). */
async function 좌표(app, paneId) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const box = document.querySelector('[data-term-pane-box="${paneId}"]')
        if (box === null) return null
        const term = box.querySelector('[data-term-pane="${paneId}"]')
        const b = box.getBoundingClientRect()
        const tr = term === null ? null : term.getBoundingClientRect()
        const round = (n) => Math.round(n)
        let 밖 = null
        for (let dy = 1; dy < b.height - 1 && 밖 === null; dy += 2) {
          for (let dx = 1; dx < b.width - 1; dx += 2) {
            const x = round(b.left + dx), y = round(b.top + dy)
            const hit = document.elementFromPoint(x, y)
            if (hit === null) continue
            if (hit.closest('[data-term-pane-box]') !== box) continue
            if (hit.closest('[data-term-pane]') !== null) continue
            밖 = { x, y }
            break
          }
        }
        return {
          xterm위: tr === null ? null : { x: round(tr.left + tr.width / 2), y: round(tr.top + tr.height / 2) },
          xterm밖: 밖,
          밖점주인: 밖 === null ? null : (document.elementFromPoint(밖.x, 밖.y)?.closest('[data-term-pane-box]')?.dataset.termPaneBox ?? null),
        }
      })()`,
    })
  ).result
}

/**
 * 영역 **헤더 배경** 점 — 같은 기전이 여기도 있나 보려고 잰다 (F1-3 영역 전환 경로).
 *
 * `.main-tabbar` 도 포커스를 못 받는 div 이고 `onMouseDown={onActivate}` 가 붙어 있다. 탭·버튼
 * 위가 아닌 **배경** 점을 히트테스트로 고른다 — 탭을 누르면 탭 전환이 섞인다.
 */
async function 헤더좌표(app, groupId) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const bar = document.querySelector('[data-group-header="${groupId}"]')
        if (bar === null) return null
        const b = bar.getBoundingClientRect()
        const round = (n) => Math.round(n)
        for (let dx = b.width - 2; dx > 1; dx -= 2) {
          const x = round(b.left + dx), y = round(b.top + b.height / 2)
          const hit = document.elementFromPoint(x, y)
          if (hit === null) continue
          if (hit.closest('[data-main-tabbar]') !== bar) continue
          if (hit.closest('[data-main-tab]') !== null) continue
          if (hit.closest('button') !== null) continue
          return { x, y, 주인: hit.tagName.toLowerCase() + '.' + (typeof hit.className === 'string' ? hit.className : '') }
        }
        return null
      })()`,
    })
  ).result
}

async function 클릭좌표(app, { x, y }) {
  await app.send({ cmd: 'raw-mouse', type: 'mouseMove', x, y })
  await app.send({ cmd: 'raw-mouse', type: 'mouseDown', x, y, button: 'left' })
  await app.send({ cmd: 'raw-mouse', type: 'mouseUp', x, y, button: 'left' })
}

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 회차: [] }

ensureWorkspace()
결과.초기화 = await resetPanes()

const app = await startApp({ name: 'probe-focus-mech', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(800)
await quiesce(app)

// 한 영역 · pane 둘 — F2-8 이 재는 모양 그대로.
{
  const state = await app.state()
  const groupId = state.terminalGroups[0]?.groupId ?? null
  if (groupId === null) throw new Error('영역이 없다')
  await app.click(`[data-group-split-right="${groupId}"]`)
  await sleep(1600)
}
await quiesce(app)

const 상자들 = (
  await app.send({
    cmd: 'eval',
    code: `[...document.querySelectorAll('[data-term-pane-box]')].map((el) => el.dataset.termPaneBox)`,
  })
).result
if (상자들.length !== 2) throw new Error(`pane 둘에서 잰다 (지금 ${상자들.length})`)
const [p1, p2] = 상자들
결과.pane = { p1, p2 }
결과.계측 = (await app.send({ cmd: 'eval', code: 계측심기 })).result

/**
 * 회차 하나 — 누르고, 무엇이 불렸는지 읽고, **글자를 쳐서 어디로 가는지** 본다.
 *
 * 타건 전에 **유휴 대조**를 같은 길이로 먼저 잡는다: 셸이 저절로 프레임을 내면 그것이 도달로
 * 오해되므로, 타건 구간의 증가를 유휴 구간의 증가와 나란히 놓고 읽는다.
 */
async function 회차({ 이름, 대상, 지점, 마커, 좌표직접 = null }) {
  await quiesce(app)
  const 전화면 = await 화면(app)
  const coords = 좌표직접 === null ? await 좌표(app, 대상) : 좌표직접
  const at = 좌표직접 !== null ? 좌표직접 : 지점 === 'xterm위' ? coords?.xterm위 : coords?.xterm밖
  if (at === undefined || at === null) throw new Error(`${대상} 의 ${지점} 좌표를 못 구했다`)

  const 유휴전 = await 프레임(app)
  await sleep(1200)
  const 유휴후 = await 프레임(app)

  await app.send({ cmd: 'eval', code: 비우기 })
  await 클릭좌표(app, at)
  await sleep(60)
  const 직후활성 = await 화면(app)
  await sleep(500)
  const 후화면 = await 화면(app)
  const 로그 = (await app.send({ cmd: 'eval', code: 읽기 })).result

  const 타건전 = await 프레임(app)
  await app.send({ cmd: 'type', text: 마커 })
  await sleep(1200)
  const 타건후 = await 프레임(app)

  const 유휴델타 = 델타(유휴전, 유휴후)
  const 타건델타 = 델타(타건전, 타건후)
  // ⓑ 도착 판정: **대상 pane 만** 유휴 대조를 넘는 증가를 보여야 한다.
  const 받은pane = Object.entries(타건델타)
    .filter(([id, d]) => d.seq증가 > (유휴델타[id]?.seq증가 ?? 0))
    .map(([id]) => id)
  const row = {
    이름,
    대상,
    지점,
    좌표: at,
    밖점주인: coords.밖점주인 ?? null,
    전: 전화면,
    직후_60ms: 직후활성,
    후_560ms: 후화면,
    // ⓐ 배지
    배지옮겨갔나: 후화면.선택.length === 1 && 후화면.선택[0] === 대상,
    // ⓑ 키 — 판별자
    마커: 마커,
    유휴델타,
    타건델타,
    받은pane,
    키가대상으로갔나: 받은pane.length === 1 && 받은pane[0] === 대상,
    // 기전
    focus호출: 로그.filter((r) => r.무엇 === 'focus()호출'),
    blur호출: 로그.filter((r) => r.무엇 === 'blur()호출'),
    로그,
  }
  결과.회차.push(row)
  console.log(
    이름,
    '| 배지',
    row.배지옮겨갔나,
    '| 키',
    row.키가대상으로갔나,
    '| focus()호출',
    row.focus호출.length,
    '| blur()호출',
    row.blur호출.length,
    '| 받은',
    받은pane.join(',') || '없음',
  )
  await app.shot(`fxmech-${이름}`)
  return row
}

// ① 양성 대조 — xterm **위**. 앞 회차에서 포커스까지 갔다. 여기서 `focus()` 호출 모양의 기준선을 잡는다.
await 회차({ 이름: 'xterm위-p1', 대상: p1, 지점: 'xterm위', 마커: 'aa' })
// ② 문제 회차 — xterm **밖**(패딩 띠). 배지는 가고 포커스는 없었다.
await 회차({ 이름: 'xterm밖-p2', 대상: p2, 지점: 'xterm밖', 마커: 'bb' })
// ③ 되짚기 — 다시 xterm 밖으로 p1 로. 한 방향만 그런 게 아닌지 본다.
await 회차({ 이름: 'xterm밖-p1', 대상: p1, 지점: 'xterm밖', 마커: 'cc' })
// ④ 영역 **헤더 배경** — 같은 기전이 F1-3 경로에도 있나. **이번 수정 범위 밖**이라 고치지 않고
//    재기만 한다(헤더에는 이름 바꾸기 입력칸·버튼이 있어서 기본 동작을 통째로 막으면 그것들이
//    같이 죽는다). 선택은 안 바뀌는 자리라 `대상` 은 **지금 선택된 pane** 이다.
{
  const state = await app.state()
  const groupId = state.terminalGroups[0]?.groupId ?? null
  const 현재 = await 화면(app)
  const at = groupId === null ? null : await 헤더좌표(app, groupId)
  결과.헤더좌표 = at
  if (at === null) 결과.헤더 = '배경 점을 못 찾았다 — 공백'
  else await 회차({ 이름: '영역헤더배경', 대상: 현재.선택[0] ?? null, 지점: '헤더', 마커: 'dd', 좌표직접: at })
}

await app.stop()
결과.M0b = m0End()
writeRaw(OUT, 결과)
console.log('M0', JSON.stringify(M0), 'M0b', JSON.stringify(결과.M0b))
