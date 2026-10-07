// LIFE-507 K1ⓐⓑⓔ 격리 시나리오 — 닫힌 워크스페이스의 탭 핀·색·배치·폴백 번호가 herdr 재기동 뒤 id 를 다시 받은 새 탭에 붙는가(ⓐⓔ),
// 살아남은 탭의 핀·색이 corral 실행 중 herdr 재기동을 넘어 남는가(ⓑ).
//   P = fixture 주 체크아웃(워크스페이스 w1, 탭 t1 — 핀+초록) · Q = linked 체크아웃(w2, 탭 t1·t2·t3 표시 뒤 t1·t2 닫고 t4 — 살아 있는 t3(번호 3)·t4(번호 1))
//   Q: t3 핀+빨강 · t4 파랑 · t4 를 오른쪽 영역으로 → herdr 로 w2 닫기(corral 실행 중) → herdr 재기동 → Q 에 새 워크스페이스(재사용 기대 w2) + 탭 4개
// 판정 출력: `VERDICT {...}` 한 줄. 잘못 붙음이 하나라도 있으면 attached=true. exit 0 = 시나리오가 끝까지 돌았다(판정은 VERDICT 로 읽는다), 그 밖 = 진행 실패.
// 사용: node k1.mjs <app 폴더> <회차 번호 n — /tmp/l507i<n>·/tmp/l507h<n>>
import { isoUp, isoDown, restartHerdr, herdrJson, herdr, state, ev, click, uiPrefs, until, pause } from './iso.mjs'

const [app, n] = process.argv.slice(2)
if (!app || !n) throw new Error('사용: node k1.mjs <app> <n>')
const log = (...parts) => console.log(...parts)
const h = await isoUp({ app, n, log })
const P = h.fixture.root
const Q = h.fixture.worktree
let code = 0

const tabsInDom = () => ev(h, `[...document.querySelectorAll('[data-main-tab]')].map((e) => ({ id: e.dataset.mainTab, pinned: e.dataset.tabPinned, color: e.dataset.tabColor ?? null, group: e.closest('[data-group-header]')?.dataset.groupHeader ?? null, title: e.querySelector('.main-tab-label')?.textContent ?? null }))`)
const groupsInDom = () => ev(h, `[...document.querySelectorAll('[data-group-header]')].map((e) => e.dataset.groupHeader)`)
const wsOf = async (worktree) => (await state(h)).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === worktree)?.workspace ?? null
async function activate(worktree) {
  const ws = await until(() => wsOf(worktree), `workspace at ${worktree}`, 30_000)
  await click(h, `[data-worktree="${worktree}"] [data-worktree-card-surface]`)
  const ids = ws.tabs.map((tab) => tab.tabId)
  await until(async () => { const dom = await tabsInDom(); return ids.every((id) => dom.some((tab) => tab.id === id)) }, `tabs of ${worktree} in DOM`, 15_000)
  await pause(400)
}
async function menu(tabId) {
  await ev(h, `(() => { const el = document.querySelector('[data-main-tab="${tabId}"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 12, clientY: r.y + 10, button: 2 })); return true })()`)
  await until(() => ev(h, `document.querySelector('[data-tab-menu="${tabId}"]') !== null`), `menu ${tabId}`, 5_000)
}
async function menuClick(tabId, selector) {
  await menu(tabId)
  await click(h, `[data-tab-menu="${tabId}"] ${selector}`)
  await pause(400)
}
const snap = async (label) => {
  const prefs = uiPrefs(h)
  const row = { label, dom: await tabsInDom(), groups: await groupsInDom(), tabMarks: prefs?.tabMarks ?? null, tabOrdinals: prefs?.tabOrdinals ?? null, groupLayouts: prefs?.groupLayouts ?? null, herdrTabs: herdrJson(h, ['tab', 'list']).result.tabs.map((tab) => tab.tab_id) }
  log('SNAP', JSON.stringify(row))
  return row
}

