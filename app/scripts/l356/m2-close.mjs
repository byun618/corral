// M2 — 종료 게이트. L3(오탐 0) · L4(미탐 0) · L5(부활 없음) · A2(종료 레이턴시).
//
// 게이트 판별식(index.ts checkCloseGate): `foregroundGroupId === shellPid` 면 잃을 게 없다 →
// 모달 없이 즉시 닫는다. 아니면 확인 모달. 판별 근거값(shellPid·foregroundGroupId)은 herdr
// `pane.process_info` 에서 나오고, 그 원문을 제3 오라클로 같이 싣는다.
//
// L4 두 케이스: (a) claude 에이전트 살아있음, (b) 셸에서 vim (herdr pane.send_text 로 PTY 에 직접
// "vim\r" 을 써서 포그라운드를 셸이 아닌 것으로 만든다). 둘 다 모달이 떠야 미탐 0.
//
// L5 부활: (a) UI 로 닫은 행이 재동기·새 탭 생성 후에도 안 돌아온다. (b) 조용한 종료 유실
// (drop-push 로 close 통보를 버림) → 재동기가 herdr 진실로 되돌리고, 반복 재동기에도 흔들리지
// 않는다. **원자료 주입(raw push replay)은 corral 제어 채널이 열어 주지 않는다** — herdr 는
// 인과 순서로만 push 하므로 죽은 pane 의 늦은 pane_updated 를 만들 손잡이가 없다. 그래서 부활
// 방어(store 묘비 closedTabs/closedPanes)는 LIFE-346 M4 가 store 단위로 적대 검증했고, 여기서는
// 도달 가능한 경로(유실+재동기+반복 재동기 무진동)로 판정한다 — 이 공백은 결과 문서에 명시한다.

import { herdrCall, herdrRequest, makeScratchRepo, pct, sleep, startApp, until, writeRaw } from './lib.mjs'

const L3_ROUNDS = 20
const app = await startApp({ name: 'm2-close' })
const out = { at: new Date().toISOString(), ready: app.ready, l3: [], l4: {}, l5: {}, notes: [] }

async function tabsInHerdr(workspaceId) {
  const list = await herdrRequest('tab.list', {})
  return list.tabs.filter((t) => t.workspace_id === workspaceId).map((t) => t.tab_id)
}
async function panesInHerdr(workspaceId) {
  const list = await herdrRequest('pane.list', {})
  return list.panes.filter((p) => p.workspace_id === workspaceId)
}
async function processInfo(paneId) {
  const r = await herdrCall('pane.process_info', { pane_id: paneId })
  const info = r.result?.process_info ?? {}
  const fg = info.foreground_processes ?? []
  return {
    shellPid: info.shell_pid ?? info.pid ?? null,
    foregroundGroupId: info.foreground_process_group_id ?? null,
    foreground: fg.map((p) => ({ name: p.name, cmdline: p.cmdline })),
    rawLine: r.rawLine,
  }
}
function closeGateLog(paneId) {
  return app.entries().filter((e) => e.tag === 'lifecycle.close_gate' && e.paneId === paneId).slice(-1)[0] ?? null
}
async function corralTabs(workspaceId) {
  const state = await app.state()
  const ws = state.repos
    .flatMap((r) => r.worktrees)
    .find((w) => w.workspace?.workspaceId === workspaceId)?.workspace
  return (ws?.tabs ?? []).map((t) => t.tabId)
}
async function newShellRow(workspaceId, kind = 'shell') {
  const before = new Set((await panesInHerdr(workspaceId)).map((p) => p.pane_id))
  const click = await app.click(`[data-create-row="${workspaceId}"][data-kind="${kind}"]`)
  const appeared = await until(
    async () => {
      for (const p of await panesInHerdr(workspaceId)) if (!before.has(p.pane_id)) return p
      return null
    },
    { what: 'new pane', timeoutMs: 15000, everyMs: 60 },
  )
  return { pane: appeared.value, click }
}

