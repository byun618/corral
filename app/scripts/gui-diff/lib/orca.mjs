// Orca 개발 인스턴스 기동·시드 (C2ⓑⓒ · C3 · C9).
//
// 격리가 이 파일의 절반이다. **userData 만 갈라서는 부족하다** — v1.4.198 의 훅 설치기는
// `os.homedir()` 로 `~/.claude/settings.json`·`~/.orca/agent-hooks/*`·`~/.codex` 를 잡고
// (`src/main/claude/hook-settings.ts:104-106`, `agent-hooks/installer-utils.ts:105`,
//  `codex/codex-home-paths.ts:36`), 기동 직후 무조건 설치를 시도한다
// (`startup/configure-process.ts:237-241` 은 dev 여부를 버리고 true 를 돌려준다).
// 그래서 **버리는 HOME** 을 준다. 상세·증거는 raw/claude/c2/F7-correction.md.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connect, pickTarget, until, setViewport, assertPortFree } from './cdp.mjs'

/** 훅 설치기가 건드릴 수 있는 env 는 전부 떼고 우리 것으로 덮는다 (Orca 자신의 e2e 경계와 같은 목록). */
const STRIPPED_ENV = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'ZDOTDIR',
  'ORCA_ORIG_ZDOTDIR',
  'BASH_ENV',
  'ENV',
  'ELECTRON_RUN_AS_NODE',
  'ORCA_E2E_USER_DATA_DIR',
  'ORCA_E2E_HOME_DIR',
  'ORCA_USER_DATA_PATH',
  'ORCA_DEV_USER_DATA_PATH'
])

/** 소스에서 리터럴을 긁어 온다 — 온보딩 프로필을 손으로 베끼면 버전이 올라갈 때 조용히 틀어진다. */
function readOnboardingConstants(repoRoot) {
  const constants = fs.readFileSync(path.join(repoRoot, 'src/shared/constants.ts'), 'utf8')
  const pick = (name) => {
    const match = constants.match(new RegExp(`export const ${name} = (\\d+)`))
    if (!match) throw new Error(`[orca] ${name} 를 constants.ts 에서 못 찾았다 — 태그가 바뀌었나?`)
    return Number(match[1])
  }
  const ids = (file, marker) => {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    const start = text.indexOf(marker)
    if (start < 0) throw new Error(`[orca] ${marker} 를 ${file} 에서 못 찾았다`)
    const body = text.slice(start)
    const out = [...body.matchAll(/^\s{2,4}id: '([^']+)'/gm)].map((m) => m[1])
    if (out.length === 0) throw new Error(`[orca] ${marker} 에서 id 를 하나도 못 읽었다`)
    return [...new Set(out)]
  }
  return {
    finalStep: pick('ONBOARDING_FINAL_STEP'),
    flowVersion: pick('ONBOARDING_FLOW_VERSION'),
    featureTipIds: ids('src/shared/feature-tips.ts', 'export const FEATURE_TIPS = ['),
    featureInteractionIds: ids('src/shared/feature-interaction-catalog.ts', 'export const FEATURE_INTERACTIONS = [')
  }
}

/**
 * 새 userData 에 "온보딩 끝낸 사용자" 프로필을 심는다.
 *
 * 왜: 빈 프로필은 `fixed inset-0 z-[100]` 온보딩 오버레이를 그린다
 * (`tests/e2e/helpers/orca-app.ts:193-202`). 그러면 사이드바를 가린 화면을 재게 된다.
 * **빈 파일을 쓰면 안 된다** — 영속화가 "기존 사용자 업그레이드" 로 읽고 다른 공지를 띄운다(같은 주석).
 */
