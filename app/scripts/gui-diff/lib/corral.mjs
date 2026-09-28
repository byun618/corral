// corral 격리 인스턴스 기동·시드 (C2ⓓ · C9 · C11).
//
// 격리 축 셋을 전부 이 일감 전용으로 돌린다 (00-analysis F8):
//   CORRAL_USER_DATA · CORRAL_BACKEND_SOCKET + CORRAL_SESSION(둘은 함께여야 한다) · XDG_CONFIG_HOME
// 사용자 기본 userData(`~/Library/Application Support/corral`)와 herdr 기본 세션은 건드리지 않는다.
//
// 기동 경로는 새로 만들지 않고 기존 자산을 쓴다 (C11): `cli/corral.mjs open` + `CORRAL_ELECTRON`
// 래퍼로 `--remote-debugging-port` 를 Electron 바이너리에 직접 넘긴다 —
// `app/scripts/l391-first/gui-verify.mjs:38-41` 이 Electron 44 에서 이 방법으로 붙은 전례다.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connect, pickTarget, until, setViewport, assertPortFree, clickElement } from './cdp.mjs'

/** 한 줄 NDJSON 요청/응답. control 소켓과 herdr backend 소켓이 같은 모양이다. */
export function rpc(socketPath, request, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`[corral] rpc timeout: ${JSON.stringify(request).slice(0, 120)}`))
    }, timeoutMs)
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      clearTimeout(timer)
      socket.destroy()
      // 파싱 실패를 **reject 로** 돌린다 (L5). 핸들러에서 던지면 이 Promise 는 영원히 pending 이고
      // 미처리 예외로 프로세스가 죽어, 비정상 응답을 준 회차의 원인이 사라진다.
      try {
        resolve(JSON.parse(buffer.split('\n')[0]))
      } catch (error) {
        reject(new Error(`[corral] rpc 응답이 JSON 이 아니다: ${buffer.slice(0, 200)} (${error.message})`))
      }
    })
  })
}

/**
 * 격리 인스턴스를 띄운다.
 *
 * 실행 모드: **빌드 산출물**(`out/main/index.js`). corral 에는 dev 서버로 띄우면서 backend·control
 * 소켓까지 물리는 기존 경로가 없고, `cli/corral.mjs` 가 빌드 산출물을 전제로 한다
 * (`src/runtime/cli.ts:65` 이 `out/main/index.js` 없으면 `build_required` 로 거절).
 * Orca 는 dev, corral 은 빌드 — **비대칭이고, 그 사실을 보고서에 적는다**(C11). 이 비대칭이
 * 실제로 값에 얼마나 새는지는 C3 의 설치본 대조가 같은 축(개발 vs 패키징)으로 재 준다.
 */
