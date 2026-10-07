// LIFE-507 K6 — 네이티브 회차 걸음(native-up.sh 가 띄운 구현 빌드 corral + 사용자 userData + herdr `default`). 제어 소켓으로 관측·준비한다.
// 만드는 것: 버리는 fixture 저장소 /tmp/l507nfx/fx(+ fx-wt) 등록(userData 는 native-down.sh 가 바이트 복원) · 그 경로의 워크스페이스·탭(끝에 닫는다).
// 사용자 실제 저장소·worktree 는 건드리지 않는다. 복구로 다시 뜬 사용자 pane 에는 입력하지 않는다.
// 사용: node native.mjs <ROOT=/tmp/l507n*> <raw 폴더> setup|k1|k3|m1
//   setup — fixture 만들기·등록, <ROOT>/native-state.json
//   k1    — K1ⓐⓑⓔ: Q(w?) 탭에 핀·색·배치 → herdr 로 Q 닫기(corral 실행 중) → herdr default 재기동 1회(native-herdr-restart.sh) →
//           빈 번호 메우기(/tmp cwd 워크스페이스 — 등록 밖이라 화면에 안 뜬다) 뒤 Q 에 새 워크스페이스(닫은 id 재사용) → 붙나 · P 의 핀·색이 남나
//   k3    — K3 정상 닫기 경로: 탭 × 클릭 → herdr 에서 사라지고 오류 알림 없음
//   m1    — fix1 R1-M1 정상(default) 경로: 제 세션(default)에 붙어 herdrTabIds 가 나오고(null 아님), 핀·색이 방출을 여러 번 지나도 남는다
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nativeHandle, herdr, herdrJson, state, ev, click, until, pause, uiPrefs, waitLive } from './iso.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'
import { ensureFixtureRepo } from '../gui-diff/lib/fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [root, rawd, step] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l507n') || !rawd || !['setup', 'k1', 'k3', 'm1'].includes(step)) throw new Error('사용: node native.mjs <ROOT=/tmp/l507n*> <raw> setup|k1|k3|m1')
const log = (...parts) => console.log(...parts)
const FX_BASE = '/tmp/l507nfx'

if (step === 'setup') {
  fs.mkdirSync(FX_BASE, { recursive: true })
  const fixture = ensureFixtureRepo(FX_BASE, { name: 'fx' })
  const added = await rpc(path.join(root, 'ctl.sock'), { cmd: 'add-repo', root: fixture.root })
  log('add-repo', JSON.stringify(added))
  fs.writeFileSync(path.join(root, 'native-state.json'), `${JSON.stringify({ fixture: { root: fixture.root, worktree: fixture.worktree } }, null, 2)}\n`)
  const h = nativeHandle({ root, log })
  await until(async () => (await state(h)).repos.some((repo) => repo.root === fixture.root && repo.worktrees.length >= 2), 'fixture 2 worktrees', 30_000)
  log('SETUP', JSON.stringify({ fixture, repos: (await state(h)).repos.length }))
  process.exit(added.ok ? 0 : 1)
}

