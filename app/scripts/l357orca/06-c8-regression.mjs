// C8 — LIFE-356 회귀 스모크. 새 UI 진입점(WorktreeBlock hover 메뉴·MainTabBar 없음 단계) 경유로
// L1(행 생성)·L3(종료 게이트 오탐 0, 1회)·L4(종료 게이트 미탐 0, 1회)·L6(worktree 열기) 최소 재현
// (01-criteria.md C8 — "최소 재현", L356 원본의 20회 반복은 여기서 요구되지 않는다).
//
// 판별자는 화면이 아니라 herdr 제3 오라클(pane.process_info·tab.list·worktree.list)이다(관문⑤).
// claude 프로세스 탐지는 알려진 함정(부분 문자열 오탐) 을 피해 토큰 경계 정규식을 쓴다
// (`/(^|[\s/])claude([\s/]|$)/` — 02-kickoff-orca.md 가 명시한 이전 라운드 실패 재현 금지).
import { herdrCall, herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const CLAUDE_TOKEN = /(^|[\s/])claude([\s/]|$)/
const VIM_TOKEN = /(^|[\s/])vim([\s/]|$)/

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

async function tabsInHerdr(workspaceId) {
  const list = await herdrRequest('tab.list', {})
  return list.tabs.filter((t) => t.workspace_id === workspaceId).map((t) => t.tab_id)
}

async function panesInHerdr(workspaceId) {
  const list = await herdrRequest('pane.list', {})
  return list.panes.filter((p) => p.workspace_id === workspaceId)
}

async function openWorktreeId(repoRoot) {
  const list = await herdrRequest('worktree.list', {})
  return list.worktrees.find((w) => w.path === repoRoot)?.open_workspace_id ?? null
}

async function main() {
  const repo = makeScratchRepo('c8-regression')
  const app = await startApp({ name: '06-c8-regression' })
  const out = { at: new Date().toISOString(), repo: repo.root }

  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'worktree row mounted',
  })

  // ---------- L6: 닫힌 worktree 를 UI 클릭으로 연다 — herdr worktree.list(open_workspace_id) 오라클 ----------
  const beforeOpen = await openWorktreeId(repo.root)
  const openClick = await app.click(`[data-worktree="${repo.root}"]`)
  const opened = await until(async () => (await openWorktreeId(repo.root)) !== null, { timeoutMs: 10000, what: 'worktree opened (herdr)' })
  const workspaceId = await openWorktreeId(repo.root)
  out.l6 = {
    openClickHit: openClick.hit,
    workspaceIdBefore: beforeOpen,
    workspaceIdAfter: workspaceId,
    opened: opened.ok,
    pass: beforeOpen === null && opened.ok && workspaceId !== null,
  }
  console.log('[L6]', out.l6)

  // 열자마자 기본 탭 1개가 생긴다(00-smoke 실측) — L1 을 위해 새 탭을 하나 더 만든다(메뉴 경유).
  await until(async () => (await panesInHerdr(workspaceId)).length >= 1, { timeoutMs: 8000, what: 'default pane' })

  // ---------- L1: claude 에이전트 행 생성 — herdr pane.process_info 로 실제 기동 확인 ----------
  const beforePanes = new Set((await panesInHerdr(workspaceId)).map((p) => p.pane_id))
  await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
  await sleep(150)
  const createClick = await app.click(`[data-worktree-create-agent="${repo.root}"][data-kind="claude"]`)
  const newPane = await until(
    async () => {
      for (const p of await panesInHerdr(workspaceId)) if (!beforePanes.has(p.pane_id)) return p
      return null
    },
    { timeoutMs: 15000, what: 'new agent pane' },
  )
  const l1Pane = newPane.value
  const l1Launched = l1Pane
    ? await until(
        async () => {
          const info = await processInfo(l1Pane.pane_id)
          return info.foreground.some((p) => CLAUDE_TOKEN.test(p.cmdline ?? p.name ?? '')) ? info : null
        },
        { timeoutMs: 30000, what: 'claude fg (token-boundary)' },
      )
    : { ok: false, value: null }
  out.l1 = {
    createClickHit: createClick.hit,
    paneAppeared: newPane.ok,
    paneId: l1Pane?.pane_id ?? null,
    claudeLaunched: l1Launched.ok,
    foreground: l1Launched.value?.foreground.map((p) => p.name) ?? null,
    processInfoRaw: l1Launched.value?.rawLine ?? null,
    pass: newPane.ok && l1Launched.ok,
  }
  console.log('[L1]', out.l1)

  // ---------- L3: 셸 전용 행 닫기 — 모달 0, 즉시 닫힘(1회) ----------
  {
    const before = new Set((await panesInHerdr(workspaceId)).map((p) => p.pane_id))
    await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
    const pane = await until(
      async () => {
        for (const p of await panesInHerdr(workspaceId)) if (!before.has(p.pane_id)) return p
        return null
      },
      { timeoutMs: 10000, what: 'new shell pane (L3)' },
    )
    await sleep(1300) // 포그라운드가 셸에 앉을 시간
    const info = await processInfo(pane.value.pane_id)
    const tabId = pane.value.tab_id
    const closeClick = await app.click(`[data-close-tab="${tabId}"]`)
    const modalUp = (await app.query('[data-confirm-close-modal]')).found.length > 0
    const gone = await until(async () => !(await tabsInHerdr(workspaceId)).includes(tabId), { timeoutMs: 12000, what: 'L3 tab gone' })
    out.l3 = {
      shellEqualsForeground: info.shellPid !== null && info.shellPid === info.foregroundGroupId,
      foreground: info.foreground.map((p) => p.name),
      closeClickHit: closeClick.hit,
      modalUp,
      closed: gone.ok,
      pass: modalUp === false && gone.ok,
      processInfoRaw: info.rawLine,
    }
    console.log('[L3]', out.l3)
  }

  // ---------- L4: vim 이 포그라운드인 행 닫기 — 모달 뜬다(미탐 0, 1회) ----------
  {
    const before = new Set((await panesInHerdr(workspaceId)).map((p) => p.pane_id))
    await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
    const pane = await until(
      async () => {
        for (const p of await panesInHerdr(workspaceId)) if (!before.has(p.pane_id)) return p
        return null
      },
      { timeoutMs: 10000, what: 'new shell pane (L4)' },
    )
    await sleep(1200)
    await herdrRequest('pane.send_text', { pane_id: pane.value.pane_id, text: 'vim\r' })
    const running = await until(
      async () => {
        const info = await processInfo(pane.value.pane_id)
        return info.foreground.some((p) => VIM_TOKEN.test(p.cmdline ?? p.name ?? '')) ? info : null
      },
      { timeoutMs: 15000, what: 'vim fg (token-boundary)' },
    )
    const tabId = pane.value.tab_id
    const closeClick = await app.click(`[data-close-tab="${tabId}"]`)
    const modal = await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), {
      timeoutMs: 6000,
      what: 'L4 modal',
    })
    const cancelClick = await app.click('[data-close-confirm-cancel]')
    await sleep(300)
    const harmlessOnCancel = (await tabsInHerdr(workspaceId)).includes(tabId)
    await app.click(`[data-close-tab="${tabId}"]`)
    await until(async () => ((await app.query('[data-confirm-close-modal]')).found.length > 0 ? true : null), { timeoutMs: 6000, what: 'L4 modal2' })
    await app.click('[data-close-confirm-ok]')
    const gone = await until(async () => !(await tabsInHerdr(workspaceId)).includes(tabId), { timeoutMs: 12000, what: 'L4 closed after ok' })
    out.l4 = {
      vimObserved: running.ok,
      foreground: (running.value ?? {}).foreground?.map((p) => p.name) ?? null,
      closeClickHit: closeClick.hit,
      modalShown: modal.ok,
      cancelHit: cancelClick.hit,
      harmlessOnCancel,
      closedAfterApprove: gone.ok,
      pass: modal.ok === true && harmlessOnCancel === true && gone.ok === true,
      processInfoRaw: running.value?.rawLine ?? null,
    }
    console.log('[L4]', out.l4)
  }

  await herdrRequest('workspace.close', { workspace_id: workspaceId, close_group: true }).catch(() => {})
  await app.stop()

  out.allPass = out.l1.pass && out.l3.pass && out.l4.pass && out.l6.pass
  console.log('C8 allPass:', out.allPass)
  writeRaw('c8-regression.json', out)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
