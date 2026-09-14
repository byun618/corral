// H-1 — worktree 정렬이 **세션 상태와 무관하게 고정**인지 (10-gate1-fix2.md 통과선 ⓐⓑⓒ).
//
// 철회된 규칙: "선택됨 → 열린 workspace 있음 → 그 외". 사용자 지적 원문은 *"왜 다시 활성화 된
// 워크트리가 위로 가는거지?"* — 정렬 키에 세션 상태가 들어 있으면 세션을 열고 닫을 때마다
// 목록이 눈앞에서 재배열된다. 지금 규칙은 이름(`branch ?? path`) 사전순 하나뿐이다.
//
// fixture 는 **생성 순서를 알파벳 순서와 어긋나게** 잡는다(zzz → aaa → issue). 그래야
// 렌더 순서가 herdr 배열 순서와 달라지고, "정렬이 실제로 돌고 있다"가 증명된다 — 같으면
// "받은 순서 그대로"와 구분이 안 된다.
//
// 여기에 **leaf 순과 풀네임 순이 반대로 갈리는 쌍**을 더 넣는다: `zzz/aaa-leaf` 와
// `aaa/zzz-leaf`. 풀네임으로 정렬하면 `aaa/zzz-leaf` 가 앞이고, 화면에 보이는 leaf 로
// 정렬하면 `aaa-leaf` 가 앞이라 둘이 정확히 뒤집힌다. 이 쌍이 없으면 두 정렬이 같은 결과를
// 내서 "정렬 키를 leaf 로 바꿨는가"를 테스트가 **구분하지 못한다** — 코디네이터가 실물에서
// 잡은 결함이 그 형태였다(`main` → `012-…`: 풀네임으론 맞고 보이는 이름으론 역순).
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
      // 1줄에 **실제로 그려진 문자열**(`.worktree-name` 텍스트)을 같이 읽는다 — 정렬 키를
      // 코드에서 다시 계산해 비교하면 "코드가 코드를 검증"하는 꼴이라, 사용자가 보는 순서가
      // 맞는지는 증명되지 않는다. 이번 결함이 딱 그 틈에서 나왔다.
      code: "[...document.querySelectorAll('[data-worktree]')].map((el) => ({ path: el.getAttribute('data-worktree'), selected: el.classList.contains('is-selected'), shown: el.querySelector('.worktree-name')?.textContent?.trim() ?? null }))",
    })
  ).result
  const paths = rows.map((r) => r.path)
  const state = await app.state()
  const stateRows = state.repos.flatMap((r) => r.worktrees)
  const nameOf = (p) => {
    const w = stateRows.find((x) => x.path === p)
    return w === undefined ? p : (w.branch ?? w.path)
  }
  // I-1 — 주 체크아웃(`isLinked === false`)이 맨 위. 브랜치 이름이 'main' 인지로 재지 않는다.
  const linkedOf = (p) => stateRows.find((x) => x.path === p)?.isLinked ?? null
  const openCount = stateRows.filter((w) => w.openWorkspaceId !== null).length
  const sessionCount = stateRows.reduce((sum, w) => sum + (w.workspace?.tabs.length ?? 0), 0)
  return {
    label,
    // 화면에 보이는 이름(leaf) — 통과선의 비교 단위다.
    renderedShownNames: rows.map((r) => r.shown),
    renderedIsLinked: paths.map(linkedOf),
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
    ['zzz/aaa-leaf', 'slash-zzz'],
    ['aaa/zzz-leaf', 'slash-aaa'],
  ]) {
    const full = path.join(wtRoot, dir)
    execFileSync('git', ['-C', repo.root, 'worktree', 'add', '-b', branch, full], { encoding: 'utf8' })
    created.push({ branch, path: fs.realpathSync(full) })
  }

  const app = await startApp({ name: '11-worktree-order' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query('[data-worktree]')).found.length === 6, { timeoutMs: 10000, what: 'worktree rows mounted (6)' })

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
  await until(async () => (await app2.query('[data-worktree]')).found.length === 6, { timeoutMs: 12000, what: 'worktree rows mounted after restart' })
  snapshots.push(await orderSnapshot(app2, 'after-restart'))

  // ---------- 판정 ----------
  // 비교 단위는 **화면에 보이는 이름(leaf)** 이다. 풀네임 배열도 같이 보되, 통과/미달은
  // 사용자가 보는 쪽으로 가른다.
  const first = JSON.stringify(snapshots[0].renderedShownNames)
  const allIdentical = snapshots.every((s) => JSON.stringify(s.renderedShownNames) === first)

  // 렌더러와 **같은 비교자**로 기대 순서를 만든다(leaf 1차 · 풀네임 2차). 손으로 적으면
  // localeCompare 가 코드포인트 순이 아니라서 틀린다.
  const pairsOf = (s) => s.renderedShownNames.map((shown, i) => ({ shown, full: s.renderedNames[i], linked: s.renderedIsLinked[i] }))
  const byLeafThenFull = (a, b) => (a.shown.localeCompare(b.shown) !== 0 ? a.shown.localeCompare(b.shown) : a.full.localeCompare(b.full))
  // I-1 — 주 체크아웃 축이 **앞에** 붙었다(정적 키라 H-1 "세션 무관" 요구와 충돌하지 않는다).
  const byMainThenName = (a, b) => (Number(a.linked) - Number(b.linked) !== 0 ? Number(a.linked) - Number(b.linked) : byLeafThenFull(a, b))
  const expectedNames = pairsOf(snapshots[0]).sort(byMainThenName).map((p) => p.shown)
  const matchesNameOrder = snapshots.every((s) => JSON.stringify([...pairsOf(s)].sort(byMainThenName).map((p) => p.shown)) === JSON.stringify(s.renderedShownNames))
  // 주 체크아웃이 실제로 1행에 있는가 — 사용자 지시의 문구 그대로를 따로 잰다.
  const mainCheckoutFirst = snapshots.every((s) => s.renderedIsLinked[0] === false && s.renderedIsLinked.slice(1).every((v) => v === true))
  // 회귀 감지력 ③: I-1 **이전 규칙**(leaf 단일축)이었다면 순서가 달라져야 한다.
  const leafOnlyRuleOrder = pairsOf(selectionSnapshot).sort(byLeafThenFull).map((p) => p.shown)
  const leafOnlyRuleWouldDiffer = JSON.stringify(leafOnlyRuleOrder) !== JSON.stringify(selectionSnapshot.renderedShownNames)

  // 정렬이 실제로 돌고 있다는 증거 — 한 컷이라도 herdr 배열 순서와 달라야 한다.
  const differsFromStateArray = snapshots.some((s) => JSON.stringify(s.renderedNames) !== JSON.stringify(s.stateArrayNames))

  // 회귀 감지력 ①: 철회된 등급 규칙(선택됨 → 열림 → 그 외)이었다면 ⓑ 에서 다른 순서가 나왔어야 한다.
  const withdrawnRuleWouldDiffer = JSON.stringify(selectionSnapshot.withdrawnRankOrder) !== JSON.stringify(selectionSnapshot.renderedNames)

  // 회귀 감지력 ②: **고쳐진 결함**을 이 fixture 가 잡는가. 풀네임 정렬로 되돌리면 화면 순서가
  // 달라져야 한다 — 같다면 `zzz/aaa-leaf`·`aaa/zzz-leaf` 쌍이 제 일을 못 한 것이라 통과로 안 친다.
  const fullNameRuleOrder = pairsOf(selectionSnapshot)
    .sort((a, b) => a.full.localeCompare(b.full))
    .map((p) => p.shown)
  const fullNameRuleWouldDiffer = JSON.stringify(fullNameRuleOrder) !== JSON.stringify(selectionSnapshot.renderedShownNames)

  const out = {
    what: 'H-1 — worktree 정렬이 세션 상태와 무관하게 고정인가 (10-gate1-fix2.md 통과선 ⓐⓑⓒ)',
    rule: '주 체크아웃(isLinked=false) 1차 · 보이는 이름(leaf) 2차 · 풀네임 3차. 세션 수·열림 여부·선택 여부는 정렬 키에 넣지 않는다.',
    fullNameRuleOrder,
    leafOnlyRuleOrder,
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
      fullNameRuleWouldDiffer,
      mainCheckoutFirst,
      leafOnlyRuleWouldDiffer,
    },
    shots: [shotSelection],
    rawChain: [app.rawChain(), app2.rawChain()],
    clickLog: [...app.clickLog(), ...app2.clickLog()],
    pass: null,
  }
  out.pass = allIdentical && matchesNameOrder && differsFromStateArray && withdrawnRuleWouldDiffer && fullNameRuleWouldDiffer && mainCheckoutFirst && leafOnlyRuleWouldDiffer
  console.log(JSON.stringify({ ...out, snapshots: snapshots.map((s) => ({ label: s.label, renderedShownNames: s.renderedShownNames })) }, null, 2))
  writeRaw('h1-worktree-order.json', out)
  await app2.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
