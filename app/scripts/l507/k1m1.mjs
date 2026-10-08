// LIFE-507 fix1 R1-M1 — 세션 폴백으로 남의 세션에 붙었을 때 제 세션의 핀·색·번호·배치가 지워지나.
//   ① 격리 l507(CORRAL_SESSION=l507) 에서 Q 워크스페이스 탭에 핀·색 → ui-prefs 에 칸·배치·번호가 생긴다
//   ② corral 끔 → l507 서버 정지 → 같은 XDG 에 다른 이름 세션 l507fb 기동(워크스페이스 1개 — 탭 id 는 w1:t1)
//   ③ CORRAL_SESSION·CORRAL_BACKEND_SOCKET 없이 corral 켬 → pickSessionName 폴백으로 l507fb 에 붙는다(제 세션 = default)
//   ④ ui-prefs 를 ① 과 비교 — before(130c5f63)는 지워짐 / after 는 보존이어야 한다
// 출력 `VERDICT {...}`. 사용: node k1m1.mjs <app> <n> <kept|lost> — 셋째 인자가 이 회차의 기대(after = kept 보존, 130c5f63 before = lost 지워짐).
// 종료코드(fix2 R2-L2): 0 = VERDICT.ok(기대와 일치) · 2 = 기대와 다름 · 3 = 사전 조건 실패(핀·색·배치·번호가 ① 에서 실제로 안 들어감 — 공허 통과 방지) ·
// 1 = 시나리오 오류 · 4 = 잔존. 회차 머리에 빌드 출처(BUILD — `<app>/.build-commit` 또는 git HEAD·dirty)를 남긴다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { isoUp, isoDown, herdrJson, herdr, state, ev, click, uiPrefs, until, pause, stopCorral, startCorral } from './iso.mjs'

const FALLBACK = 'l507fb'
const [app, n, expect] = process.argv.slice(2)
if (!app || !n || !['kept', 'lost'].includes(expect)) throw new Error('사용: node k1m1.mjs <app> <n> <kept|lost>')
const log = (...parts) => console.log(...parts)
const buildOf = (dir) => {
  const stamp = path.join(dir, '.build-commit')
  if (fs.existsSync(stamp)) return { commit: fs.readFileSync(stamp, 'utf8').trim(), source: '.build-commit' }
  const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).stdout.trim().length > 0
  return { commit: head, source: 'git HEAD', srcDirty: dirty }
}
const mainJs = path.join(app, 'out', 'main', 'index.js')
log('BUILD', JSON.stringify({ app, ...buildOf(app), outMainMtime: fs.existsSync(mainJs) ? fs.statSync(mainJs).mtime.toISOString() : null, expect }))
const h = await isoUp({ app, n, log })
const Q = h.fixture.worktree
let code = 0
const tabsInDom = () => ev(h, `[...document.querySelectorAll('[data-main-tab]')].map((e) => ({ id: e.dataset.mainTab, pinned: e.dataset.tabPinned, color: e.dataset.tabColor ?? null }))`)
const wsOf = async (worktree) => (await state(h)).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === worktree)?.workspace ?? null
async function activate(worktree) {
  const ws = await until(() => wsOf(worktree), `workspace at ${worktree}`, 30_000)
  await click(h, `[data-worktree="${worktree}"] [data-worktree-card-surface]`)
  await until(async () => { const dom = await tabsInDom(); return ws.tabs.every((tab) => dom.some((row) => row.id === tab.tabId)) }, 'tabs in DOM', 15_000)
  await pause(400)
}
async function menuClick(tabId, selector) {
  await ev(h, `(() => { const el = document.querySelector('[data-main-tab="${tabId}"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 12, clientY: r.y + 10, button: 2 })); return true })()`)
  await until(() => ev(h, `document.querySelector('[data-tab-menu="${tabId}"]') !== null`), `menu ${tabId}`, 5_000)
  await click(h, `[data-tab-menu="${tabId}"] ${selector}`)
  await pause(400)
}
const prefsView = () => {
  const prefs = uiPrefs(h) ?? {}
  return {
    tabMarks: (prefs.tabMarks ?? []).map((mark) => `${mark.tabId}:${mark.pinned ? 'pin' : ''}:${mark.color ?? ''}`),
    groupLayouts: (prefs.groupLayouts ?? []).map((row) => row.worktreePath),
    tabOrdinals: (prefs.tabOrdinals ?? []).map((row) => `${row.tabId}=${row.ordinal}`),
  }
}

