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
import { connect, pickTarget, until, setViewport, assertPortFree } from './cdp.mjs'

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
      resolve(JSON.parse(buffer.split('\n')[0]))
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
export async function setCorralAgents(handle, { count, states }) {
  // **pane 순서를 고정한다.** `pane.list` 가 돌려주는 순서는 보장이 없고, 순서가 흔들리면
  // 어느 pane 이 어느 상태를 받는지가 회차마다 달라진다 — 실측: 탭 점 색이
  // rgba(58,65,64) / rgba(125,211,160) 로 갈려 C10 이 깨졌다. id 의 숫자 꼬리로 자연 정렬한다.
  const sortPanes = (list) =>
    [...list].sort((a, b) => {
      const n = (id) => Number(String(id).replace(/^.*?p(\d+)$/, '$1')) || 0
      return n(a.pane_id) - n(b.pane_id) || String(a.pane_id).localeCompare(String(b.pane_id))
    })
  const listed = await backendRpc(handle, 'pane.list')
  const panes = sortPanes(listed.panes ?? [])
  // pane 이 모자라면 workspace 를 늘려 만든다 — 사이드바가 그릴 것은 pane 이다.
  while (panes.length < count) {
    const created = await backendRpc(handle, 'pane.split', { pane_id: panes[panes.length - 1].pane_id, direction: 'right' })
    const refreshed = await backendRpc(handle, 'pane.list')
    panes.length = 0
    panes.push(...sortPanes(refreshed.panes ?? []))
    if (!created) break
  }
  const applied = []
  for (let index = 0; index < Math.min(count, panes.length); index += 1) {
    const spec = states[index % states.length]
    await backendRpc(handle, 'pane.report_agent', {
      pane_id: panes[index].pane_id,
      source: 'l443-gui-diff',
      agent: spec.agentType,
      state: spec.state,
      message: spec.prompt
    })
    applied.push({ pane: panes[index].pane_id, ...spec })
  }
  // 탭 점(`.main-tab-dot`)은 **탭 단위 집계 상태**를 쓰고, 그 집계는 herdr 가 준다
  // (`store.ts` TabRow.agent_status). pane 단위 push(`pane.agent_status_changed`)만으로는
  // 탭 행이 새로 오지 않아, 회차마다 「보고 전 스냅샷」이 남는다 — 실측: 같은 상태에서
  // 탭 점이 accent/neutral 로 갈려 C10 이 깨졌다. 그래서 ① 전체 재동기화를 시킨 뒤
  // ② **우리 쪽 backend 연결**(제3 오라클)로 정답을 떠서 ③ 화면이 그 값에 수렴할 때까지 기다린다.
  await rpc(handle.control, { cmd: 'resync', reason: 'l443-agents' }, 20_000)
  const expected = await until(
    async () => {
      const tabs = readSnapshotTabs(await backendRpc(handle, 'session.snapshot'))
      return tabs.length > 0 ? tabs : null
    },
    'corral 탭 집계 상태(backend)',
    20_000
  )
  const readDots = () =>
    handle.cdp.evaluate(() =>
      [...document.querySelectorAll('[data-main-tabbar] .main-tab-dot')].map((dot) =>
        dot.classList.contains('tone-accent') ? 'accent' : 'neutral'
      )
    )
  // 순서가 아니라 **모음**으로 견준다 — DOM 탭 순서와 backend 스냅샷 순서는 서로 보장이 없다.
  const wanted = expected.map((tab) => (tab.agent_status === 'working' ? 'accent' : 'neutral')).sort().join(',')
  let dots = []
  await until(
    async () => {
      dots = await readDots()
      return [...dots].sort().join(',') === wanted
    },
    `corral 탭 점이 backend 집계에 수렴 (기대 ${wanted})`,
    20_000
  )
  return { applied, paneCount: panes.length, tabsFromBackend: expected, tabDots: dots }
}

/**
 * herdr 스냅샷의 **탭 행**만 읽는다 (`session.snapshot` → `{type, snapshot:{tabs:[…]}}`).
 * pane 행도 `tab_id`·`agent_status` 를 갖고 있어서 모양으로 훑으면 pane 을 탭으로 센다 —
 * 실측: 그렇게 훑었더니 탭 2개 상태에서 기대값이 5칸으로 불어 수렴 대기가 영원히 실패했다.
 */
function readSnapshotTabs(response) {
  const tabs = response?.snapshot?.tabs
  if (!Array.isArray(tabs)) return []
  return tabs.map((tab) => ({ tab_id: tab.tab_id, agent_status: tab.agent_status }))
}

/** 창 크기 맞추기 — 두 앱을 같은 크기로 세운다 (브라우저 수준 세션). */
export async function setWindowBounds(handle, size) {
  return setViewport(handle.cdp, size)
}

/** 끝나면 닫는다 (C12). 닫았다는 것을 호출자가 원자료로 남길 수 있게 pid 를 돌려준다. */
export async function shutdownCorral(handle) {
  const pids = { backend: handle.backend?.pid ?? null }
  try {
    await rpc(handle.control, { cmd: 'quit' }, 5_000)
  } catch {
    /* control 에 quit 가 없으면 아래 status 로 pid 를 잡아 끝낸다 */
  }
  return pids
}