const h = nativeHandle({ root, log })
const P = h.fixture.root
const Q = h.fixture.worktree
let code = 0
const created = []
const tabsInDom = () => ev(h, `[...document.querySelectorAll('[data-main-tab]')].map((e) => ({ id: e.dataset.mainTab, pinned: e.dataset.tabPinned, color: e.dataset.tabColor ?? null, group: e.closest('[data-group-header]')?.dataset.groupHeader ?? null }))`)
const groupsInDom = () => ev(h, `[...document.querySelectorAll('[data-group-header]')].map((e) => e.dataset.groupHeader)`)
const wsOf = async (worktree) => (await state(h)).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === worktree)?.workspace ?? null
const createWs = (cwd) => {
  const id = herdrJson(h, ['workspace', 'create', '--cwd', cwd, '--no-focus']).result.workspace.workspace_id
  created.push(id)
  return id
}
async function activate(worktree) {
  const ws = await until(() => wsOf(worktree), `workspace at ${worktree}`, 30_000)
  await click(h, `[data-worktree="${worktree}"] [data-worktree-card-surface]`)
  await until(async () => { const dom = await tabsInDom(); return ws.tabs.every((tab) => dom.some((row) => row.id === tab.tabId)) }, `tabs of ${worktree} in DOM`, 15_000)
  await pause(500)
}
async function menuClick(tabId, selector) {
  await ev(h, `(() => { const el = document.querySelector('[data-main-tab="${tabId}"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 12, clientY: r.y + 10, button: 2 })); return true })()`)
  await until(() => ev(h, `document.querySelector('[data-tab-menu="${tabId}"]') !== null`), `menu ${tabId}`, 5_000)
  await click(h, `[data-tab-menu="${tabId}"] ${selector}`)
  await pause(400)
}
/** 원자료에는 fixture 워크스페이스 칸만 남긴다(사용자 탭 id·배치는 싣지 않는다). */
const snap = async (label, ids) => {
  const prefs = uiPrefs(h)
  const mine = (tabId) => ids.some((ws) => tabId.startsWith(`${ws}:`))
  const row = {
    label,
    dom: (await tabsInDom()).filter((tab) => mine(tab.id)),
    groups: await groupsInDom(),
    tabMarks: (prefs?.tabMarks ?? []).filter((mark) => ids.includes(mark.workspaceId)),
    tabOrdinals: (prefs?.tabOrdinals ?? []).filter((entry) => ids.includes(entry.groupId)),
    groupLayouts: (prefs?.groupLayouts ?? []).filter((entry) => entry.worktreePath === P || entry.worktreePath === Q),
    herdrTabs: herdrJson(h, ['tab', 'list']).result.tabs.map((tab) => tab.tab_id).filter(mine),
  }
  log('SNAP', JSON.stringify(row))
  return row
}