export async function launchCorral({ appRoot, workDir, port, logDir }) {
  await assertPortFree(port, 'corral')
  const userData = path.join(workDir, 'corral-userdata')
  const herdrHome = path.join(workDir, 'corral-herdr')
  const control = path.join(workDir, 'corral-control.sock')
  const session = 'l443-gui-diff'
  for (const dir of [userData, herdrHome, logDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(herdrHome, 'config.toml'),
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n'
  )

  const env = { ...process.env }
  for (const key of ['CORRAL_CLI_SOCKET', 'CORRAL_RUNTIME_SOCKET', 'CORRAL_BACKEND_SOCKET', 'CORRAL_SESSION', 'ELECTRON_RUN_AS_NODE'])
    delete env[key]
  env.CORRAL_USER_DATA = userData
  env.HERDR_CONFIG_PATH = path.join(herdrHome, 'config.toml')
  env.XDG_CONFIG_HOME = herdrHome
  env.CORRAL_CONTROL_SOCKET = control
  env.CORRAL_REGISTRY = path.join(userData, 'repos.json')
  env.SHELL = '/bin/sh'

  // backend 먼저. 세션 이름·소켓이 이 일감 전용이라 사용자의 herdr 세션과 겹치지 않는다.
  const backendLog = fs.openSync(path.join(logDir, 'corral-backend.log'), 'a')
  const backend = spawn('herdr', ['--session', session, 'server'], { env, stdio: ['ignore', backendLog, backendLog] })
  fs.closeSync(backendLog)
  const backendSocket = path.join(herdrHome, 'herdr/sessions', session, 'herdr.sock')
  await until(() => fs.existsSync(backendSocket), 'corral herdr backend socket', 30_000)
  env.CORRAL_BACKEND_SOCKET = backendSocket
  env.CORRAL_SESSION = session

  // Electron 바이너리에 디버깅 포트를 직접 먹이는 래퍼 (l391-first/gui-verify.mjs 전례).
  const wrapper = path.join(workDir, 'corral-electron')
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${quote(path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))} --remote-debugging-port=${port} "$@"\n`,
    { mode: 0o755 }
  )
  env.CORRAL_ELECTRON = wrapper

  const opened = spawnSync(process.execPath, [path.join(appRoot, 'cli/corral.mjs'), 'open', '--json'], {
    env,
    encoding: 'utf8',
    timeout: 120_000
  })
  if (opened.status !== 0) {
    throw new Error(`[corral] open → ${opened.status}\n${opened.stdout}\n${opened.stderr}`)
  }
  const status = JSON.parse(opened.stdout).result

  await until(() => fs.existsSync(control), 'corral control socket', 60_000)
  await until(async () => (await rpc(control, { cmd: 'state' })).state?.link?.phase === 'live', 'corral GUI link live', 60_000)

  const { target } = await pickTarget(port, {
    label: 'corral',
    match: (entry) => entry.title === 'corral' || /out\/renderer\/index\.html/.test(entry.url)
  })
  const cdp = await connect(target.webSocketDebuggerUrl)
  return {
    cdp,
    target,
    backend,
    control,
    session,
    backendSocket,
    port,
    env,
    status,
    paths: { userData, herdrHome, wrapper, log: path.join(userData, 'runtime/desktop.log') }
  }
}

/**
 * 렌더러 타깃을 **다시 고른다.**
 *
 * 왜 필요한가(실측): 스토어에는 레포가 2개인데 우리가 붙은 페이지에서는 `[data-repo]` 가 0 으로
 * 보이는 회차가 있었다. corral 의 `open` 핸드오프가 창을 새로 만들면 우리가 처음 붙은 타깃은
 * 그 순간 유령이 된다 — 그 페이지는 영원히 비어 있다. 기다려도 해결되지 않는 종류의 실패라
 * **다시 붙어야** 한다.
 */
export async function reattachCorral(handle) {
  await handle.cdp.close().catch(() => {})
  const { target } = await pickTarget(handle.port, {
    label: 'corral(재접속)',
    match: (entry) => entry.title === 'corral' || /out\/renderer\/index\.html/.test(entry.url)
  })
  handle.target = target
  handle.cdp = await connect(target.webSocketDebuggerUrl)
  return target
}

/** herdr backend 에 직접 거는 RPC — pane 을 만들고 에이전트 상태를 꽂는 자리. */
export async function backendRpc(handle, method, params = {}) {
  const response = await rpc(handle.backendSocket, { id: `l443-${Date.now()}`, method, params })
  if (response.error) throw new Error(`[corral] ${method}: ${JSON.stringify(response.error)}`)
  return response.result
}

/** fixture 레포 등록 — 제어 채널의 준비용 지름길(`add-repo`)을 쓴다. 판정 회차가 아니라 시드다. */
export async function seedCorralRepo(handle, repoPath, { expectedWorktrees = 2 } = {}) {
  const response = await rpc(handle.control, { cmd: 'add-repo', root: repoPath })
  if (!response.ok) throw new Error(`[corral] add-repo: ${JSON.stringify(response)}`)
  await until(
    async () => {
      const state = (await rpc(handle.control, { cmd: 'state' })).state
      return state.repos?.some((repo) => repo.root === fs.realpathSync(repoPath))
    },
    'corral repo registered',
    30_000
  )
  // Orca 쪽과 같은 이유로 **그려진 행 수**까지 기다린다 — 한쪽만 기다리면 비대칭이 잡음이 된다.
  //
  // 기다리기만 해서는 안 된다(실측): 두 앱이 같은 fixture 레포를 동시에 훑는 회차가 있고,
  // 그때 corral 의 첫 스캔이 git 잠금에 걸려 linked worktree 행이 안 올라온 채로 끝났다
  // (Orca e2e 도 같은 자리를 "git holds a worktree lock" 으로 적어 두었다).
  // 그래서 **주기적으로 다시 훑게 하면서** 기다리고, 실패하면 마지막으로 본 값을 오류에 싣는다 —
  // "못 기다렸다" 와 "없다" 를 구분하지 못하면 다음 사람이 같은 자리에서 다시 헤맨다.
  let lastSeen = null
  let lastRebuild = 0
  let reattached = 0
  try {
    await until(
      async () => {
        const rendered = await handle.cdp.evaluate(() => ({
          worktrees: document.querySelectorAll('[data-worktree]').length,
          repos: document.querySelectorAll('[data-repo]').length,
          sidebar: document.querySelectorAll('[data-sidebar]').length,
          title: document.title,
          href: location.href
        }))
        lastSeen = rendered
        if (rendered.worktrees >= expectedWorktrees) return rendered.worktrees
        // 스토어에는 있는데 화면에 레포가 **하나도** 없으면 기다림의 문제가 아니라 붙은 페이지의
        // 문제다 — 유령 타깃일 수 있으니 한 번 다시 붙어 본다.
        if (rendered.repos === 0 && reattached < 3) {
          reattached += 1
          await reattachCorral(handle)
          return null
        }
        const now = Date.now()
        if (now - lastRebuild > 2_000) {
          lastRebuild = now
          await rpc(handle.control, { cmd: 'rebuild-tree' }, 20_000).catch(() => null)
        }
        return null
      },
      `corral worktree rows rendered (>=${expectedWorktrees})`,
      120_000,
      500
    )
  } catch (error) {
    const state = await rpc(handle.control, { cmd: 'state' }).catch(() => null)
    const repo = state?.state?.repos?.find((entry) => entry.root === fs.realpathSync(repoPath))
    const targets = await fetch(`http://127.0.0.1:${handle.port}/json/list`)
      .then((response) => response.json())
      .then((list) => list.filter((entry) => entry.type === 'page').map((entry) => ({ title: entry.title, url: entry.url, id: entry.id })))
      .catch(() => null)
    throw new Error(
      `${error.message} — 마지막 관측 ${JSON.stringify(lastSeen)}, 재접속 ${reattached}회, ` +
        `스토어 worktrees=${repo?.worktrees?.length ?? 'n/a'}, repo.error=${JSON.stringify(repo?.error ?? null)}, ` +
        `CDP 페이지 타깃=${JSON.stringify(targets)}`
    )
  }
  return response
}

