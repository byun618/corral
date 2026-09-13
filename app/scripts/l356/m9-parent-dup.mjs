// M9 — 부모 workspace 이중 생성 방어 재현 (수정 2회차 F-1).
//
// 결함(고치기 전): `resolveParentWorkspace` 가 스테일 skeleton 으로 primary 열림을 읽고, 없으면
// 곧장 `workspace.create`. 대상 경로 가드(openingWorktrees)·권위 재확인은 **대상만** 봤고 부모는
// 어느 층에도 없어, 두 경로가 동시에 부모를 만들면 workspace 가 이중 생성(UI 불가시 고아 + 산 PTY).
//   ⓐ primary·linked 동시 열기 → (고치기 전) workspace 3, 기대 2
//   ⓑ worktree 만들기 경로(open-primary ∥ create-worktree) → (고치기 전) 3, 기대 2
// 고친 뒤: 두 경로가 같은 `resolveParentWorkspace` 로 모여 in-flight 약속을 공유(부모 하나) +
// 권위 재확인(worktree.list). 통과선: 각 케이스 workspace 정확히 2, 고아 0, 가드 로그 발화.
//
// 오라클: herdr `workspace.list` 개수(제3 오라클). 격리 세션이라 이 레포 workspace 만 존재.

import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'm9-parent-dup' })
const out = { at: new Date().toISOString(), ready: app.ready }

async function workspaceCount() {
  return (await herdrRequest('workspace.list', {})).workspaces.length
}
async function closeAll() {
  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
  await until(async () => ((await workspaceCount()) === 0 ? true : null), { what: '0 workspaces', timeoutMs: 12000 })
}
function parentGuardLog(sinceAt) {
  return app
    .entries()
    .filter((e) => (e.tag === 'lifecycle.parent.in_flight_join' || e.tag === 'lifecycle.parent.already_open' || e.tag === 'lifecycle.open_worktree.in_flight') && e.at >= sinceAt)
    .map((e) => e.tag)
}