try {
  herdrJson(h, ['workspace', 'create', '--cwd', h.fixture.root, '--no-focus'])
  const wsQ = herdrJson(h, ['workspace', 'create', '--cwd', Q, '--no-focus']).result.workspace.workspace_id
  herdrJson(h, ['tab', 'create', '--workspace', wsQ, '--cwd', Q, '--no-focus'])
  await activate(Q)
  await menuClick(`${wsQ}:t1`, '[data-tab-menu-pin]')
  await menuClick(`${wsQ}:t1`, '[data-tab-menu-color="#ef4444"]')
  await pause(1500)
  const before = prefsView()
  log('PREFS own(l507)', JSON.stringify(before))
  // 사전 조건 — 비교할 칸이 실제로 들어갔나. 비어 있으면 「보존」 이 공허하게 참이 된다.
  const pre = {
    mark: before.tabMarks.includes(`${wsQ}:t1:pin:#ef4444`),
    layout: before.groupLayouts.some((row) => row.endsWith('/fx-wt')),
    ordinals: before.tabOrdinals.some((row) => row.startsWith(`${wsQ}:`)),
  }
  log('PRECONDITION', JSON.stringify(pre))
  if (!pre.mark || !pre.layout || !pre.ordinals) { code = 3; throw new Error(`사전 조건 실패 ${JSON.stringify(pre)}`) }
  await stopCorral(h)
  const stopped = herdr(h, ['server', 'stop'])
  log('l507 server stop', stopped.status, stopped.stdout.trim(), stopped.stderr.trim())
  const l507pid = h.herdrPids.at(-1)
  await until(() => { try { process.kill(l507pid, 0); return false } catch { return true } }, `herdr l507 pid ${l507pid} 종료`, 30_000)
  // 다른 이름 세션 — 같은 격리 XDG. 띄운 pid 는 isoDown 이 끄도록 herdrPids 에 넣는다.
  const logFd = fs.openSync(path.join(h.work, `herdr-${FALLBACK}.log`), 'a')
  const fb = spawn('herdr', ['--session', FALLBACK, 'server'], { env: h.env, stdio: ['ignore', logFd, logFd] })
  fs.closeSync(logFd)
  h.herdrPids.push(fb.pid)
  const hfb = { ...h, session: FALLBACK }
  await until(() => fs.existsSync(path.join(h.xdg, 'herdr', 'sessions', FALLBACK, 'herdr.sock')), `${FALLBACK} socket`, 30_000)
  log('fallback herdr pid', fb.pid)
  herdrJson(hfb, ['workspace', 'create', '--cwd', h.work, '--no-focus'])
  const sessions = herdr(h, ['session', 'list'])
  log('SESSIONS', JSON.stringify(sessions.stdout.trim().split('\n')))
  // ③ 제 세션 지정 없이 켠다 — 폴백 경로. `corral open` 이 프로필에 남긴 l507 바인딩(backend)도 지운다 — 남아 있으면 restoreBackend 가
  //    CORRAL_SESSION=l507 로 되살린다(R034). 사용자 profile.json 은 runtimeId 만 든 꼴이다(native-up WANT_PROFILE 주석).
  const profileFile = path.join(h.work, 'userdata', 'runtime', 'profile.json')
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'))
  fs.writeFileSync(profileFile, JSON.stringify({ runtimeId: profile.runtimeId }, null, 2) + '\n')
  log('profile backend 제거', JSON.stringify(profile.backend ?? null))
  delete h.env.CORRAL_SESSION
  delete h.env.CORRAL_BACKEND_SOCKET
  // LIFE-561 fix1 M1 — 바인딩 없는 개발 실행은 이제 레포 guard(herdr-dev 폴더·default 고정)로 풀린다. 이 시나리오는 하네스가 띄운 herdr(PATH 의 herdr,
  // `<xdg>/herdr`) 의 폴백 세션을 기대하므로 그 바이너리로 고정한다.
  h.env.CORRAL_HERDR_BIN = spawnSync('/bin/sh', ['-c', 'command -v herdr'], { env: h.env, encoding: 'utf8' }).stdout.trim()
  await startCorral(h)
  await pause(3000)
  const st = await state(h)
  const attached = { selectedSession: st.selectedSession ?? null, sessionNote: st.sessionNote ?? null, herdrTabIds: st.herdrTabIds ?? null }
  log('ATTACHED', JSON.stringify(attached))
  const after = prefsView()
  log('PREFS after fallback', JSON.stringify(after))
  const kept = (list, ref) => ref.every((item) => list.includes(item))
  const verdict = {
    fallback: attached.selectedSession === FALLBACK,
    marksBefore: before.tabMarks.length,
    preserved: { tabMarks: kept(after.tabMarks, before.tabMarks), groupLayouts: kept(after.groupLayouts, before.groupLayouts), tabOrdinals: kept(after.tabOrdinals, before.tabOrdinals) },
    lost: { tabMarks: before.tabMarks.filter((item) => !after.tabMarks.includes(item)), groupLayouts: before.groupLayouts.filter((item) => !after.groupLayouts.includes(item)), tabOrdinals: before.tabOrdinals.filter((item) => !after.tabOrdinals.includes(item)) },
    herdrTabIdsNull: attached.herdrTabIds === null,
  }
  const allKept = verdict.preserved.tabMarks && verdict.preserved.groupLayouts && verdict.preserved.tabOrdinals
  const allLost = verdict.lost.tabMarks.length > 0 && verdict.lost.groupLayouts.length > 0 && verdict.lost.tabOrdinals.length > 0
  verdict.expect = expect
  verdict.ok = verdict.fallback && (expect === 'kept' ? allKept && verdict.herdrTabIdsNull : allLost && !verdict.herdrTabIdsNull)
  log('VERDICT', JSON.stringify(verdict))
  if (!verdict.ok) code = 2
} catch (error) {
  log('ERROR', String(error?.stack ?? error))
  code = code || 1
} finally {
  // isoDown 의 `server stop` 은 l507 세션 몫 — 폴백 세션도 멈춘다.
  log('fallback server stop', JSON.stringify(herdr({ ...h, session: FALLBACK }, ['server', 'stop'])))
  const left = await isoDown(h)
  if (h.corralPid !== null) { try { process.kill(h.corralPid, 0); log('corral still alive', h.corralPid); code = code || 4 } catch { /* 꺼졌다 */ } }
  if (left.length > 0) code = code || 4
}
process.exit(code)