export function seedOrcaProfile(userDataDir, repoRoot) {
  const c = readOnboardingConstants(repoRoot)
  const seenAt = Date.parse('2026-01-01T00:00:00.000Z')
  const profile = {
    settings: {
      telemetry: { optedIn: true, installId: '00000000-0000-4000-8000-000000000000', existedBeforeTelemetryRelease: false }
    },
    onboarding: { flowVersion: c.flowVersion, closedAt: 1, outcome: 'completed', lastCompletedStep: c.finalStep },
    ui: {
      featureTipsSeenIds: c.featureTipIds,
      featureInteractions: Object.fromEntries(c.featureInteractionIds.map((id) => [id, { firstInteractedAt: seenAt }])),
      contextualToursSeenIds: ['workspace-board', 'browser', 'tasks', 'automations', 'workspace-creation'],
      contextualToursAutoEligible: false,
      projectOrderManualDefaultNoticeDismissed: true,
      browserImportHintHidden: true,
      usagePercentageDisplayChangeNoticeDismissed: true
    }
  }
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(userDataDir, 'orca-data.json'), `${JSON.stringify(profile, null, 2)}\n`)
  return { profile, constants: c }
}

/**
 * 개발 인스턴스를 띄운다.
 *
 * 실행 모드: `electron-vite dev`. 사용자 결정(LA 443)이 "소스 레포의 개발 모드" 이고,
 * `window.__store` 는 `import.meta.env.DEV` 일 때만 노출되기 때문이다
 * (`src/renderer/src/store/index.ts:138`). 빌드 산출물로 띄우면 그 문은 닫히고,
 * 대신 열리는 `VITE_EXPOSE_STORE` 는 터미널·브라우저 페인의 e2e 결함 주입 훅을 함께 켠다
 * (`e2eConfig.enabled = headless || exposeStore || …`) — 측정 대상 화면에 불필요한 변수를 늘린다.
 * 개발 서버 오버레이는 캡처마다 `meta.devOverlays` 로 0 인지 확인한다.
 *
 * `pnpm dev` 가 아니라 그 뒷단 스크립트를 직접 부른다: pnpm 은 자기 설정을 HOME 에서 읽어서
 * 버리는 HOME 아래에서는 엉뚱한 곳을 본다. 의존성 설치는 진짜 HOME 으로 미리 끝내 둔다.
 */
export async function launchOrca({ repoRoot, workDir, port, logPath, headless = false }) {
  await assertPortFree(port, 'orca-dev')
  const userData = path.join(workDir, 'orca-dev-userdata') // 경로에 'orca-dev' 필수 (C2ⓑ, 00-analysis F3)
  const home = path.join(workDir, 'orca-dev-home')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const realHome = fs.realpathSync.native(home)
  if (path.resolve(realHome) === path.resolve(process.env.HOME ?? '')) {
    throw new Error('[orca] 버리는 HOME 이 실제 홈과 같다 — 기동을 거부한다')
  }
  const seeded = seedOrcaProfile(userData, repoRoot)

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIPPED_ENV.has(key)))
  env.HOME = realHome
  env.USERPROFILE = realHome
  env.ORCA_DEV_USER_DATA_PATH = userData
  env.ORCA_USER_DATA_PATH = userData
  env.REMOTE_DEBUGGING_PORT = String(port)
  env.NODE_ENV = 'development'
  env.PATH = `${path.join(process.env.HOME ?? '', '.nvm/versions/node/v24.14.1/bin')}:${env.PATH}`
  if (headless) env.ORCA_BACKGROUND_LAUNCH = '1'

  const logFd = fs.openSync(logPath, 'a')
  const child = spawn(
    process.env.L443_NODE24 ?? path.join(process.env.HOME ?? '', '.nvm/versions/node/v24.14.1/bin/node'),
    [
      'config/scripts/run-electron-vite-dev.mjs',
      // `--` 뒤는 electron-vite 가 `ELECTRON_CLI_ARGS` 로 묶어 Electron 에 그대로 넘긴다
      // (electron-vite@5 `dist/cli.js:59` → `dist/chunks/lib-*.js:224`).
      // `--` 없이 주면 cac 가 자기 옵션으로 읽고 `Unknown option` 으로 죽는다 (첫 기동 실측).
      '--',
      // 격리 프로필이 시스템 키체인 UI 를 띄우면 기동이 렌더러 타깃 전에 멈춘다
      // (Orca 자신의 e2e 가 같은 스위치를 쓴다 — `tests/e2e/helpers/electron-launch-args.ts:5-10`).
      // OS 다이얼로그는 사람 몫이라, 뜨지 않게 막는 것이 이 세 줄의 일이다.
      '--password-store=basic',
      '--use-mock-keychain',
      '-ApplePersistenceIgnoreState',
      'YES'
    ],
    { cwd: repoRoot, env, stdio: ['ignore', logFd, logFd], detached: true }
  )
  fs.closeSync(logFd)
  // 부모(측정 프로세스)가 이 자식 때문에 못 끝나면 안 된다 — 종료는 C12 가 명시적으로 한다.
  child.unref()

  const { target } = await pickTarget(port, {
    label: 'orca-dev',
    // 메인 창만. DevTools·팝아웃(popout.html)·webview 를 뺀다 (K3).
    match: (entry) => /index\.html(\?|$)/.test(entry.url) || (entry.title === 'Orca' && !entry.url.includes('popout')),
    })
  const cdp = await connect(target.webSocketDebuggerUrl)
  await until(() => cdp.evaluate(() => Boolean(window.__store)), 'orca window.__store', 60_000)
  await until(
    () => cdp.evaluate(() => window.__store?.getState().workspaceSessionReady === true),
    'orca workspaceSessionReady',
    90_000
  )
  return { cdp, child, port, paths: { userData, home: realHome, log: logPath }, target, seeded }
}

