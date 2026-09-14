// A3ⓑ — **진짜 에이전트**를 격리 HOME 의 herdr pane 에 띄워 `agent_session` 이 오는지 본다.
//
// 훅은 `SessionStart` 에 걸려 있다 — 즉 **LLM 턴이 성공하지 않아도** 기동만 하면 보고가 간다.
// (헤드리스 사전 확인에서 격리 HOME 의 claude 는 인증은 통과하고 `Credit balance is too low`
//  로 턴이 막혔다. 그 상태에서도 SessionStart 는 났고 트랜스크립트 파일은 생겼다 — 아래가
//  herdr 경로까지 이어지는지를 잰다.)
//
// 겸해서 **id → 파일 경로 해소 규칙**을 실측한다. herdr 가 주는 것은 id 뿐이므로
// (`a3-agent-session-probe.json`: 3종 모두 kind='id') corral 은 파일을 스스로 찾아야 한다.
// 사전 확인이 보인 규칙: `<HOME>/.claude/projects/<cwd 를 '-' 로 바꾼 슬러그>/<session-id>.jsonl`.

import fs from 'node:fs'
import path from 'node:path'
import { ensureSession, herdrCall, herdrRequest, isolatedHome, makeScratchRepo, sleep, until, writeRaw } from './lib.mjs'

const AGENTS = ['claude', 'codex', 'grok']

/**
 * 세션 id 로 트랜스크립트 파일을 찾는다 — `src/main/transcript.ts` 가 구현한 것과 **같은 규칙**을
 * 하네스 쪽에서 독립 구현한 것이다. 제3 오라클이라 일부러 코드를 공유하지 않는다.
 */
function resolveTranscript(home, agent, id) {
  const exists = (file) => (fs.existsSync(file) ? { file, bytes: fs.statSync(file).size } : null)
  if (agent === 'claude') {
    const root = path.join(home, '.claude/projects')
    if (!fs.existsSync(root)) return null
    for (const entry of fs.readdirSync(root)) {
      const hit = exists(path.join(root, entry, `${id}.jsonl`))
      if (hit !== null) return hit
    }
    return null
  }
  if (agent === 'codex') {
    const root = path.join(home, '.codex/sessions')
    if (!fs.existsSync(root)) return null
    const dirs = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
    for (const year of dirs(root)) {
      for (const month of dirs(year)) {
        for (const day of dirs(month)) {
          for (const file of fs.readdirSync(day)) {
            if (file.endsWith(`-${id}.jsonl`)) return exists(path.join(day, file))
          }
        }
      }
    }
    return null
  }
  const root = path.join(home, '.grok/sessions')
  if (!fs.existsSync(root)) return null
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const hit = exists(path.join(root, entry.name, id, 'chat_history.jsonl'))
    if (hit !== null) return hit
  }
  return null
}

/** pane.read 응답에서 화면 텍스트를 꺼낸다 (봉투 모양이 갈릴 수 있어 넓게 훑는다). */
function screenText(response) {
  const text = response?.result?.read?.text ?? response?.result?.text
  if (typeof text !== 'string') return response?.result === undefined ? null : JSON.stringify(response.result).slice(0, 600)
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-14)
}

async function main() {
  const home = isolatedHome()
  await ensureSession()
  const scratch = makeScratchRepo('a3b')
  const results = []
  const opened = []

  for (const agent of AGENTS) {
    const created = await herdrRequest('workspace.create', { cwd: scratch.root })
    const workspaceId = created?.workspace?.workspace_id ?? created?.workspace_id
    opened.push(workspaceId)
    await until(async () => (await herdrRequest('pane.list', { workspace_id: workspaceId }))?.panes?.length > 0, {
      timeoutMs: 15000,
      everyMs: 100,
      what: 'pane',
    })
    const paneId = (await herdrRequest('pane.list', { workspace_id: workspaceId })).panes[0].pane_id
    const startedAt = Date.now()
    // herdr `agent.start` 는 `name`(호출자가 정하는 에이전트 이름) + `kind` 를 받는다 —
    // corral lifecycle.ts 와 같은 관용구다. 1회차는 `agent` 로 보내 invalid_request 였다.
    const start = await herdrCall('agent.start', {
      pane_id: paneId,
      name: `l366-${agent}-${Date.now()}`,
      kind: agent,
    })
    // 훅은 에이전트가 실제로 뜬 뒤에 난다 — 넉넉히 기다린다. 못 오면 그 사실을 적는다.
    const seen = await until(
      async () => (await herdrRequest('pane.get', { pane_id: paneId })).pane?.agent_session ?? null,
      // grok 은 1회차에서 **60.4초** 만에 왔다 (raw/claude/_discarded 참고) — 넉넉히 준다.
      { timeoutMs: 180000, everyMs: 250, what: `${agent} agent_session` },
    )
    const pane = (await herdrRequest('pane.get', { pane_id: paneId })).pane
    const screen = await herdrCall('pane.read', { pane_id: paneId, source: 'visible', lines: 40 }).catch(() => null)

    // id → 파일 해소 — **에이전트마다 규칙이 다르다** (raw/claude/a10-foreign-shapes.json).
    const sessionId = pane?.agent_session?.value ?? null
    const resolved = sessionId === null ? null : resolveTranscript(home, agent, sessionId)

    results.push({
      agent,
      workspaceId,
      paneId,
      startError: start.error,
      reachedMs: seen.ok ? Date.now() - startedAt : null,
      agentSession: pane?.agent_session ?? null,
      agentStatus: pane?.agent_status ?? null,
      terminalTitle: pane?.terminal_title ?? null,
      terminalTitleStripped: pane?.terminal_title_stripped ?? null,
      /** 화면 마지막 몇 줄 — 막혔다면 **무엇에 막혔는지**가 여기 남는다 (기준 A3 "막힌 사유"). */
      screenTail: screenText(screen),
      resolvedTranscript: resolved,
    })
  }

  const summary = {
    at: new Date().toISOString(),
    isolatedHome: home,
    scratchRepo: scratch.root,
    cwdSlugRule: '<HOME>/.claude/projects/<cwd 의 / 를 - 로> / <session-id>.jsonl',
    results,
    verdict: Object.fromEntries(
      results.map((row) => [
        row.agent,
        {
          agentSession: row.agentSession !== null,
          transcriptResolved: row.resolvedTranscript !== null,
        },
      ]),
    ),
  }
  writeRaw('a3b-real-agent.json', summary)
  console.log(JSON.stringify(summary.verdict, null, 2))
  for (const workspaceId of opened) {
    await herdrRequest('workspace.close', { workspace_id: workspaceId, close_group: false }).catch(() => {})
  }
  await sleep(500)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