try {
  if (step === 'k1') {
    const wsP = createWs(P)
    const wsQ = createWs(Q)
    log('workspaces', wsP, wsQ)
    for (let i = 0; i < 2; i++) herdrJson(h, ['tab', 'create', '--workspace', wsQ, '--cwd', Q, '--no-focus'])
    await until(async () => (await wsOf(Q))?.tabs.length === 3, 'Q 3 tabs', 15_000)
    await activate(Q)
    herdrJson(h, ['tab', 'close', `${wsQ}:t1`])
    herdrJson(h, ['tab', 'close', `${wsQ}:t2`])
    await until(async () => (await wsOf(Q))?.tabs.map((tab) => tab.tabId).join() === `${wsQ}:t3`, 'Q t3 only', 15_000)
    await pause(800)
    herdrJson(h, ['tab', 'create', '--workspace', wsQ, '--cwd', Q, '--no-focus'])
    await until(async () => (await wsOf(Q))?.tabs.map((tab) => tab.tabId).join() === `${wsQ}:t3,${wsQ}:t4`, 'Q t3,t4', 15_000)
    await activate(Q)
    await menuClick(`${wsQ}:t3`, '[data-tab-menu-pin]')
    await menuClick(`${wsQ}:t3`, '[data-tab-menu-color="#ef4444"]')
    await menuClick(`${wsQ}:t4`, '[data-tab-menu-color="#3b82f6"]')
    await menuClick(`${wsQ}:t4`, '[data-tab-menu-move-right]')
    const q0 = await snap('Q 표시 (닫기 전)', [wsQ])
    await activate(P)
    await menuClick(`${wsP}:t1`, '[data-tab-menu-pin]')
    await menuClick(`${wsP}:t1`, '[data-tab-menu-color="#22c55e"]')
    const p0 = await snap('P 표시 (닫기 전)', [wsP])

    log('close', JSON.stringify(herdr(h, ['workspace', 'close', wsQ])))
    created.splice(created.indexOf(wsQ), 1)
    await until(async () => (await wsOf(Q)) === null, 'Q closed in corral', 15_000)
    await pause(1500)
    const closed = await snap('Q 닫힌 뒤 (corral 실행 중)', [wsQ, wsP])

    const restart = spawnSync('sh', [path.join(here, 'native-herdr-restart.sh'), root, rawd, 'k1'], { encoding: 'utf8', timeout: 120_000 })
    log('herdr restart', restart.status, restart.stdout.trim().split('\n').slice(-4).join(' | '), restart.stderr.trim().slice(0, 300))
    if (restart.status !== 0) throw new Error('herdr default 재기동 실패')
    await waitLive(h, 90_000)
    await until(async () => (await wsOf(P)) !== null, 'P restored', 60_000)
    await pause(2000)
    const restarted = await snap('herdr 재기동 뒤', [wsQ, wsP])

    // 닫은 id(wsQ) 를 새 워크스페이스가 받도록 그 아래 빈 번호를 /tmp cwd 워크스페이스로 메운다(등록 밖 — 화면에 안 뜬다).
    const target = Number(wsQ.replace(/^w/, ''))
    const used = new Set(herdrJson(h, ['workspace', 'list']).result.workspaces.map((ws) => Number(ws.workspace_id.replace(/^w/, ''))))
    const gaps = []
    for (let k = 1; k < target; k++) if (!used.has(k)) gaps.push(createWs('/tmp'))
    log('gap fillers', JSON.stringify(gaps))
    const reused = createWs(Q)
    log('new workspace at Q', reused, reused === wsQ ? '(id 재사용)' : '(재사용 아님)')
    for (let i = 0; i < 3; i++) herdrJson(h, ['tab', 'create', '--workspace', reused, '--cwd', Q, '--no-focus'])
    await until(async () => (await wsOf(Q))?.tabs.length === 4, 'new Q 4 tabs', 15_000)
    await activate(Q)
    const q1 = await snap('새 Q 표시', [reused])
    await activate(P)
    const p1 = await snap('P 표시 (재기동 뒤)', [wsP])
    const ordinalOf = (rows, tabId) => rows.find((row) => row.tabId === tabId)?.ordinal ?? null
    const ordinals = Object.fromEntries(q1.dom.map((tab) => [tab.id, ordinalOf(q1.tabOrdinals, tab.id)]))
    const fresh = Object.fromEntries(q1.dom.map((tab) => [tab.id, Number(tab.id.split(':t')[1])]))
    const pMark = (row) => row.dom.find((tab) => tab.id === `${wsP}:t1`) ?? null
    const verdict = {
      reusedId: reused === wsQ,
      attachedMarks: q1.dom.filter((tab) => tab.pinned === 'true' || tab.color !== null).map((tab) => tab.id),
      attachedLayout: { groups: q1.groups.length, dom: q1.dom.map((tab) => `${tab.id}@${tab.group}`) },
      ordinals, expectedOrdinalsIfFresh: fresh, attachedOrdinals: JSON.stringify(ordinals) !== JSON.stringify(fresh),
      staleAfterClose: { tabMarks: closed.tabMarks.filter((mark) => mark.workspaceId === wsQ).length, tabOrdinals: closed.tabOrdinals.filter((row) => row.groupId === wsQ).length, groupLayoutQ: closed.groupLayouts.some((row) => row.worktreePath === Q) },
      survivedP: { before: pMark(p0), afterRestart: pMark(p1), prefsAfterRestart: restarted.tabMarks.filter((mark) => mark.workspaceId === wsP) },
      survived: pMark(p1)?.pinned === 'true' && pMark(p1)?.color === '#22c55e',
      q0: q0.dom.map((tab) => `${tab.id}:${tab.pinned}:${tab.color}@${tab.group}`),
    }
    verdict.attached = verdict.attachedMarks.length > 0 || verdict.attachedLayout.groups > 1 || verdict.attachedOrdinals
    log('VERDICT', JSON.stringify(verdict))
    if (!verdict.reusedId || verdict.attached || !verdict.survived) code = 2
  }
  if (step === 'm1') {
    const ws = createWs(P)
    herdrJson(h, ['tab', 'create', '--workspace', ws, '--cwd', P, '--no-focus'])
    await until(async () => (await wsOf(P))?.tabs.length === 2, 'P 2 tabs', 15_000)
    await activate(P)
    await menuClick(`${ws}:t1`, '[data-tab-menu-pin]')
    await menuClick(`${ws}:t1`, '[data-tab-menu-color="#22c55e"]')
    const s0 = await snap('marked', [ws])
    // 방출을 몇 번 더 지나게 한다 — 탭 하나 더 만들고 닫는다(herdrTabIds 가 바뀌는 방출).
    const extra = herdrJson(h, ['tab', 'create', '--workspace', ws, '--cwd', P, '--no-focus']).result.tab.tab_id
    await until(async () => (await wsOf(P))?.tabs.length === 3, 'P 3 tabs', 15_000)
    herdr(h, ['tab', 'close', extra])
    await until(async () => (await wsOf(P))?.tabs.length === 2, 'P 2 tabs again', 15_000)
    await pause(3000)
    const st = await state(h)
    const s1 = await snap('after emits', [ws])
    const mark = (row) => row.dom.find((tab) => tab.id === `${ws}:t1`)
    const verdict = {
      selectedSession: st.selectedSession ?? null,
      sessionNote: st.sessionNote ?? null,
      // 사용자 탭 id 는 싣지 않는다 — 개수와 fixture 탭 포함 여부만.
      herdrTabIds: st.herdrTabIds === null ? null : { count: st.herdrTabIds.length, hasFixture: st.herdrTabIds.includes(`${ws}:t1`) },
      before: mark(s0),
      after: mark(s1),
      prefsAfter: s1.tabMarks,
    }
    verdict.kept = verdict.after?.pinned === 'true' && verdict.after?.color === '#22c55e' && s1.tabMarks.some((row) => row.tabId === `${ws}:t1` && row.pinned && row.color === '#22c55e')
    log('VERDICT', JSON.stringify(verdict))
    if (verdict.selectedSession !== 'default' || verdict.herdrTabIds === null || !verdict.kept) code = 2
  }
  if (step === 'k3') {
    const ws = createWs(P)
    herdrJson(h, ['tab', 'create', '--workspace', ws, '--cwd', P, '--no-focus'])
    await until(async () => (await wsOf(P))?.tabs.length === 2, 'P 2 tabs', 15_000)
    await activate(P)
    const target = `${ws}:t2`
    await click(h, `[data-main-tab="${target}"]`)
    await pause(600)
    await click(h, `[data-main-tab-close="${target}"]`)
    await until(async () => !herdrJson(h, ['tab', 'list']).result.tabs.some((tab) => tab.tab_id === target), 'tab gone in herdr', 15_000)
    await pause(800)
    const verdict = {
      closed: !(await tabsInDom()).some((tab) => tab.id === target),
      confirmShown: await ev(h, `document.querySelector('[data-close-confirm-cancel]') !== null`),
      notice: await ev(h, `document.querySelector('[data-lifecycle-notice]')?.dataset.noticeKind ?? null`),
    }
    log('VERDICT', JSON.stringify(verdict))
    if (!verdict.closed || verdict.confirmShown || verdict.notice === 'error') code = 2
  }
} catch (error) {
  log('ERROR', String(error?.stack ?? error))
  code = 1
} finally {
  for (const id of created) log('cleanup close', id, JSON.stringify(herdr(h, ['workspace', 'close', id]).status))
}
process.exit(code)
