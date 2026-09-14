// H-1 — worktree 정렬이 **세션 상태와 무관하게 고정**인지 (10-gate1-fix2.md 통과선 ⓐⓑⓒ).
//
// 철회된 규칙: "선택됨 → 열린 workspace 있음 → 그 외". 사용자 지적 원문은 *"왜 다시 활성화 된
// 워크트리가 위로 가는거지?"* — 정렬 키에 세션 상태가 들어 있으면 세션을 열고 닫을 때마다
// 목록이 눈앞에서 재배열된다. 지금 규칙은 이름(`branch ?? path`) 사전순 하나뿐이다.
//
// fixture 는 **생성 순서를 알파벳 순서와 어긋나게** 잡는다(zzz → aaa → issue). 그래야
// 렌더 순서가 herdr 배열 순서와 달라지고, "정렬이 실제로 돌고 있다"가 증명된다 — 같으면
// "받은 순서 그대로"와 구분이 안 된다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { agentTabsOf, buildMixedFixture, makeScratchRepo, startApp, tabsOf, until, writeRaw } from './lib.mjs'

/** 렌더된 worktree 순서를 **이름 배열**로 — 통과선이 "순서 배열이 동일"이라 이게 비교 단위다. */
async function orderSnapshot(app, label) {
  // 선택 여부는 **DOM 에서** 읽는다 — state 의 필드 이름에 기대지 않는다(없으면 철회된 규칙의
  // 등급 0 이 영영 안 나와 판별력이 조용히 사라진다).
  const rows = (
    await app.send({
      cmd: 'eval',
      code: "[...document.querySelectorAll('[data-worktree]')].map((el) => ({ path: el.getAttribute('data-worktree'), selected: el.classList.contains('is-selected') }))",
    })
  ).result
  const paths = rows.map((r) => r.path)
  const state = await app.state()
  const stateRows = state.repos.flatMap((r) => r.worktrees)
  const nameOf = (p) => {
    const w = stateRows.find((x) => x.path === p)
    return w === undefined ? p : (w.branch ?? w.path)
  }
  const openCount = stateRows.filter((w) => w.openWorkspaceId !== null).length
  const sessionCount = stateRows.reduce((sum, w) => sum + (w.workspace?.tabs.length ?? 0), 0)
  return {
    label,
    renderedNames: paths.map(nameOf),
    // herdr 가 준 배열 순서 — 우리가 여기에 의존하지 **않는다**는 것을 보이기 위해 같이 찍는다.
    stateArrayNames: stateRows.map((w) => w.branch ?? w.path),
    openWorktreeCount: openCount,
    totalSessionCount: sessionCount,
    // 철회된 등급 규칙이었다면 나왔을 순서 — 관측값과 달라야 이 검사가 회귀를 잡는다.
    withdrawnRankOrder: [...rows]
      .map((r) => ({ name: nameOf(r.path), selected: r.selected, open: stateRows.find((x) => x.path === r.path)?.openWorkspaceId ?? null }))
      .sort((a, b) => {
        // 선택 여부는 DOM 의 `.is-selected` 에서 온다 — state 필드 이름에 기대면 등급 0 이
        // 영영 안 나와 판별력이 조용히 사라진다.
        const rank = (x) => (x.selected ? 0 : x.open !== null ? 1 : 2)
        return rank(a) - rank(b)
      })
      .map((x) => x.name),
  }
}

