// A3ⓐ — 통합 훅 경로만으로 `agent_session` 이 채워지는가 (에이전트 기동 없이).
//
// 02-kickoff.md 함정 ① 이 이 프로브의 존재 이유다: 격리 HOME 의 진짜 claude 는 신뢰 확인 화면에
// 막힐 수 있으므로, herdr 쪽 경로는 **훅 스크립트를 직접 태워** 따로 증명한다.
// 훅은 `HERDR_ENV=1` · `HERDR_SOCKET_PATH` · `HERDR_PANE_ID` 를 보고 stdin 의 SessionStart
// payload 를 `pane.report_agent_session` 으로 소켓에 넘길 뿐이다.
//
// ⚠ 훅은 **모든 실패에서 exit 0** 이다 (env 없음·payload 불일치 전부 조용히 종료).
// 그래서 이 게이트는 종료코드를 보지 않는다 — **소켓으로 되읽은 `agent_session`** 만 본다.
// 관문 ⑤ 반례: 일부러 틀린 pane id 로 같은 훅을 태워 게이트가 **실패하는 것**을 같이 남긴다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  SESSION,
  ensureSession,
  herdrRequest,
  installIntegration,
  integrationStatus,
  isolatedEnv,
  isolatedHome,
  makeScratchRepo,
  sleep,
  until,
  writeRaw,
} from './lib.mjs'

const TARGETS = ['claude', 'codex', 'grok']

/** 훅 스크립트 경로 — 격리 HOME 기준. 통합마다 자리가 다르다 (integration status 출력과 같은 값). */
function hookPath(home, target) {
  if (target === 'claude') return path.join(home, '.claude/hooks/herdr-agent-state.sh')
  if (target === 'codex') return path.join(home, '.codex/herdr-agent-state.sh')
  return path.join(home, '.grok/hooks/herdr-agent-state.sh')
}

/** 훅을 한 번 태운다. stdin = 합성 SessionStart payload, argv[1] = 'session'. */
function fireHook({ home, target, paneId, socketPath, payload, extraEnv = {} }) {
  const script = hookPath(home, target)
  const startedAt = Date.now()
  let exitCode = 0
  let stderr = ''
  try {
    execFileSync('sh', [script, 'session'], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...isolatedEnv(),
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: socketPath,
        HERDR_PANE_ID: paneId,
        ...extraEnv,
      },
    })
  } catch (error) {
    exitCode = error.status ?? -1
    stderr = String(error.stderr ?? '')
  }
  return { script, exitCode, stderr, ms: Date.now() - startedAt, payload }
}

/** 에이전트가 한 번도 보고되지 않은 새 pane 하나 (워크스페이스째로 연다). */
async function freshPane(scratchRoot) {
  const created = await herdrRequest('workspace.create', { cwd: scratchRoot })
  const workspaceId = created?.workspace?.workspace_id ?? created?.workspace_id
  await until(async () => (await herdrRequest('pane.list', { workspace_id: workspaceId }))?.panes?.length > 0, {
    timeoutMs: 15000,
    everyMs: 100,
    what: 'pane',
  })
  const panes = (await herdrRequest('pane.list', { workspace_id: workspaceId })).panes
  return { workspaceId, paneId: panes[0].pane_id }
}

/** herdr 가 아는 그 pane 의 agent_session (없으면 null). **게이트의 판별자는 이것뿐이다.** */
async function readAgentSession(paneId) {
  const result = await herdrRequest('pane.get', { pane_id: paneId })
  const pane = result?.pane ?? result
  return pane?.agent_session ?? null
}

