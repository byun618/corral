// M8 — 열기 이중 실행 방어 재현 케이스 (수정 1회차 M5).
//
// 리뷰 e2e 재현: 열기 버튼을 빠르게 2회 → 고치기 전엔 같은 cwd 에 workspace 2개(w14·w15)가
// 서고 corral 행은 하나만 가리켜 나머지는 **UI 불가시 고아 + 산 PTY**. 고친 뒤엔 workspace 가
// 정확히 1개여야 한다 (main in-flight 가드 + 권위 재확인 + 렌더러 ref 가드).
//
// 오라클: herdr `workspace.list` 개수(제3 오라클). 격리 세션이라 이 레포 workspace 만 존재 —
// 1 이면 방어 성공, 2 면 고아. 열린 뒤 UI 닫기로 0 이 되는지도 본다 (고아 없음 = 다 회수 가능).

import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'm8-dup-open' })
const out = { at: new Date().toISOString(), ready: app.ready }

async function workspaceCount() {
  return (await herdrRequest('workspace.list', {})).workspaces.length
}

try {
  const repo = makeScratchRepo('m8')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })

  const before = await workspaceCount()
  // 빠르게 2회 — 두 클릭을 나란히 쏜다 (각각 별도 control 커넥션). in-flight 창을 노린다.
  const [click1, click2] = await Promise.all([
    app.click(`[data-open-worktree="${repo.root}"]`),
    app.click(`[data-open-worktree="${repo.root}"]`),
  ])
  // workspace 가 열릴 때까지 (하나라도)
  await until(async () => ((await workspaceCount()) > before ? true : null), { what: 'opened', timeoutMs: 15000 })
  await sleep(1500) // 혹시 두 번째가 늦게 workspace 를 만들면 여기서 드러난다
  const afterOpen = await workspaceCount()

  // corral 이 그 worktree 를 열림으로 보이고 UI 로 닫을 수 있나 (고아 아님)
  const state = await app.state()
  const wt = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
  const openWsId = wt?.workspace?.workspaceId ?? wt?.openWorkspaceId ?? null
  // UI 닫기 (열린 worktree 행의 닫기 버튼). 셸만이라 게이트 clear → 즉시 닫힘.
  let closedToZero = null
  if (openWsId) {
    await app.click(`[data-close-worktree="${repo.root}"]`)
    // 모달 뜨면 승인 (셸이라 보통 안 뜸)
    if ((await app.query('[data-confirm-close-modal]')).found.length > 0) await app.click('[data-close-confirm-ok]')
    const gone = await until(async () => ((await workspaceCount()) === 0 ? true : null), { what: 'closed to 0', timeoutMs: 12000 })
    closedToZero = gone.ok
  }

  out.result = {
    click1Hit: click1.hit,
    click2Hit: click2.hit,
    workspaceCountBefore: before,
    workspaceCountAfterDoubleOpen: afterOpen,
    orphanPrevented: afterOpen === 1, // 2 였으면 고아
    corralShowsOpen: openWsId !== null,
    closedToZeroViaUI: closedToZero, // 고아가 있었다면 UI 닫기 후에도 0 이 안 된다
  }
  // 로그에서 방어가 실제로 걸렸는지 (in-flight 무시 또는 already_open 재확인)
  const guarded = app.entries().filter((e) => e.tag === 'lifecycle.open_worktree.in_flight' || e.tag === 'lifecycle.open_worktree.already_open')
  out.guardLog = guarded.map((e) => ({ tag: e.tag, path: e.path, workspaceId: e.workspaceId ?? null }))

  out.summary = {
    orphanPrevented: out.result.orphanPrevented,
    workspaceCount: afterOpen,
    guardFired: guarded.length > 0,
    closedToZeroViaUI: closedToZero,
  }
  out.verdict = out.result.orphanPrevented && out.result.corralShowsOpen && closedToZero === true ? 'PASS' : 'FAIL'

  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

out.rawChain = app.rawChain()
out.clickEvidence = app.clickLog()
writeRaw('m8-dup-open.json', out)
console.log('\nM8:', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