/** fixture 레포를 등록한다 — UI 의 "Add Project" 와 같은 IPC 경로(Orca e2e 와 동일한 방법). */
export async function seedOrcaRepo(handle, repoPath, { expectedWorktrees = 2 } = {}) {
  const repoId = await handle.cdp.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) throw new Error(result.error)
    return result.repo.id
  }, repoPath)
  await until(
    () =>
      handle.cdp.evaluate(async (repoId) => {
        const store = window.__store
        if (!store) return false
        await store.getState().fetchRepos()
        const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
        if (!repo) return false
        // fixture 는 일부러 외부 worktree 를 만든다. 새 레포는 기본으로 그것을 숨긴다.
        await store.getState().updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
        return true
      }, repoId),
    'orca repo registered',
    60_000
  )
  // **개수를 기다린다, 존재가 아니라.** `>= 1` 로 두면 linked worktree 가 아직 안 올라온 채로
  // 캡처가 시작될 수 있다 — 실측: 같은 명령의 두 회차에서 Orca 카드가 1개/2개로 갈렸고
  // 그것이 C10(재현성)을 깼다. fixture 는 주 체크아웃 + linked = 2개다.
  await until(
    async () => {
      const count = await handle.cdp.evaluate(async (repoId) => {
        const store = window.__store
        if (!store) return 0
        await store.getState().fetchWorktrees(repoId)
        return store.getState().worktreesByRepo[repoId]?.length ?? 0
      }, repoId)
      return count >= expectedWorktrees ? count : null
    },
    `orca worktrees loaded (>=${expectedWorktrees})`,
    60_000
  )
  // 스토어에 있는 것과 **그려진 것**은 다르다. 가상 스크롤이 행을 늦게 붙이므로 DOM 까지 기다린다.
  await until(
    async () => {
      const rendered = await handle.cdp.evaluate(() => document.querySelectorAll('[data-worktree-id]').length)
      return rendered >= expectedWorktrees ? rendered : null
    },
    `orca worktree rows rendered (>=${expectedWorktrees})`,
    60_000
  )
  // 활성 worktree 가 없으면 탭바가 아예 안 그려지고 카드 안 에이전트 목록도 안 뜬다 (실측).
  // Orca 자신의 e2e 도 같은 자리에서 스토어로 활성화한다 (`tests/e2e/helpers/store.ts:186-198`).
  await until(
    () =>
      handle.cdp.evaluate(() => {
        const store = window.__store
        const state = store.getState()
        if (state.activeWorktreeId) return state.activeWorktreeId
        const first = Object.values(state.worktreesByRepo).flat()[0]
        if (!first) return null
        state.setActiveWorktree(first.id)
        return store.getState().activeWorktreeId
      }),
    'orca activeWorktreeId',
    60_000
  )
  return repoId
}