/**
 * 에이전트 상태 주입 (C9) — `herdr pane report-agent`(RPC `pane.report_agent`)를
 * **격리 backend 소켓에** 건다. corral 제품 코드는 건드리지 않는다.
 *
 * corral 은 상태를 넷만 구분한다(idle·working·blocked·unknown) — Orca 의 10종을 그대로 못 받는다.
 * 그 사실 자체가 차이 행이지 이 함수가 메울 구멍이 아니다 (00-analysis U6).
 */
/**
 * 상태를 **정확히** 맞춘다 — 탭 `tabCount` 개(각 탭에 루트 pane 하나), 에이전트 `agents.length` 개.
 *
 * 왜 `pane.split` 이 아니라 `tab.create` 인가 (F4): 이전 판은 pane 만 쪼개 **탭 1개**에 pane 5개를
 * 만들었고, Orca 는 탭 5개를 만들었다. 그 비대칭이 탭바 개수·활성 위치·점 색·닫기 수 차이로 보고서에
 * 실려 LIFE-449 해소 대상에 들어갔다 — 제품 차이가 아니라 하네스가 만든 차이다.
 * 제품이 새 탭을 만드는 경로는 `tab.create` 다 (`app/src/main/adapter/internal/lifecycle.ts`).
 *
 * 판정은 하지 않는다 — 관측값만 돌려주고 호출자(`verifyState`)가 요청과 견준다.
 */
