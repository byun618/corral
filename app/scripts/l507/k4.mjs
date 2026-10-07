// LIFE-507 K4(530) — OS 수준 입력(cliclick, os-act.mjs — 유휴 가드·창 소유자 가드)으로 탭 줄 포털 메뉴의 버튼이 아닌 자리를 누르고 끌어도
// 탭 순서·영역 배치가 그대로인가. 메뉴 열기·끌기·회귀 클릭은 전부 OS 입력이다. 준비(워크스페이스·탭 만들기·worktree 활성)와 관측은 제어 소켓.
// 자리 찾기: 메뉴 상자 안을 4px 격자로 훑어 `elementFromPoint` 가 그 자리(섹션 제목·구분선·메뉴 바탕)인 첫 점.
// 사용: node k4.mjs <app 폴더> <n> <사례,…> [os-act jsonl 경로]  |  node k4.mjs --native <ROOT> <사례,…> [jsonl]   사례: probe · tab-section · tab-sep · tab-pad · header-section · create-blank · btn-pin · outside · plain-drag
// 출력: 사례마다 `CASE {...}` — changed = 탭 순서·영역 배치가 바뀌었나. exit 0 = 모든 사례가 입력까지 갔다, 2 = 입력을 못 보낸(거절·창 없음 등) 사례가 있다.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isoUp, isoDown, nativeHandle, herdr, herdrJson, state, ev, click, until, pause, electronMain } from './iso.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [app, n, list] = process.argv.slice(2)
if (!app || !n || !list) throw new Error('사용: node k4.mjs <app> <n> <사례,…>')
const cases = list.split(',')
const log = (...parts) => console.log(...parts)
// `--native <ROOT>` — 네이티브 회차(K6ⓒ): native-up.sh 가 띄운 corral 창에 같은 OS 입력. 끄기는 native-down.sh.
const native = app === '--native'
const h = native ? nativeHandle({ root: n, log }) : await isoUp({ app, n, log })
const P = h.fixture.root
const actLog = process.argv[5] ?? path.join(h.work, 'os-act.jsonl')
let code = 0
// 창 주인 = Electron 본체(`open` 이 돌려준 pid 는 런타임일 수 있다 — R004 에서 창을 못 찾았다).
const windowPid = native ? h.corralPid : electronMain(h)
log('window pid', windowPid, 'runtime pid', h.corralPid)
let failedCases = 0

const cgwin = (...args) => JSON.parse(execFileSync('/tmp/l507-cgwin', args, { encoding: 'utf8' }))
function corralWindow() {
  const rows = cgwin('list').filter((w) => w.pid === windowPid && w.layer === 0)
  rows.sort((a, b) => b.bounds.w * b.bounds.h - a.bounds.w * a.bounds.h)
  return rows[0] ?? null
}
/** os-act 한 번 — 결과 JSON 과 종료코드. 거절(3)이면 refused. */
function act(label, commands) {
  const win = corralWindow()
  if (win === null) return { label, exit: -1, refused: 'corral 창 없음' }
  const run = spawnSync(process.execPath, [path.join(here, 'os-act.mjs'), '--pid', String(windowPid), '--window', String(win.number), '--log', actLog, '--label', label, '--', ...commands], { encoding: 'utf8', timeout: 900_000 })
  const row = { label, exit: run.status, stdout: run.stdout.trim().slice(0, 800), stderr: run.stderr.trim().slice(0, 400) }
  log('ACT', JSON.stringify(row))
  return row
}
const layoutNow = () => ev(h, `({ tabs: [...document.querySelectorAll('[data-main-tab]')].map((e) => e.dataset.mainTab + '@' + (e.closest('[data-group-header]')?.dataset.groupHeader ?? '?') + (e.dataset.tabPinned === 'true' ? ':pin' : '')), groups: [...document.querySelectorAll('[data-group-header]')].map((e) => e.dataset.groupHeader) })`)
const center = (sel) => ev(h, `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null })()`)
/** 메뉴 상자 안에서 그 자리(pred: 'section'|'sep'|'pad'|'blank')인 첫 점. */
const spotIn = (rootSel, pred) => ev(h, `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)}); if (!root) return null
  const r = root.getBoundingClientRect()
  const ok = (el) => {
    if (!el || !root.contains(el)) return false
    switch (${JSON.stringify(pred)}) {
      case 'section': return el.classList.contains('tab-menu-section')
      case 'sep': return el.classList.contains('repo-row-menu-sep')
      case 'pad': return el === root
      case 'blank': return el.closest('button, input, [role=menuitem], [data-tab-create-entry], [data-open-tab-entry]') === null
    }
    return false
  }
  for (let y = Math.ceil(r.top) + 1; y < r.bottom - 1; y += 2) for (let x = Math.ceil(r.left) + 2; x < r.right - 2; x += 4) {
    const el = document.elementFromPoint(x, y)
    if (ok(el)) return { x, y, el: el.tagName + '.' + [...el.classList].join('.') + (el.textContent ? ' «' + el.textContent.slice(0, 24) + '»' : '') }
  }
  return null
})()`)
const menuOpen = (sel) => ev(h, `document.querySelector(${JSON.stringify(sel)}) !== null`)
const escape = async () => { await rpc(h.ctl, { cmd: 'key', keyCode: 'Escape', modifiers: [] }); await pause(400) }
const dragFrom = (p) => [`dd:@${p.x},${p.y}`, 'w:150', 'm:+30,+0', 'w:100', 'm:+30,+0', 'w:150', 'du:+0,+0']

