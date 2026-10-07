// LIFE-507 K1ⓒ — corral 이 **꺼진 동안** 워크스페이스가 닫히는 경우.
//   A: corral 끔 → herdr 로 Q(w2) 닫기 → corral 켬(재기동 전 — herdr 목록에 w2 없음) → 칸이 지워지나 → herdr 재기동 → Q 에 새 워크스페이스(w2 재사용) → 붙나
//   B: corral 끔 → Q(w2) 닫기 → herdr 재기동 → Q 에 새 워크스페이스(w2 재사용) + 탭 → corral 켬 → 붙나 (corral 이 가진 정보로 가릴 수 있나)
// 출력 `VERDICT {...}`. exit 0 = 끝까지 돌았다. 사용: node k1c.mjs <app> <n> <A|B>
import { isoUp, isoDown, restartHerdr, herdrJson, herdr, state, ev, click, uiPrefs, until, pause, stopCorral, startCorral } from './iso.mjs'

const [app, n, mode] = process.argv.slice(2)
if (!app || !n || !['A', 'B'].includes(mode)) throw new Error('사용: node k1c.mjs <app> <n> <A|B>')
const log = (...parts) => console.log(...parts)
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
const marksOf = (ws) => (uiPrefs(h)?.tabMarks ?? []).filter((mark) => mark.workspaceId === ws)

try {
  herdrJson(h, ['workspace', 'create', '--cwd', h.fixture.root, '--no-focus'])
  const wsQ = herdrJson(h, ['workspace', 'create', '--cwd', Q, '--no-focus']).result.workspace.workspace_id
  await activate(Q)
  await menuClick(`${wsQ}:t1`, '[data-tab-menu-pin]')
  await menuClick(`${wsQ}:t1`, '[data-tab-menu-color="#ef4444"]')
  const marked = marksOf(wsQ)
  log('marked', JSON.stringify(marked))
  await stopCorral(h)
  log('close while corral off', JSON.stringify(herdr(h, ['workspace', 'close', wsQ])))
  let bootPrefs = null
  if (mode === 'A') {
    await startCorral(h)
    await pause(2500)
    bootPrefs = marksOf(wsQ)
    log('after corral boot (herdr 재기동 전)', JSON.stringify(bootPrefs))
    await restartHerdr(h)
  } else {
    await restartHerdr(h)
  }
  const reused = herdrJson(h, ['workspace', 'create', '--cwd', Q, '--no-focus']).result.workspace.workspace_id
  log('new workspace at Q', reused)
  if (mode === 'B') await startCorral(h)
  await until(async () => (await wsOf(Q)) !== null, 'new Q in corral', 30_000)
  await activate(Q)
  await pause(1000)
  const dom = await tabsInDom()
  const attached = dom.filter((tab) => tab.pinned === 'true' || tab.color !== null).map((tab) => tab.id)
  log('VERDICT', JSON.stringify({ mode, reusedId: reused === wsQ, marked: marked.length, prunedOnBoot: mode === 'A' ? bootPrefs.length === 0 : null, attached, dom, prefsNow: marksOf(reused) }))
} catch (error) {
  log('ERROR', String(error?.stack ?? error))
  code = 1
} finally {
  const left = await isoDown(h)
  if (h.corralPid !== null) { try { process.kill(h.corralPid, 0); log('corral still alive', h.corralPid); code = code || 4 } catch { /* 꺼졌다 */ } }
  if (left.length > 0) code = code || 4
}
process.exit(code)