export async function applyCorralState(handle, { tabCount, agents }) {
  const workspaceId = handle.workspaceId ?? 'w1'
  const listTabs = async () => {
    const snapshot = await backendRpc(handle, 'session.snapshot')
    return {
      tabs: readSnapshotTabs(snapshot).filter((tab) => tab.workspace_id === workspaceId),
      panes: readSnapshotPanes(snapshot).filter((pane) => pane.workspace_id === workspaceId),
      focusedTabId: snapshot?.snapshot?.focused_tab_id ?? null
    }
  }
  const natural = (id) => Number(String(id).replace(/^.*?[tp](\d+)$/, '$1')) || 0
  const sorted = (rows, key) =>
    [...rows].sort((a, b) => natural(a[key]) - natural(b[key]) || String(a[key]).localeCompare(String(b[key])))

  // ① **새 탭을 만들고 옛 탭을 닫는다.** 상태를 갈아탈 때 같은 pane 을 다시 쓰면 herdr 의 상태
  //    전이가 끼어든다 — 실측: `working` 이던 pane 에 `idle` 을 보고하면 그 pane 은 `done` 으로
  //    집계됐고(working→idle 은 「끝났다」로 읽힌다), 두 앱의 상태 분포가 갈렸다.
  //    깨끗한 pane 에 한 번만 보고하면 요청한 상태가 그대로 남는다. 만들기·닫기 모두 제품 경로다.
  const before = (await listTabs()).tabs.map((tab) => tab.tab_id)
  let guard = 0
  const fresh = []
  while (fresh.length < tabCount && guard++ < 50) {
    const created = await backendRpc(handle, 'tab.create', { workspace_id: workspaceId })
    const tabId = created?.tab?.tab_id ?? null
    if (!tabId) throw new Error(`[corral] tab.create 응답에 tab_id 가 없다: ${JSON.stringify(created).slice(0, 160)}`)
    fresh.push(tabId)
  }
  for (const tabId of before) await backendRpc(handle, 'tab.close', { tab_id: tabId })
  guard = 0
  // 그래도 남는 탭이 있으면(제품이 마지막 탭을 지키는 등) 목표 수에 맞춰 뒤에서 닫는다.
  while ((await listTabs()).tabs.length > tabCount && guard++ < 50) {
    const { tabs } = await listTabs()
    await backendRpc(handle, 'tab.close', { tab_id: sorted(tabs, 'tab_id')[tabs.length - 1].tab_id })
  }

  // ② 탭 하나에 에이전트 하나 — 그 탭의 루트 pane 에 보고한다.
  const orderedTabs = sorted((await listTabs()).tabs, 'tab_id')
  const applied = []
  for (let index = 0; index < Math.min(agents.length, orderedTabs.length); index += 1) {
    const spec = agents[index]
    const tabId = orderedTabs[index].tab_id
    const { panes } = await listTabs()
    const rootPane = sorted(panes.filter((pane) => pane.tab_id === tabId), 'pane_id')[0]
    if (!rootPane) throw new Error(`[corral] 탭 ${tabId} 에 pane 이 없다`)
    await backendRpc(handle, 'pane.report_agent', {
      pane_id: rootPane.pane_id,
      source: 'l443-gui-diff',
      agent: spec.agentType,
      state: spec.state,
      message: spec.prompt
    })
    applied.push({ tab: tabId, pane: rootPane.pane_id, ...spec })
  }

  // ③ 탭 점(`.main-tab-dot`)은 **탭 단위 집계 상태**를 쓰고 그 집계는 herdr 가 준다. pane 단위
  //    push 만으로는 탭 행이 새로 오지 않아 「보고 전 집계」가 화면에 남을 수 있다 — 전체 재동기화를
  //    시키고 **우리 쪽 backend 연결**(제3 오라클)의 값에 화면이 수렴할 때까지 기다린다.
  //    못 수렴하면 던지지 않고 관측값으로 남긴다 (판정은 호출자 몫).
  await rpc(handle.control, { cmd: 'resync', reason: 'l443-agents' }, 20_000)
  const expected = await until(
    async () => {
      const { tabs: rows } = await listTabs()
      return rows.length > 0 ? sorted(rows, 'tab_id') : null
    },
    'corral 탭 집계 상태(backend)',
    20_000
  )
  const readDom = () =>
    handle.cdp.evaluate(() => {
      const all = [...document.querySelectorAll('[data-main-tabbar] [data-main-tab]')]
      return {
        dots: [...document.querySelectorAll('[data-main-tabbar] .main-tab-dot')].map((dot) =>
          dot.classList.contains('tone-accent') ? 'accent' : 'neutral'
        ),
        domTabs: all.length,
        activeTabIndex: all.findIndex((tab) => tab.classList.contains('is-active')),
        panes: document.querySelectorAll('[data-pane]').length
      }
    })
  const wanted = expected.map((tab) => (tab.agent_status === 'working' ? 'accent' : 'neutral')).sort().join(',')
  let dom = await readDom()
  const dotsConverged = await until(
    async () => {
      dom = await readDom()
      // 활성 탭은 **첫 탭을 눌러서** 맞춘다 (Orca 와 같은 제품 클릭 경로). 갱신은 다음 폴링에서 본다.
      if (dom.activeTabIndex !== 0) await clickElement(handle.cdp, '[data-main-tabbar] [data-main-tab]')
      return [...dom.dots].sort().join(',') === wanted && dom.activeTabIndex === 0 && dom.domTabs === tabCount
    },
    `corral 탭 점이 backend 집계에 수렴 (기대 ${wanted}) · 첫 탭 활성 · 탭 ${tabCount}개`,
    20_000
  ).then(
    () => true,
    () => false
  )

  const final = await listTabs()
  return {
    workspaceId,
    applied,
    tabIds: sorted(final.tabs, 'tab_id').map((tab) => tab.tab_id),
    paneIds: sorted(final.panes, 'pane_id').map((pane) => pane.pane_id),
    tabsFromBackend: sorted(final.tabs, 'tab_id'),
    agentStatuses: sorted(final.panes, 'pane_id')
      .map((pane) => pane.agent_status)
      .filter((status) => status !== 'unknown'),
    paneStatusesAll: sorted(final.panes, 'pane_id').map((pane) => pane.agent_status),
    focusedTabId: final.focusedTabId,
    tabDots: dom.dots,
    domTabs: dom.domTabs,
    activeTabIndex: dom.activeTabIndex,
    domPanes: dom.panes,
    dotsConverged
  }
}