try {
  const repo = makeScratchRepo('m9')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })

  // 셋업: primary 열고 linked worktree 하나 만들어 둔 뒤 전부 닫는다 (git worktree 는 디스크에 남아
  // 닫힌 행으로 보인다). 이제 primary·linked 둘 다 닫힌 상태.
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const primaryWs = (await until(async () => {
    const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
    return wt?.workspace?.workspaceId ?? null
  }, { what: 'primary ws', timeoutMs: 15000 })).value
  const parent = repo.root.replace(/\/[^/]+$/, '')
  const base = repo.root.split('/').pop()
  const linkedPath = `${parent}/${base}-l356-f1a`
  await herdrRequest('worktree.create', { workspace_id: primaryWs, branch: 'l356-f1a', path: linkedPath })
  await until(async () => ((await workspaceCount()) >= 2 ? true : null), { what: 'group formed', timeoutMs: 15000 })
  await closeAll()
  await sleep(800)

  // ── ⓐ primary·linked 동시 열기 ────────────────────────────────────────────
  {
    const mark = Date.now()
    const before = await workspaceCount() // 0
    const [c1, c2] = await Promise.all([
      app.click(`[data-open-worktree="${repo.root}"]`),
      app.click(`[data-open-worktree="${linkedPath}"]`),
    ])
    // 둘 다 열릴 때까지 (linked 는 부모가 있어야 열린다)
    await until(async () => ((await workspaceCount()) >= 2 ? true : null), { what: 'both open', timeoutMs: 20000 })
    await sleep(2000) // 이중 생성이 늦게 드러나면 여기서 count 가 3 이 된다
    const afterOpen = await workspaceCount()
    out.a = {
      primaryClickHit: c1.hit,
      linkedClickHit: c2.hit,
      workspaceCountBefore: before,
      workspaceCountAfter: afterOpen,
      expected: 2,
      noDuplicateParent: afterOpen === 2, // 3 이면 부모 이중 생성(고아)
      guardLog: parentGuardLog(mark),
    }
    console.log(`[F-1 ⓐ] count=${afterOpen} (기대 2) noDup=${afterOpen === 2} guards=${out.a.guardLog.join(',') || '—'}`)
    await closeAll()
    await sleep(800)
  }

  // ── ⓑ worktree 만들기 경로 (부모 확보 재확인) ─────────────────────────────
  // 만들기 모달은 화면을 덮는 scrim 이라 동시 클릭을 막는다(정상) — 그래서 순차로 재현한다:
  // primary 를 먼저 열고(부모 생성), **곧바로** worktree 만들기. 고치기 전엔 createWorktreeForRepo 가
  // 스테일 skeleton 을 보고 부모를 또 만들었다(이중). 고친 뒤엔 resolveParentWorkspace 가 herdr
  // 권위로 이미 열린 부모를 재확인(already_open)해 그대로 쓴다 → 부모 하나 + 새 linked = 2.
  {
    const mark = Date.now()
    const before = await workspaceCount() // 0
    // 부모(primary) 를 연다
    await app.click(`[data-open-worktree="${repo.root}"]`)
    await until(async () => ((await workspaceCount()) === 1 ? true : null), { what: 'primary open', timeoutMs: 15000 })
    // 곧바로 만들기 (skeleton 이 아직 안 따라왔을 수 있는 창 — 권위 재확인이 그걸 덮는다)
    await app.click(`[data-create-worktree="${repo.root}"]`)
    await until(async () => ((await app.query('[data-create-worktree-modal]')).found.length > 0 ? true : null), { what: 'modal', timeoutMs: 6000 })
    await app.click('[data-worktree-branch-input]')
    await app.type('l356-f1b')
    await sleep(150)
    const submitClick = await app.click('[data-worktree-create-submit]')
    await until(async () => ((await workspaceCount()) >= 2 ? true : null), { what: 'primary+new linked', timeoutMs: 20000 })
    await sleep(2000)
    const afterOpen = await workspaceCount()
    out.b = {
      submitClickHit: submitClick.hit,
      workspaceCountBefore: before,
      workspaceCountAfter: afterOpen,
      expected: 2, // 부모 1 + 새 linked 1
      noDuplicateParent: afterOpen === 2, // 3 이면 부모 이중 생성
      guardLog: parentGuardLog(mark), // 만들기 경로의 부모 재확인 (already_open) 이 떠야 한다
    }
    console.log(`[F-1 ⓑ] count=${afterOpen} (기대 2) noDup=${afterOpen === 2} guards=${out.b.guardLog.join(',') || '—'}`)
  }

  // 폴스루(open.error) 점검: readOpenWorkspaces 가 실패해도 in-flight 공유는 read **이전**에
  // 걸리므로(코드: parentOpenInFlight.get → 없을 때만 약속 생성, 약속 안에서 read) 동시 호출은
  // 여전히 하나로 묶인다. herdr read 를 강제 실패시킬 손잡이는 제품에 없어 코드 경로로 근거를 남긴다.
  out.fallthrough = {
    guardedBeforeRead: true,
    note: 'in-flight 공유가 readOpenWorkspaces 앞단이라 read 실패해도 동시 create 는 하나. read_error_fallthrough 로그가 실제 실패 시 남는다.',
    readErrorLogTag: 'lifecycle.parent.read_error_fallthrough',
    readErrorSeen: app.entries().some((e) => e.tag === 'lifecycle.parent.read_error_fallthrough'),
  }

  // 고아 없음 재확인: 전부 UI 로 닫아 0 이 되나. **linked 를 먼저** 닫는다 — primary 를 먼저 닫으면
  // linked 그룹이 열려 있어 herdr 가 workspace_group_close_required 로 거절한다(L9b, 정상).
  const state = await app.state()
  const openRows = state.repos
    .flatMap((r) => r.worktrees)
    .filter((w) => w.workspace?.workspaceId ?? w.openWorkspaceId)
    .sort((a, b) => Number(b.isLinked) - Number(a.isLinked)) // linked(true) 먼저
  for (const w of openRows) {
    await app.click(`[data-close-worktree="${w.path}"]`).catch(() => {})
    if ((await app.query('[data-confirm-close-modal]')).found.length > 0) await app.click('[data-close-confirm-ok]')
    await until(async () => ((await workspaceCount()) < openRows.length ? true : null), { what: 'closing', timeoutMs: 8000 }).catch(() => {})
    await sleep(400)
  }
  await sleep(500)
  const closedToZero = await workspaceCount()
  out.orphanCheck = { closedToZeroViaUI: closedToZero === 0, remaining: closedToZero }

  out.summary = {
    aNoDuplicateParent: out.a.noDuplicateParent,
    aCount: out.a.workspaceCountAfter,
    aGuardFired: out.a.guardLog.length > 0,
    bNoDuplicateParent: out.b.noDuplicateParent,
    bCount: out.b.workspaceCountAfter,
    bGuardFired: out.b.guardLog.length > 0,
    orphanZero: out.orphanCheck.closedToZeroViaUI,
  }
  out.verdict =
    out.a.noDuplicateParent &&
    out.b.noDuplicateParent &&
    out.a.guardLog.length > 0 &&
    out.b.guardLog.length > 0 &&
    out.orphanCheck.closedToZeroViaUI
      ? 'PASS'
      : 'FAIL'

  await closeAll().catch(() => {})
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

out.rawChain = app.rawChain()
out.clickEvidence = app.clickLog()
writeRaw('m9-parent-dup.json', out)
console.log('\nM9(F-1):', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