async function main() {
  const home = isolatedHome()
  const session = await ensureSession()
  const socketPath = session.socket

  // ① 통합 설치 — 격리 HOME 안에서만.
  const installs = TARGETS.map((target) => ({ target, output: installIntegration(target) }))
  const statusIsolated = integrationStatus({ home: 'isolated' })
  const statusReal = integrationStatus({ home: 'real' })

  // ② 격리 세션에 workspace + pane 을 만든다 (사용자 레포 불가침 — 스크래치 레포 위에서).
  const scratch = makeScratchRepo('a3')
  const created = await herdrRequest('workspace.create', { cwd: scratch.root })
  const workspaceId = created?.workspace?.workspace_id ?? created?.workspace_id
  await until(async () => (await herdrRequest('pane.list', { workspace_id: workspaceId }))?.panes?.length > 0, {
    timeoutMs: 15000,
    everyMs: 100,
    what: 'first pane',
  })
  const panes = (await herdrRequest('pane.list', { workspace_id: workspaceId })).panes
  const paneId = panes[0].pane_id
  const openedWorkspaces = [workspaceId]

  const before = await readAgentSession(paneId)

  // ③ 관문 ⑤ 반례 — **틀린 pane id** 로 태운다. 게이트가 아무것도 안 해도 통과하면 안 된다.
  const bogusPaneId = `${paneId}-nope`
  const counterFire = fireHook({
    home,
    target: 'claude',
    paneId: bogusPaneId,
    socketPath,
    payload: {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'counterexample-0000',
      transcript_path: '/tmp/l366-counterexample.jsonl',
    },
  })
  await sleep(500)
  const afterCounter = await readAgentSession(paneId)
  const counterexample = {
    what: '틀린 pane id 로 훅을 태우면 게이트가 실패해야 한다',
    hookExitCode: counterFire.exitCode,
    note: '훅은 실패해도 exit 0 이다 — 종료코드는 판별자가 아니다',
    agentSessionAfter: afterCounter,
    gatePasses: afterCounter !== null,
    verdict: afterCounter === null ? '반례 확인: 게이트가 실패한다' : '⚠ 게이트가 무의미하다',
  }

  // ④ 본 실행 — 통합 3종을 각각 **새 pane** 에 태운다.
  //
  // 같은 pane 을 재사용하면 안 된다: `02-ref-semantics.mjs` 가 herdr 의 `agent_session` 이
  // **한 번 박히면 안 바뀐다**는 것을 실측했다 (새 id·다른 에이전트·null 전부 무시).
  // 이 프로브 1회차가 정확히 그 함정에 빠져 codex·grok 이 "안 왔다"로 나왔다.
  const fires = []
  for (const target of TARGETS) {
    const lane = await freshPane(scratch.root)
    openedWorkspaces.push(lane.workspaceId)
    const paneId = lane.paneId
    const sessionId = `l366-${target}-${Date.now()}`
    const transcriptPath = path.join(home, `.${target}-transcript-${sessionId}.jsonl`)
    fs.writeFileSync(transcriptPath, '')
    const payload = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: sessionId,
      transcript_path: transcriptPath,
    }
    const firedAt = Date.now()
    const fire = fireHook({
      home,
      target,
      paneId,
      socketPath,
      payload,
      // grok 훅은 payload 의 session_id 보다 GROK_SESSION_ID 환경변수를 먼저 본다.
      extraEnv: target === 'grok' ? { GROK_SESSION_ID: sessionId } : {},
    })
    const seen = await until(
      async () => {
        const value = await readAgentSession(paneId)
        return value !== null && value.value === (value.kind === 'path' ? transcriptPath : sessionId)
          ? value
          : null
      },
      { timeoutMs: 5000, everyMs: 50, what: `${target} agent_session` },
    )
    const observed = await readAgentSession(paneId)
    fires.push({
      target,
      paneId,
      sentSessionId: sessionId,
      sentTranscriptPath: transcriptPath,
      hookExitCode: fire.exitCode,
      hookMs: fire.ms,
      /** 훅을 태운 뒤 herdr 가 그 값을 돌려주기까지 (읽기 폴링 50ms 해상도). */
      propagationMs: seen.ok ? Date.now() - firedAt : null,
      reached: seen.ok,
      agentSession: observed,
      /** 이 통합이 **경로를 주는가 id 만 주는가** — 꼬리 읽기 설계가 여기 달렸다. */
      refKind: observed?.kind ?? null,
    })
  }

  const result = {
    at: new Date().toISOString(),
    session: SESSION,
    isolatedHome: home,
    socketPath,
    scratchRepo: scratch.root,
    workspaceId,
    paneId,
    agentSessionBefore: before,
    installs,
    integrationStatus: {
      isolated: statusIsolated.rows,
      real: statusReal.rows,
      /** 격리 확인 — 사용자 HOME 은 3종 모두 not installed 여야 한다 (관문 ④). */
      realUntouched: TARGETS.every((target) => (statusReal.rows[target] ?? '').startsWith('not installed')),
    },
    counterexample,
    fires,
    verdict: {
      a3a: fires.every((fire) => fire.reached),
      refKinds: Object.fromEntries(fires.map((fire) => [fire.target, fire.refKind])),
    },
  }
  writeRaw('a3-agent-session-probe.json', result)
  console.log(JSON.stringify(result.verdict, null, 2))
  console.log('counterexample:', counterexample.verdict)
  for (const id of openedWorkspaces) {
    await herdrRequest('workspace.close', { workspace_id: id, close_group: false }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
