// F1 육안·계측 — 영역이 실제로 서나 (LIFE-373 ①).
//
// LIFE-353 하네스의 앱 구동·control 채널을 그대로 쓴다(재는 도구는 같은 것이 낫다).
// 여기서 보는 것: ⓐ 기본 1영역 ⓑ ⌘⌥D 로 2영역(탭이 빠져나간다) ⓒ 헤더·빈 상태·경계선 선택자
// ⓓ 영역별 연결 수(= 영역 수) ⓔ 재기동 후 복원(F1-6).

import { startApp, attachPane, firstPaneId, until, sleep, writeRaw, herdrRequest } from '../l353/lib.mjs'

const paneId = await firstPaneId()
const app = await startApp({ name: 'f1-groups' })
await attachPane(app, paneId)
await sleep(600)

const state0 = await app.state()
const workspaceId = state0.repos.flatMap((r) => r.worktrees).find((w) => w.workspace !== null)?.workspace.workspaceId ?? null
if (workspaceId === null) throw new Error('열린 workspace 가 없다')

// 탭이 2개 이상이어야 분할이 뜻을 갖는다 (원 영역 탭 1개면 무효 — F1-1).
const before = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])
if (before.length < 2) {
  await herdrRequest('tab.create', { workspace_id: workspaceId })
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? []).length > before.length, {
    what: '탭 생성 반영',
  })
}
await sleep(400)

const query = async (selector) => (await app.query(selector)).found.length
const snapshot = async (label) => {
  const state = await app.state()
  return {
    label,
    영역수: await query('[data-tab-group]'),
    헤더수: await query('[data-group-header]'),
    경계선: await query('[data-group-divider]'),
    빈영역: await query('[data-empty-group]'),
    터미널상자: await query('[data-term-group]'),
    연결: state.terminalGroups.map((g) => ({ groupId: g.groupId, tabId: g.tabId, phase: g.phase, grid: g.grid })),
    탭바탭: await query('[data-main-tab]'),
  }
}

const 기본 = await snapshot('기본')
await app.shot('f1-a-single')

// ⓑ 탭 메뉴로 새 영역 — 실제 UI 경로로 (우클릭 → 「오른쪽 영역」).
const tabs = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])
const second = tabs[1]?.tabId ?? null
if (second === null) throw new Error('두 번째 탭이 없다')
await app.send({ cmd: 'eval', code: `document.querySelector('[data-main-tab="${second}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 40 })), 1` })
await until(async () => (await query(`[data-tab-menu-move-right="${second}"]`)) > 0, { what: '탭 메뉴' })
const moveClick = await app.click(`[data-tab-menu-move-right="${second}"]`)
await until(async () => (await query('[data-tab-group]')) === 2, { what: '영역 2개', timeoutMs: 5000 })
await sleep(900)
const 분할후 = await snapshot('오른쪽 영역으로 옮기기')
await app.shot('f1-b-two-groups')

const out = { at: new Date().toISOString(), moveClick: moveClick.hit === true, 기본, 분할후 }
writeRaw('f1-groups.json', out)
console.log(JSON.stringify(out, null, 2))
process.exit(0)
