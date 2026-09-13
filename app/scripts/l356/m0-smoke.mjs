// M0 — 스모크. 전체 UI 경로가 실제로 도는지 한 바퀴 (측정 아님, 게이트 통과 확인용).
//   레포 등록 → 주 체크아웃 열기 → 셸 행 생성 → 목록 등장 → 닫기(셸 게이트, 모달 0) → 소멸
//
// 실물 클릭(좌표)으로만 UI 를 만진다. herdr 오라클로 교차 확인.

import { control } from './lib.mjs'
import { herdrRequest, makeScratchRepo, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'm0-smoke' })
const out = { at: new Date().toISOString(), ready: app.ready, steps: [] }
const step = (label, value) => {
  out.steps.push({ label, ...value })
  console.log(`[${label}]`, JSON.stringify(value).slice(0, 200))
}

try {
  const repo = makeScratchRepo('m0')
  out.repo = repo.root
  await app.addRepo(repo.root)
  const repoSeen = await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, {
    what: 'repo row',
  })
  step('repo-registered', { ok: repoSeen.ok, ms: repoSeen.ms })

  // 주 체크아웃 열기 (닫힌 상태 → 열기 버튼). path 는 canonical == repo.root
  const openClick = await app.click(`[data-open-worktree="${repo.root}"]`)
  step('click-open-primary', { hit: openClick.hit, ok: openClick.ok })
  const wsSeen = await until(
    async () => {
      const state = await app.state()
      const wt = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
      return wt?.workspace?.workspaceId ?? null
    },
    { what: 'workspace open', timeoutMs: 15000 },
  )
  step('primary-opened', { ok: wsSeen.ok, workspaceId: wsSeen.value, ms: wsSeen.ms })
  const workspaceId = wsSeen.value

  // 셸 행 생성
  const createClick = await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
  step('click-create-shell', { hit: createClick.hit, ok: createClick.ok })
  // herdr 쪽에서 탭 수가 2 가 될 때까지 (원래 root tab 1 + 새 tab 1) — 제3 오라클
  const tabGrew = await until(
    async () => {
      const list = await herdrRequest('workspace.list', {})
      const ws = list.workspaces.find((w) => w.workspace_id === workspaceId)
      return ws && ws.tab_count >= 2 ? ws.tab_count : null
    },
    { what: 'herdr tab_count>=2', timeoutMs: 15000 },
  )
  step('shell-row-created', { ok: tabGrew.ok, tabCount: tabGrew.value, ms: tabGrew.ms })

  // corral 목록에서 새 탭 id 를 찾는다
  const state = await app.state()
  const ws = state.repos.flatMap((r) => r.worktrees).find((w) => w.workspaceId === workspaceId || w.workspace?.workspaceId === workspaceId)?.workspace
  const tabs = ws?.tabs ?? []
  out.tabsAfterCreate = tabs.map((t) => t.tabId)
  const newTab = tabs[tabs.length - 1]
  step('new-tab', { tabId: newTab?.tabId ?? null, count: tabs.length })

  // 닫기 (셸 게이트 → 모달 없이 즉시)
  const closeClick = await app.click(`[data-close-tab="${newTab.tabId}"]`)
  step('click-close', { hit: closeClick.hit, ok: closeClick.ok })
  // 모달이 안 떠야 한다 (L3 오탐 0)
  const modalUp = (await app.query('[data-confirm-close-modal]')).found.length > 0
  step('modal-shown', { modalUp })
  const gone = await until(
    async () => {
      const list = await herdrRequest('workspace.list', {})
      const w = list.workspaces.find((x) => x.workspace_id === workspaceId)
      return w && w.tab_count === 1 ? true : null
    },
    { what: 'herdr tab_count back to 1', timeoutMs: 15000 },
  )
  step('shell-row-closed', { ok: gone.ok, ms: gone.ms })

  // 뒷정리: 워크스페이스 닫기 (하네스)
  await herdrRequest('workspace.close', { workspace_id: workspaceId, close_group: true }).catch(() => {})
  out.verdict = repoSeen.ok && wsSeen.ok && tabGrew.ok && !modalUp && gone.ok ? 'PASS' : 'FAIL'
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('m0-smoke.json', out)
console.log('\nM0:', out.verdict)
if (out.verdict !== 'PASS') process.exitCode = 1