let ws = null
async function tabMenuCase(label, pred) {
  const t1 = await center(`[data-main-tab="${ws}:t1"]`)
  const before = await layoutNow()
  const open = act(`${label} 열기(우클릭 t1)`, [`rc:@${t1.x},${t1.y}`])
  await pause(500)
  if (!(await menuOpen(`[data-tab-menu="${ws}:t1"]`))) return { label, ok: false, why: '메뉴가 안 열렸다', open, before }
  const spot = await spotIn(`[data-tab-menu="${ws}:t1"]`, pred)
  if (spot === null) { await escape(); return { label, ok: false, why: `자리(${pred}) 없음`, before } }
  const drag = act(`${label} 끌기`, dragFrom(spot))
  await pause(800)
  const after = await layoutNow()
  const stillOpen = await menuOpen(`[data-tab-menu="${ws}:t1"]`)
  if (stillOpen) await escape()
  return { label, ok: open.exit === 0 && drag.exit === 0, spot, before, after, changed: JSON.stringify(before) !== JSON.stringify(after), menuStillOpen: stillOpen, openExit: open.exit, dragExit: drag.exit }
}

try {
  ws = herdrJson(h, ['workspace', 'create', '--cwd', P, '--no-focus']).result.workspace.workspace_id
  herdrJson(h, ['tab', 'create', '--workspace', ws, '--cwd', P, '--no-focus'])
  await until(async () => (await state(h)).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === P)?.workspace?.tabs.length === 2, 'P 2 tabs', 15_000)
  await click(h, `[data-worktree="${P}"] [data-worktree-card-surface]`)
  await until(async () => (await ev(h, `document.querySelectorAll('[data-main-tab]').length`)) === 2, 'tabs in DOM', 15_000)
  await pause(800)
  log('WINDOW', JSON.stringify(await until(() => corralWindow(), 'corral 창(화면 위)', 20_000)))
  for (const name of cases) {
    let result
    switch (name) {
      case 'probe': {
        // 무해한 이동 1회 — 입력이 앱에 닿는가(mousemove 를 문서 캡처로 센다).
        await ev(h, `(() => { window.__moves = 0; window.addEventListener('mousemove', () => { window.__moves += 1 }, true); return 1 })()`)
        const p = await center('.main-tabbar-spacer')
        const moved = act('probe 무해한 이동', [`m:@${p.x},${p.y}`, 'w:100', 'm:+4,+0'])
        await pause(300)
        result = { label: 'probe', ok: moved.exit === 0, moves: await ev(h, 'window.__moves'), exit: moved.exit }
        break
      }
      case 'tab-section': result = await tabMenuCase('탭 메뉴 섹션 제목', 'section'); break
      case 'tab-sep': result = await tabMenuCase('탭 메뉴 구분선', 'sep'); break
      case 'tab-pad': result = await tabMenuCase('탭 메뉴 바탕(여백)', 'pad'); break
      case 'header-section': {
        const p = await center('.main-tabbar-spacer')
        const before = await layoutNow()
        const open = act('헤더 메뉴 열기(탭바 빈 곳 우클릭)', [`rc:@${p.x},${p.y}`])
        await pause(500)
        const sel = '[data-tab-menu-header-mode]'
        if (!(await menuOpen(sel))) { result = { label: 'header-section', ok: false, why: '헤더 메뉴가 안 열렸다', open }; break }
        const spot = await spotIn('.tab-context-menu', 'section')
        const drag = act('헤더 메뉴 섹션 제목 끌기', dragFrom(spot))
        await pause(800)
        const after = await layoutNow()
        const stillOpen = await menuOpen(sel)
        if (stillOpen) await escape()
        result = { label: 'header-section', ok: open.exit === 0 && drag.exit === 0, spot, before, after, changed: JSON.stringify(before) !== JSON.stringify(after), menuStillOpen: stillOpen }
        break
      }
      case 'create-blank': {
        const p = await center('[data-group-header] .main-tab-add')
        const before = await layoutNow()
        const open = act('탭 만들기 메뉴 열기(+ 클릭)', [`c:@${p.x},${p.y}`])
        await pause(600)
        if (!(await menuOpen('[data-tab-create-menu]'))) { result = { label: 'create-blank', ok: false, why: '탭 만들기 메뉴가 안 열렸다', open }; break }
        const spot = await spotIn('[data-tab-create-menu]', 'blank')
        const drag = act('탭 만들기 메뉴 빈 자리 끌기', dragFrom(spot))
        await pause(800)
        const after = await layoutNow()
        const stillOpen = await menuOpen('[data-tab-create-menu]')
        if (stillOpen) await escape()
        result = { label: 'create-blank', ok: open.exit === 0 && drag.exit === 0, spot, before, after, changed: JSON.stringify(before) !== JSON.stringify(after), menuStillOpen: stillOpen }
        break
      }
      case 'btn-pin': {
        // 회귀 — 메뉴 버튼(항목) 클릭 동작: 「탭 고정」 을 OS 클릭하면 t2 가 핀이 된다.
        const t2 = await center(`[data-main-tab="${ws}:t2"]`)
        const before = await layoutNow()
        act('핀 회귀 메뉴 열기(우클릭 t2)', [`rc:@${t2.x},${t2.y}`])
        await pause(500)
        const pin = await center(`[data-tab-menu="${ws}:t2"] [data-tab-menu-pin]`)
        const press = pin === null ? { exit: -1 } : act('「탭 고정」 클릭', [`c:@${pin.x},${pin.y}`])
        await pause(700)
        const after = await layoutNow()
        result = { label: 'btn-pin', ok: press.exit === 0, before, after, pinned: after.tabs.some((tab) => tab.startsWith(`${ws}:t2@`) && tab.endsWith(':pin')), menuClosed: !(await menuOpen(`[data-tab-menu="${ws}:t2"]`)) }
        break
      }
      case 'outside': {
        // 회귀 — 메뉴 밖 클릭으로 닫힘(탭바 빈 곳 왼쪽 클릭).
        const t1 = await center(`[data-main-tab="${ws}:t1"]`)
        act('바깥 클릭 회귀 메뉴 열기(우클릭 t1)', [`rc:@${t1.x},${t1.y}`])
        await pause(500)
        const opened = await menuOpen(`[data-tab-menu="${ws}:t1"]`)
        // 메뉴 밖 점 — 메뉴 상자 아래(터미널 쪽)에서 `elementFromPoint` 가 메뉴 안이 아니고 단추·입력이 아닌 첫 점(R012 는 탭바 빈 곳 중앙이 메뉴 안이었다).
        const spacer = await ev(h, `(() => {
          const menu = document.querySelector('[data-tab-menu="${ws}:t1"]'); const r = menu.getBoundingClientRect()
          for (let y = Math.round(r.bottom) + 30; y < window.innerHeight - 20; y += 20) for (let x = 40; x < window.innerWidth - 40; x += 40) {
            const el = document.elementFromPoint(x, y)
            if (el && !menu.contains(el) && el.closest('button, input, [data-worktree], [data-main-tab]') === null) return { x, y, el: el.tagName + '.' + [...el.classList].join('.') }
          }
          return null
        })()`)
        log('OUTSIDE POINT', JSON.stringify(spacer))
        const press = act('메뉴 밖(메뉴 아래 빈 곳) 클릭', [`c:@${spacer.x},${spacer.y}`])
        await pause(500)
        result = { label: 'outside', ok: press.exit === 0, opened, point: spacer, closed: !(await menuOpen(`[data-tab-menu="${ws}:t1"]`)) }
        break
      }
      case 'plain-drag': {
        // 회귀 — 메뉴 없이 평소 탭 드래그 재정렬: 첫 탭을 둘째 탭 오른쪽 끝 너머로 끈다.
        const before = await layoutNow()
        const first = before.tabs[0].split('@')[0]
        const last = before.tabs.at(-1).split('@')[0]
        const a = await center(`[data-main-tab="${first}"]`)
        const b = await ev(h, `(() => { const r = document.querySelector('[data-main-tab="${last}"]').getBoundingClientRect(); return { x: Math.round(r.right - 6), y: Math.round(r.y + r.height / 2) } })()`)
        const drag = act('평소 탭 드래그', [`dd:@${a.x},${a.y}`, 'w:150', 'm:+8,+0', 'w:100', `m:@${b.x},${b.y}`, 'w:200', 'du:+0,+0'])
        await pause(800)
        const after = await layoutNow()
        result = { label: 'plain-drag', ok: drag.exit === 0, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) }
        break
      }
      default: result = { label: name, ok: false, why: '모르는 사례' }
    }
    if (result.ok !== true) failedCases += 1
    log('CASE', JSON.stringify(result))
  }
  if (failedCases > 0) code = 2
} catch (error) {
  log('ERROR', String(error?.stack ?? error))
  code = 1
} finally {
  if (fs.existsSync(actLog)) log('ACTLOG', fs.readFileSync(actLog, 'utf8').trim().split('\n').length, '줄', actLog)
  // 네이티브는 만든 워크스페이스를 닫고 끝낸다(다음 걸음이 같은 fixture 에 새로 연다 — 한 worktree 에 워크스페이스 둘이 되지 않게).
  if (native) { if (ws !== null) log('native close', JSON.stringify(herdr(h, ['workspace', 'close', ws]))); process.exit(code) }
  const left = await isoDown(h)
  if (h.corralPid !== null) { try { process.kill(h.corralPid, 0); log('corral still alive', h.corralPid); code = code || 4 } catch { /* 꺼졌다 */ } }
  if (left.length > 0) code = code || 4
}
process.exit(code)