/**
 * 에이전트 상태 주입 (C9) — 기존 경로만 쓴다. 소스 패치 없음.
 * `createTab` 으로 탭(=pane 권한)을 만들고 `setAgentStatus(paneKey, …)` 로 상태를 꽂는다.
 * Orca e2e 가 쓰는 바로 그 호출이다 (`tests/e2e/worktree-lineage-agent-expansion.spec.ts:43-53`).
 */
export async function setOrcaAgents(handle, { repoId, count, states }) {
  return handle.cdp.evaluate(
    async ({ repoId, count, states }) => {
      const store = window.__store
      if (!store) throw new Error('window.__store 없음')
      const worktreeId = store.getState().activeWorktreeId ?? store.getState().worktreesByRepo[repoId]?.[0]?.id
      if (!worktreeId) throw new Error('worktree 없음')
      const state = store.getState()
      // 에이전트 행이 카드 안에 그려지려면 이 표시 속성이 켜져 있어야 한다.
      if (!state.worktreeCardProperties.includes('inline-agents')) state.toggleWorktreeCardProperty('inline-agents')
      while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < count) {
        store.getState().createTab(worktreeId)
      }
      const tabs = (store.getState().tabsByWorktree[worktreeId] ?? []).slice(0, count)
      // 시각은 **지금**이어야 한다: 오래된 타임스탬프는 신선도 검사(`isExplicitAgentStatusFresh`,
      // `AGENT_STATUS_STALE_AFTER_MS`)에 걸려 행이 통째로 사라진다 (실측: 고정 시각이면 0건).
      const now = Date.now()
      const paneKeys = []
      tabs.forEach((tab, index) => {
        const spec = states[index % states.length]
        // leaf id 는 **UUID 여야 한다** — `parsePaneKey` 가 못 읽는 모양이면 행이 조용히 빠진다
        // (실측: `<tabId>:l443-0` 은 0건, `<tabId>:<uuid>` 는 렌더됨).
        const paneKey = `${tab.id}:${crypto.randomUUID()}`
        paneKeys.push(paneKey)
        store
          .getState()
          .setAgentStatus(
            paneKey,
            { state: spec.state, prompt: spec.prompt, agentType: spec.agentType },
            spec.agentType,
            { updatedAt: now, stateStartedAt: now }
          )
      })
      return {
        worktreeId,
        paneKeys,
        tabs: tabs.map((tab) => tab.id),
        // 양성 대조(C6ⓐ)의 전제를 **새 프로필의 실제 값**으로 확인한다 — 코드로 미루지 않는다.
        // 양성 대조(C6ⓐ)의 전제 — 묶음 알약은 compact 표시에서만 뜬다. 코드의 기본값이 아니라
        // **이 프로필의 실제 값**을 원자료로 남긴다.
        agentActivityDisplayMode: store.getState().agentActivityDisplayMode ?? null,
        isAgentSendTargetModeActive: Boolean(store.getState().agentSendPopoverTargetMode),
        worktreeCardProperties: store.getState().worktreeCardProperties
      }
    },
    { repoId, count, states }
  )
}

/** 창 크기를 맞춘다 (대칭성) — 브라우저 수준 세션으로 붙어야 `Browser.*` 가 있다. */
export async function setWindowBounds(handle, size) {
  return setViewport(handle.cdp, size)
}