try {
  const wsP = herdrJson(h, ['workspace', 'create', '--cwd', P, '--no-focus']).result.workspace.workspace_id
  const wsQ = herdrJson(h, ['workspace', 'create', '--cwd', Q, '--no-focus']).result.workspace.workspace_id
  log('workspaces', wsP, wsQ)
  for (let i = 0; i < 2; i++) herdrJson(h, ['tab', 'create', '--workspace', wsQ, '--cwd', Q, '--no-focus'])
  await until(async () => (await wsOf(Q))?.tabs.length === 3, 'Q 3 tabs', 15_000)
  await activate(Q) // t1·t2·t3 폴백 번호 1·2·3 배정
  herdrJson(h, ['tab', 'close', `${wsQ}:t1`])
  herdrJson(h, ['tab', 'close', `${wsQ}:t2`])
  await until(async () => (await wsOf(Q))?.tabs.map((tab) => tab.tabId).join() === `${wsQ}:t3`, 'Q t3 only', 15_000)
  await pause(800)
  herdrJson(h, ['tab', 'create', '--workspace', wsQ, '--cwd', Q, '--no-focus'])
  await until(async () => (await wsOf(Q))?.tabs.map((tab) => tab.tabId).join() === `${wsQ}:t3,${wsQ}:t4`, 'Q t3,t4', 15_000)
  await activate(Q) // t4 = 비어 있는 가장 작은 번호 1
  await menuClick(`${wsQ}:t3`, '[data-tab-menu-pin]')
  await menuClick(`${wsQ}:t3`, '[data-tab-menu-color="#ef4444"]')
  await menuClick(`${wsQ}:t4`, '[data-tab-menu-color="#3b82f6"]')
  await menuClick(`${wsQ}:t4`, '[data-tab-menu-move-right]')
  const q0 = await snap('Q 표시 직후 (닫기 전)')
  await activate(P)
  await menuClick(`${wsP}:t1`, '[data-tab-menu-pin]')
  await menuClick(`${wsP}:t1`, '[data-tab-menu-color="#22c55e"]')
  const p0 = await snap('P 표시 (닫기 전)')

  log('close', JSON.stringify(herdr(h, ['workspace', 'close', wsQ])))
  await until(async () => (await wsOf(Q)) === null, 'Q closed in corral', 15_000)
  await pause(1500)
  const closed = await snap('Q 닫힌 뒤 (corral 실행 중)')

  await restartHerdr(h)
  await until(async () => (await wsOf(P)) !== null, 'P restored', 30_000)
  await pause(1500)
  const restarted = await snap('herdr 재기동 뒤')

  const reused = herdrJson(h, ['workspace', 'create', '--cwd', Q, '--no-focus']).result.workspace.workspace_id
  log('new workspace at Q', reused, reused === wsQ ? '(id 재사용)' : '(재사용 아님)')
  for (let i = 0; i < 3; i++) herdrJson(h, ['tab', 'create', '--workspace', reused, '--cwd', Q, '--no-focus'])
  await until(async () => (await wsOf(Q))?.tabs.length === 4, 'new Q 4 tabs', 15_000)
  await activate(Q)
  const q1 = await snap('새 Q 표시')
  await activate(P)
  const p1 = await snap('P 표시 (재기동 뒤)')

  const newTabs = q1.dom
  const attachedMarks = newTabs.filter((tab) => tab.pinned === 'true' || tab.color !== null).map((tab) => tab.id)
  const attachedLayout = q1.groups.length > 1
  const ordinalOf = (rows, tabId) => rows?.find((row) => row.tabId === tabId)?.ordinal ?? null
  const ordinals = Object.fromEntries(newTabs.map((tab) => [tab.id, ordinalOf(q1.tabOrdinals, tab.id)]))
  const expectedOrdinals = Object.fromEntries(newTabs.map((tab) => [tab.id, Number(tab.id.split(':t')[1])]))
  const attachedOrdinals = JSON.stringify(ordinals) !== JSON.stringify(expectedOrdinals)
  const pMark = (row) => row.dom.find((tab) => tab.id === `${wsP}:t1`) ?? null
  const verdict = {
    reusedId: reused === wsQ,
    attached: attachedMarks.length > 0 || attachedLayout || attachedOrdinals,
    attachedMarks,
    attachedLayout: { groups: q1.groups.length, dom: newTabs.map((tab) => `${tab.id}@${tab.group}`) },
    ordinals,
    expectedOrdinalsIfFresh: expectedOrdinals,
    attachedOrdinals,
    staleAfterClose: { tabMarks: (closed.tabMarks ?? []).filter((mark) => mark.workspaceId === wsQ).length, tabOrdinals: (closed.tabOrdinals ?? []).filter((row) => row.groupId === wsQ).length, groupLayoutQ: (closed.groupLayouts ?? []).some((row) => row.worktreePath === Q) },
    survivedP: { before: pMark(p0), afterRestart: pMark(p1), prefsAfterRestart: (restarted.tabMarks ?? []).filter((mark) => mark.workspaceId === wsP) },
    survived: pMark(p1)?.pinned === 'true' && pMark(p1)?.color === '#22c55e',
    q0Marks: q0.dom.map((tab) => `${tab.id}:${tab.pinned}:${tab.color}@${tab.group}`),
  }
  log('VERDICT', JSON.stringify(verdict))
} catch (error) {
  log('ERROR', String(error?.stack ?? error))
  code = 1
} finally {
  const left = await isoDown(h)
  if (h.corralPid !== null) { try { process.kill(h.corralPid, 0); log('corral still alive', h.corralPid); code = code || 4 } catch { /* 꺼졌다 */ } }
  if (left.length > 0) code = code || 4
}
process.exit(code)