try {
  const repo = makeScratchRepo('m2')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const wsSeen = await until(
    async () => {
      const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
      return wt?.workspace?.workspaceId ?? null
    },
    { what: 'workspace', timeoutMs: 15000 },
  )
  const workspaceId = wsSeen.value
  out.workspaceId = workspaceId

  // ---------- L3: 셸 전용 종료 20회, 모달 0 ----------
  for (let round = 1; round <= L3_ROUNDS; round++) {
    const { pane } = await newShellRow(workspaceId)
    await sleep(1300) // 셸이 프롬프트에 앉을 시간 (포그라운드 = 셸)
    const info = await processInfo(pane.pane_id)
    const tabId = pane.tab_id
    const closeClick = await app.click(`[data-close-tab="${tabId}"]`)
    // 모달이 뜨면 안 된다
    const modalUp = (await app.query('[data-confirm-close-modal]')).found.length > 0
    const gone = await until(async () => !(await tabsInHerdr(workspaceId)).includes(tabId), {
      what: 'tab gone',
      timeoutMs: 12000,
      everyMs: 60,
    })
    const gate = closeGateLog(pane.pane_id)
    out.l3.push({
      round,
      paneId: pane.pane_id,
      tabId,
      shellPid: info.shellPid,
      foregroundGroupId: info.foregroundGroupId,
      shellEqualsForeground: info.shellPid !== null && info.shellPid === info.foregroundGroupId,
      foreground: info.foreground.map((p) => p.name),
      modalUp,
      gateClear: gate?.clear ?? null,
      closed: gone.ok,
      closeMs: gone.ok ? Date.now() - closeClick.at : null,
      processInfoRaw: info.rawLine,
    })
    console.log(`[L3 ${round}/${L3_ROUNDS}] modal=${modalUp} closed=${gone.ok} gateClear=${gate?.clear}`)
  }

  // ---------- L4: 살아있는 프로세스 → 모달 (미탐 0) ----------
  // (a) 에이전트(claude)
  {
    const { pane } = await newShellRow(workspaceId, 'claude')
    const launched = await until(
      async () => {
        const info = await processInfo(pane.pane_id)
        return info.foreground.some((p) => /claude/.test(p.cmdline ?? p.name ?? '')) ? info : null
      },
      { what: 'claude fg', timeoutMs: 30000, everyMs: 300 },
    )
    const info = launched.value
    const closeClick = await app.click(`[data-close-tab="${pane.tab_id}"]`)
    const modal = await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), {
      what: 'modal',
      timeoutMs: 6000,
      everyMs: 80,
    })
    const fgList = (await app.query('[data-confirm-close-fg]')).found
    // 모달이 정말 화면에 있나 — 취소 버튼을 좌표로 눌러 확인(가려졌으면 hit=false)
    const cancelClick = await app.click('[data-close-confirm-cancel]')
    await sleep(300)
    const stillThere = (await tabsInHerdr(workspaceId)).includes(pane.tab_id)
    // 다시 닫기 → 모달 → 승인 → 닫힘
    await app.click(`[data-close-tab="${pane.tab_id}"]`)
    await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), { what: 'modal2', timeoutMs: 6000, everyMs: 80 })
    const okClick = await app.click('[data-close-confirm-ok]')
    const gone = await until(async () => !(await tabsInHerdr(workspaceId)).includes(pane.tab_id), { what: 'closed after ok', timeoutMs: 12000, everyMs: 60 })
    out.l4.agent = {
      paneId: pane.pane_id,
      shellPid: info.shellPid,
      foregroundGroupId: info.foregroundGroupId,
      foreground: info.foreground.map((p) => p.name),
      modalShown: modal.ok,
      cancelHit: cancelClick.hit,
      harmlessOnCancel: stillThere,
      closedAfterApprove: gone.ok,
      closeMs: gone.ok ? Date.now() - okClick.at : null,
      gate: closeGateLog(pane.pane_id),
      processInfoRaw: info.rawLine,
    }
    console.log(`[L4 agent] modal=${modal.ok} cancelHarmless=${stillThere} closedAfterOk=${gone.ok}`)
  }

  // (b) 셸에서 vim
  {
    const { pane } = await newShellRow(workspaceId)
    await sleep(1200)
    await herdrRequest('pane.send_text', { pane_id: pane.pane_id, text: 'vim\r' })
    const running = await until(
      async () => {
        const info = await processInfo(pane.pane_id)
        return info.foreground.some((p) => /vim/.test(p.cmdline ?? p.name ?? '')) ? info : null
      },
      { what: 'vim fg', timeoutMs: 15000, everyMs: 300 },
    )
    const info = running.value ?? (await processInfo(pane.pane_id))
    const closeClick = await app.click(`[data-close-tab="${pane.tab_id}"]`)
    const modal = await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), { what: 'modal', timeoutMs: 6000, everyMs: 80 })
    const cancelClick = await app.click('[data-close-confirm-cancel]')
    await sleep(300)
    const stillThere = (await tabsInHerdr(workspaceId)).includes(pane.tab_id)
    // 다시 닫기 → 승인 → 닫힘 (vim 도 탭과 함께 죽는다)
    await app.click(`[data-close-tab="${pane.tab_id}"]`)
    await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), { what: 'modal2', timeoutMs: 6000, everyMs: 80 })
    const okClick = await app.click('[data-close-confirm-ok]')
    const gone = await until(async () => !(await tabsInHerdr(workspaceId)).includes(pane.tab_id), { what: 'closed after ok', timeoutMs: 12000, everyMs: 60 })
    out.l4.vim = {
      paneId: pane.pane_id,
      vimObserved: running.ok,
      shellPid: info.shellPid,
      foregroundGroupId: info.foregroundGroupId,
      foreground: info.foreground.map((p) => p.name),
      modalShown: modal.ok,
      cancelHit: cancelClick.hit,
      harmlessOnCancel: stillThere,
      closedAfterApprove: gone.ok,
      closeMs: gone.ok ? Date.now() - okClick.at : null,
      gate: closeGateLog(pane.pane_id),
      processInfoRaw: info.rawLine,
    }
    console.log(`[L4 vim] observed=${running.ok} modal=${modal.ok} cancelHarmless=${stillThere} closedAfterOk=${gone.ok}`)
  }

  // ---------- L5: 부활 없음 ----------
  // (a) UI 로 닫은 뒤 재동기·새 탭 생성에도 안 돌아온다
  {
    const { pane } = await newShellRow(workspaceId)
    await sleep(1300)
    const tabId = pane.tab_id
    await app.click(`[data-close-tab="${tabId}"]`)
    await until(async () => !(await tabsInHerdr(workspaceId)).includes(tabId), { what: 'closed', timeoutMs: 12000 })
    const checks = []
    for (let i = 0; i < 3; i++) {
      await app.send({ cmd: 'resync', reason: `l5a-${i}` })
      await sleep(700)
      const inCorral = (await corralTabs(workspaceId)).includes(tabId)
      const inHerdr = (await tabsInHerdr(workspaceId)).includes(tabId)
      checks.push({ resync: i, inCorral, inHerdr })
    }
    // 새 탭을 하나 만들어도 닫힌 탭은 안 살아난다 (id 재사용 없음)
    const { pane: fresh } = await newShellRow(workspaceId)
    await sleep(600)
    const afterNew = { closedStillGone: !(await corralTabs(workspaceId)).includes(tabId), newVisible: (await corralTabs(workspaceId)).includes(fresh.tab_id) }
    await herdrRequest('tab.close', { tab_id: fresh.tab_id }).catch(() => {})
    out.l5.a = { closedTab: tabId, checks, afterNew, revived: checks.some((c) => c.inCorral) }
    console.log(`[L5a] revived=${out.l5.a.revived} afterNew=${JSON.stringify(afterNew)}`)
  }

  // (b) 조용한 종료 유실 → 재동기 회복, 반복 재동기 무진동
  {
    const { pane } = await newShellRow(workspaceId)
    await sleep(1300)
    const tabId = pane.tab_id
    const beforeCorral = (await corralTabs(workspaceId)).includes(tabId)
    // close 통보를 버린다 (커넥션은 살아 있음)
    await app.send({ cmd: 'drop-push', dropping: true, only: ['tab_closed', 'pane_closed', 'pane_exited'] })
    await app.click(`[data-close-tab="${tabId}"]`) // herdr 는 닫지만 corral 은 통보를 못 받는다
    await until(async () => !(await tabsInHerdr(workspaceId)).includes(tabId), { what: 'herdr closed', timeoutMs: 12000 })
    await sleep(500)
    const divergedCorral = (await corralTabs(workspaceId)).includes(tabId) // 아직 보임(어긋남)
    const herdrGone = !(await tabsInHerdr(workspaceId)).includes(tabId)
    // 유실 해제 + 재동기 → 회복
    await app.send({ cmd: 'drop-push', dropping: false })
    const recovered = await until(async () => {
      await app.send({ cmd: 'resync', reason: 'l5b-recover' })
      await sleep(500)
      return !(await corralTabs(workspaceId)).includes(tabId) ? true : null
    }, { what: 'corral recovered', timeoutMs: 15000, everyMs: 100 })
    // 반복 재동기 무진동
    const osc = []
    for (let i = 0; i < 3; i++) {
      await app.send({ cmd: 'resync', reason: `l5b-osc-${i}` })
      await sleep(600)
      osc.push((await corralTabs(workspaceId)).includes(tabId))
    }
    out.l5.b = { closedTab: tabId, beforeCorral, divergedCorral, herdrGone, recovered: recovered.ok, oscillatedBack: osc.some(Boolean), osc }
    console.log(`[L5b] diverged=${divergedCorral} recovered=${recovered.ok} oscillatedBack=${out.l5.b.oscillatedBack}`)
  }

  // ---------- 집계 ----------
  const l3ModalFalsePos = out.l3.filter((r) => r.modalUp).length
  const l3Closed = out.l3.filter((r) => r.closed).length
  const closeMsAll = [...out.l3.map((r) => r.closeMs)].filter((v) => typeof v === 'number')
  out.summary = {
    l3ModalFalsePositives: l3ModalFalsePos,
    l3Closed: `${l3Closed}/${L3_ROUNDS}`,
    l4AgentModal: out.l4.agent?.modalShown ?? false,
    l4VimModal: out.l4.vim?.modalShown ?? false,
    l4CancelHarmless: (out.l4.agent?.harmlessOnCancel ?? false) && (out.l4.vim?.harmlessOnCancel ?? false),
    l4ClosedAfterApprove: (out.l4.agent?.closedAfterApprove ?? false) && (out.l4.vim?.closedAfterApprove ?? false),
    l5aRevived: out.l5.a?.revived ?? null,
    l5bRecovered: out.l5.b?.recovered ?? null,
    l5bOscillated: out.l5.b?.oscillatedBack ?? null,
    a2CloseP50: pct(closeMsAll, 50),
    a2CloseP95: pct(closeMsAll, 95),
  }
  out.verdict =
    l3ModalFalsePos === 0 &&
    l3Closed === L3_ROUNDS &&
    out.summary.l4AgentModal &&
    out.summary.l4VimModal &&
    out.summary.l4CancelHarmless &&
    out.summary.l4ClosedAfterApprove &&
    out.l5.a?.revived === false &&
    out.l5.b?.recovered === true &&
    out.l5.b?.oscillatedBack === false
      ? 'PASS'
      : 'FAIL'

  await herdrRequest('workspace.close', { workspace_id: workspaceId, close_group: true }).catch(() => {})
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('m2-close.json', out)
console.log('\nM2:', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