/**
 * herdr 스냅샷의 **탭 행**만 읽는다 (`session.snapshot` → `{type, snapshot:{tabs:[…]}}`).
 * pane 행도 `tab_id`·`agent_status` 를 갖고 있어서 모양으로 훑으면 pane 을 탭으로 센다 —
 * 실측: 그렇게 훑었더니 탭 2개 상태에서 기대값이 5칸으로 불어 수렴 대기가 영원히 실패했다.
 */
function readSnapshotTabs(response) {
  const tabs = response?.snapshot?.tabs
  if (!Array.isArray(tabs)) return []
  return tabs.map((tab) => ({ tab_id: tab.tab_id, workspace_id: tab.workspace_id, agent_status: tab.agent_status, focused: tab.focused }))
}

/** 같은 스냅샷의 **pane 행**. 탭 행과 칸 이름이 겹쳐서 모양이 아니라 경로로 읽는다. */
function readSnapshotPanes(response) {
  const panes = response?.snapshot?.panes
  if (!Array.isArray(panes)) return []
  return panes.map((pane) => ({
    pane_id: pane.pane_id,
    tab_id: pane.tab_id,
    workspace_id: pane.workspace_id,
    agent_status: pane.agent_status,
    focused: pane.focused
  }))
}

/** 창 크기 맞추기 — 두 앱을 같은 크기로 세운다 (브라우저 수준 세션). */
export async function setWindowBounds(handle, size) {
  return setViewport(handle.cdp, size)
}