async function main() {
  const repo = makeScratchRepo('worktree-order')
  const wtRoot = path.join(repo.root, '.wt')
  fs.mkdirSync(wtRoot, { recursive: true })
  // 생성 순서를 일부러 알파벳 역방향으로 — herdr 배열 순서 ≠ 렌더 순서를 만든다.
  const created = []
  for (const [branch, dir] of [
    ['zzz-last', 'zzz'],
    ['aaa-first', 'aaa'],
    ['issue/LIFE-89', 'issue-life-89'],
  ]) {
    const full = path.join(wtRoot, dir)
    execFileSync('git', ['-C', repo.root, 'worktree', 'add', '-b', branch, full], { encoding: 'utf8' })
    created.push({ branch, path: fs.realpathSync(full) })
  }

  const app = await startApp({ name: '11-worktree-order' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query('[data-worktree]')).found.length === 4, { timeoutMs: 10000, what: 'worktree rows mounted (4)' })

  const snapshots = []

  // ---------- ⓐ-1. 세션 0개 ----------
  snapshots.push(await orderSnapshot(app, 'sessions-0'))

  // ---------- ⓐ-2. 세션 N개 ----------
  const aaa = created.find((w) => w.branch === 'aaa-first')
  await app.click(`[data-worktree="${aaa.path}"]`)
  await until(async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === aaa.path)?.workspace != null, {
    timeoutMs: 20000,
    what: 'aaa-first workspace opened',
  })
  const fixture = await buildMixedFixture(app, aaa.path, { agents: 2, shells: 1 })
  snapshots.push(await orderSnapshot(app, 'sessions-N'))

  // ---------- ⓐ-3. 세션을 닫아도 ----------
  const tabs = await tabsOf(app, aaa.path)
  const shellTab = tabs.filter((t) => !t.panes.some((p) => p.agent !== null)).slice(-1)[0]
  const closeClick = shellTab === undefined ? null : await app.click(`[data-main-tab-close="${shellTab.tabId}"]`)
  const closed =
    shellTab === undefined
      ? { ok: false }
      : await until(async () => !(await tabsOf(app, aaa.path)).some((t) => t.tabId === shellTab.tabId), {
          timeoutMs: 15000,
          what: 'shell tab closed',
        })
  snapshots.push(await orderSnapshot(app, 'session-closed'))

  // ---------- ⓑ. 다른 worktree 를 선택해도 ----------
  // 철회된 규칙이 살아 있었다면 여기서 zzz-last 가 맨 위로 튀어 오른다.
  const zzz = created.find((w) => w.branch === 'zzz-last')
  await app.click(`[data-worktree="${zzz.path}"]`)
  await until(async () => (await app.query(`[data-worktree="${zzz.path}"].is-selected`)).found.length > 0, {
    timeoutMs: 20000,
    what: 'zzz-last selected',
  })
  const selectionSnapshot = await orderSnapshot(app, 'selection-changed')
  snapshots.push(selectionSnapshot)
  const shotSelection = await app.shot('order-selection-changed')
  await app.stop()

  // ---------- ⓒ. 재기동 후 ----------
  // 재기동은 **같은 입력으로 새 레지스트리**에 다시 담는다 — 통과선은 "같은 상태면 같은 순서"라
  // 레지스트리를 공유할 필요가 없고, 공유하면 레포가 중복 등록돼 행 수가 어긋난다.
  const app2 = await startApp({ name: '11-worktree-order-restart' })
  await app2.addRepo(repo.root)
  await until(async () => (await app2.query('[data-worktree]')).found.length === 4, { timeoutMs: 12000, what: 'worktree rows mounted after restart' })
  snapshots.push(await orderSnapshot(app2, 'after-restart'))

  // ---------- 판정 ----------
  const first = JSON.stringify(snapshots[0].renderedNames)
  const allIdentical = snapshots.every((s) => JSON.stringify(s.renderedNames) === first)
  // 기대 순서는 손으로 적지 않고 **렌더러와 같은 비교자**로 만든다 — localeCompare 는
  // 코드포인트 순이 아니라서 손으로 적으면 틀린다.
  const expectedNames = [...snapshots[0].renderedNames].sort((a, b) => a.localeCompare(b))
  const matchesNameOrder = snapshots.every((s) => JSON.stringify([...s.renderedNames].sort((a, b) => a.localeCompare(b))) === JSON.stringify(s.renderedNames))
  // 정렬이 실제로 돌고 있다는 증거 — 한 컷이라도 herdr 배열 순서와 달라야 한다.
  const differsFromStateArray = snapshots.some((s) => JSON.stringify(s.renderedNames) !== JSON.stringify(s.stateArrayNames))
  // 회귀 감지력 — 철회된 규칙이었다면 ⓑ 에서 다른 순서가 나왔어야 한다. 같다면 이 fixture 로는
  // 두 규칙이 구분되지 않는다는 뜻이라 통과로 치지 않는다.
  const withdrawnRuleWouldDiffer = JSON.stringify(selectionSnapshot.withdrawnRankOrder) !== JSON.stringify(selectionSnapshot.renderedNames)

  const out = {
    what: 'H-1 — worktree 정렬이 세션 상태와 무관하게 고정인가 (10-gate1-fix2.md 통과선 ⓐⓑⓒ)',
    rule: '이름(branch ?? path) 사전순. 세션 수·열림 여부·선택 여부는 정렬 키에 넣지 않는다.',
    fixtureCreationOrder: created.map((w) => w.branch),
    expectedNames,
    snapshots,
    fixture: { tabCount: fixture.tabCount, agentTabCount: fixture.agentTabCount, shellTabCount: fixture.shellTabCount },
    sessionClose: { targetTabId: shellTab?.tabId ?? null, clickHit: closeClick?.hit ?? null, closed: closed.ok },
    checks: {
      a_identicalAcrossSessionCounts: allIdentical,
      b_identicalAfterSelectionChange: allIdentical,
      c_identicalAfterRestart: allIdentical,
      matchesNameOrder,
      differsFromStateArray,
      withdrawnRuleWouldDiffer,
    },
    shots: [shotSelection],
    rawChain: [app.rawChain(), app2.rawChain()],
    clickLog: [...app.clickLog(), ...app2.clickLog()],
    pass: null,
  }
  out.pass = allIdentical && matchesNameOrder && differsFromStateArray && withdrawnRuleWouldDiffer
  console.log(JSON.stringify({ ...out, snapshots: snapshots.map((s) => ({ label: s.label, renderedNames: s.renderedNames })) }, null, 2))
  writeRaw('h1-worktree-order.json', out)
  await app2.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
