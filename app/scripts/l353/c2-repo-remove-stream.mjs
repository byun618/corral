// C2 (수정 1회차 — codex 중간2) — 레포를 목록에서 빼면 그 pane 의 스트림이 닫히나.
//
// r1 결함: 레포 제거는 herdr pane 을 건드리지 않아 store 엔 pane 이 남고, corral **트리에서만**
// 빠진다. 렌더러는 TerminalPane 을 언마운트하는데 main 스트림은 열린 채 프레임을 계속 받았다(누수).
// 수정: rebuildTree 끝에서 렌더러와 같은 트리 기준으로 dropStreamIfPaneUnviewable() 이 닫는다.
//
// 재현은 **진짜 UI 경로**로 한다: 스트리밍 중 → 진짜 「제거」 버튼 클릭 → 확인창 「제거」 클릭 →
//   (a) 로그에 stream.pane_unviewable, (b) terminal.phase == idle, (c) 화면에 data-term-empty.

import { startApp, attachPane, firstPaneId, until, sleep, writeRaw } from './lib.mjs'

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 'c2-repo-remove-stream' })
  const attached = await attachPane(app, paneId)

  const before = await app.state()
  const streamingBefore = before.terminal.phase === 'streaming' && before.terminal.paneId === paneId
  const root = before.repos[0]?.root ?? null
  if (root === null) throw new Error('레포 루트를 못 찾음 — attach 가 등록을 안 했나')

  const t0 = Date.now()
  // 진짜 「제거」 경로 — **LIFE-357 이후 메뉴 안으로 들어갔다** (LIFE-373 하네스 수정 ④).
  //
  // r1 때는 행에 바로 `[data-remove-repo]` 버튼이 있었다. LIFE-357 사이드바 재설계가 그 버튼을
  // 「더보기」 메뉴(`data-repo-menu-toggle` → `data-repo-menu-remove`)로 옮겼고, 하네스는 그 뒤로
  // 한 번도 안 돌아서 이제야 드러났다. **LIFE-373 과 무관한 선행 깨짐**이다 — `data-pane` 행이
  // 사라진 것과 같은 결. UI 경로로 재현한다는 이 시험의 취지는 그대로 두고 경로만 따라간다.
  const menuClick = await app.click(`[data-repo-menu-toggle="${root}"]`)
  const menuUp = await until(async () => (await app.query(`[data-repo-menu-remove="${root}"]`)).found.length > 0, {
    timeoutMs: 4000,
    what: 'repo row menu',
  })
  // 대기 실패를 안 보면 **없는 항목을 누르고** 뒤의 확인창 대기까지 흘러가 실패 지점이 흐려진다 (L1).
  if (!menuUp.ok) throw new Error(`repo 행 메뉴가 안 떴다 (${root}, ${menuUp.ms}ms)`)
  const removeClick = await app.click(`[data-repo-menu-remove="${root}"]`)
  const modalUp = await until(async () => (await app.query('[data-confirm-ok]')).found.length > 0, {
    timeoutMs: 4000,
    what: 'confirm modal',
  })
  // 확인창 「제거」 → removeRepo IPC → 레지스트리 제거 → rebuildTree → 트리에서 pane 사라짐.
  const confirmClick = await app.click('[data-confirm-ok]')

  // 셋을 모두 기다린다: 로그 태그 + phase idle + 화면 비움. rebuildTree 는 git 을 직렬로 도니 넉넉히.
  const released = await until(
    async () => {
      const unviewable = app.entries().some((e) => e.tag === 'stream.pane_unviewable' && e.at >= t0)
      const st = await app.state()
      const empty = (await app.query('[data-term-empty]')).found.length > 0
      const idle = st.terminal.phase === 'idle'
      return unviewable && idle && empty ? { unviewable, idle, empty, phase: st.terminal.phase } : null
    },
    { timeoutMs: 15000, everyMs: 150, what: 'stream released after repo remove' },
  )

  const afterState = await app.state()
  const unviewableLogs = app
    .entries()
    .filter((e) => e.tag === 'stream.pane_unviewable' && e.at >= t0)
    .map((e) => ({ dtMs: e.at - t0, paneId: e.paneId }))

  const pass =
    streamingBefore &&
    removeClick.hit === true &&
    modalUp.ok &&
    confirmClick.hit === true &&
    released.ok

  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    scenario: 'attach→streaming→진짜 「제거」 버튼→확인창 「제거」→스트림 해제',
    paneId,
    repoRoot: root,
    streamingBefore,
    attach: { streamingMs: attached.streamingMs },
    메뉴열기Hit: menuClick.hit === true,
    removeClickHit: removeClick.hit === true,
    confirmModalUp: modalUp.ok,
    confirmClickHit: confirmClick.hit === true,
    released: released.ok,
    releasedMs: released.ok ? released.ms : null,
    releaseSignals: released.ok ? released.value : null,
    terminalPhaseAfter: afterState.terminal.phase,
    terminalPaneIdAfter: afterState.terminal.paneId,
    reposAfter: afterState.repos.length,
    unviewableLogs,
    verdict: pass ? '통과' : '미달',
    note: 'dropStreamIfPaneUnviewable(index.ts) 가 rebuildTree 끝에서 렌더러와 같은 트리 기준으로 닫는다. link live 일 때만 판정(재접속 중 오작동 방지).',
  }
  writeRaw('c2-repo-remove-stream.json', result)
  console.log(
    `\nC2 스트리밍전 ${streamingBefore} · 제거클릭 ${removeClick.hit} · 확인창 ${modalUp.ok} · 확인클릭 ${confirmClick.hit} · 해제 ${released.ok}(${released.ms ?? '-'}ms) · phase후 ${afterState.terminal.phase} → ${result.verdict}`,
  )
  await app.stop()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
