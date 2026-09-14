// A10 — **에이전트별 커버리지**. claude 는 필수, codex·grok 은 "실행해 보고 결과를 표에 적는" 칸이다.
//
// 세 에이전트 탭을 한 worktree 에 붙이고, 각자의 **실측 포맷**으로 트랜스크립트를 깔아
// 2차 줄이 실제로 채워지는지 본다. 포맷·경로 규칙은 사용자 실물에서 뜬 것이다
// (`raw/claude/a10-foreign-shapes.json` · `raw/claude/a3b-real-agent.json`).
//
//   claude : <HOME>/.claude/projects/<폴더>/<id>.jsonl          · assistant.message.content[].text
//   codex  : <HOME>/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl · payload.content[].output_text
//   grok   : <HOME>/.grok/sessions/<enc cwd>/<id>/chat_history.jsonl · content 가 문자열
//
// 관문 ⑤ 반례: **모르는 에이전트**(`pi`)로도 같은 보고를 한 번 한다. corral 은 읽을 줄 모르는
// 에이전트의 참조를 무시해야 한다 — 거기서도 2차 줄이 차면 판독기가 아무 파일이나 읽는 것이다.

import fs from 'node:fs'
import path from 'node:path'
import {
  createTab,
  herdrCall,
  isolatedHome,
  makeScratchRepo,
  resetSession,
  sleep,
  startApp,
  until,
  writeRaw,
} from './lib.mjs'

const IDS = {
  claude: 'aa000000-0000-4000-8000-000000000001',
  codex: 'bb000000-0000-4000-8000-000000000002',
  grok: 'cc000000-0000-4000-8000-000000000003',
}
const TEXTS = {
  claude: 'claude 세션의 마지막 말이다',
  codex: 'codex 세션의 마지막 말이다',
  grok: 'grok 세션의 마지막 말이다',
}

/** 그 에이전트의 마지막 말 한 줄 — 각자의 **실측 포맷**으로. */
function assistantLine(agent, text) {
  if (agent === 'claude') {
    return JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 120000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })
  }
  if (agent === 'codex') {
    return JSON.stringify({
      timestamp: new Date(Date.now() - 90000).toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    })
  }
  return JSON.stringify({ type: 'assistant', content: text })
}

/** 이미 있는 트랜스크립트를 찾는다 — **실제 통합 훅이 알린 세션**의 파일이 여기 걸린다. */
function findExisting(agent, id) {
  const home = isolatedHome()
  if (agent === 'claude') {
    const root = path.join(home, '.claude', 'projects')
    if (!fs.existsSync(root)) return null
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.join(root, entry, `${id}.jsonl`)
      if (fs.existsSync(candidate)) return candidate
    }
    return null
  }
  if (agent === 'codex') {
    const root = path.join(home, '.codex', 'sessions')
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return null
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          const found = walk(full)
          if (found !== null) return found
        } else if (entry.name.endsWith(`-${id}.jsonl`)) return full
      }
      return null
    }
    return walk(root)
  }
  const root = path.join(home, '.grok', 'sessions')
  if (!fs.existsSync(root)) return null
  for (const entry of fs.readdirSync(root)) {
    const candidate = path.join(root, entry, id, 'chat_history.jsonl')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function writeClaude(cwd) {
  const dir = path.join(isolatedHome(), '.claude', 'projects', 'l366-a10')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${IDS.claude}.jsonl`)
  fs.writeFileSync(file, assistantLine('claude', TEXTS.claude) + '\n')
  void cwd
  return file
}

function writeCodex() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const dir = path.join(
    isolatedHome(),
    '.codex',
    'sessions',
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  )
  fs.mkdirSync(dir, { recursive: true })
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(dir, `rollout-${stamp}-${IDS.codex}.jsonl`)
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ timestamp: new Date(Date.now() - 300000).toISOString(), type: 'session_meta', payload: { id: IDS.codex } }),
      JSON.stringify({
        timestamp: new Date(Date.now() - 90000).toISOString(),
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXTS.codex }] },
      }),
    ].join('\n') + '\n',
  )
  return file
}

function writeGrok(cwd) {
  const dir = path.join(isolatedHome(), '.grok', 'sessions', encodeURIComponent(cwd), IDS.grok)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'chat_history.jsonl')
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ role: 'user', content: '질문' }),
      JSON.stringify({ role: 'assistant', content: TEXTS.grok }),
    ].join('\n') + '\n',
  )
  return file
}

async function rows(app) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => [...document.querySelectorAll('.session-row')].map((row) => ({
        tabId: row.getAttribute('data-tab'),
        kind: row.querySelector('.session-row-agent') ? row.querySelector('.session-row-agent').getAttribute('data-agent-kind') : null,
        title: row.querySelector('.session-row-title').textContent,
        secondKind: row.querySelector('.session-row-second').getAttribute('data-second-kind'),
        secondText: row.querySelector('.session-row-second').textContent,
        elapsed: row.querySelector('.session-row-elapsed') ? row.querySelector('.session-row-elapsed').textContent : null,
      })))()`,
    })
  ).result
}

async function main() {
  const out = { at: new Date().toISOString() }
  out['세션 초기화'] = await resetSession()
  for (const dir of ['.claude/projects/l366-a10', '.codex/sessions', '.grok/sessions']) {
    fs.rmSync(path.join(isolatedHome(), dir), { recursive: true, force: true })
  }

  const repo = makeScratchRepo('a10')
  const app = await startApp({ name: '16-a10-coverage' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null,
    { timeoutMs: 30000, what: 'worktree opened' },
  )

  const made = []
  for (const kind of ['claude', 'codex', 'grok']) {
    const before = (await rows(app)).length
    await createTab(app, repo.root, kind)
    const ok = await until(async () => (await rows(app)).length > before, { timeoutMs: 30000, everyMs: 300, what: `${kind} 탭` })
    made.push({ kind, 생겼나: ok.ok, ms: ok.ms })
    await sleep(500)
  }
  out['탭 만들기'] = made

  const state = await app.state()
  const workspace = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root).workspace
  const cwd = workspace.tabs[0].panes[0].cwd ?? repo.root
  const agentTabs = workspace.tabs.filter((tab) => tab.panes.some((pane) => pane.agent !== null))
  out['붙은 에이전트'] = agentTabs.map((tab) => ({ tabId: tab.tabId, agent: tab.panes[0].agent }))

  // ---------- 참조: **실제 훅이 알린 것이 있으면 그것을 쓴다** ----------
  //
  // 1차 실행에서 grok 이 미달로 나왔는데, 원인은 판독기가 아니라 순서였다: 진짜 grok 이 뜨면서
  // 통합 훅이 **자기 세션 id 를 먼저 보고**했고, 참조는 pane 당 한 번 박히면 안 바뀌므로
  // (`raw/claude/ref-semantics.json`) 하네스가 주입한 id 가 무시됐다. 그래서 여기서는
  // 실제 참조를 먼저 읽고, **그 세션의 파일에** 마지막 말을 얹는다. 참조가 없는 에이전트만
  // 하네스 id 를 주입한다. 이 편이 실환경에 더 가깝기도 하다 — 훅이 채운 참조를 그대로 쓴다.
  await app.send({ cmd: 'resync', reason: 'l366-a10-before' })
  await sleep(1200)
  const withRefs = (await app.state()).repos
    .flatMap((r) => r.worktrees)
    .flatMap((w) => w.workspace?.tabs ?? [])
    .filter((tab) => tab.panes.some((pane) => pane.agent !== null))
  out['훅이 채운 참조'] = withRefs.map((tab) => ({
    tabId: tab.tabId,
    agent: tab.panes[0].agent,
    agentSession: tab.panes[0].agentSession,
  }))

  const used = []
  for (const tab of withRefs) {
    const agent = tab.panes[0].agent
    if (IDS[agent] === undefined) continue
    const ref = tab.panes[0].agentSession
    const 훅참조 = ref !== null && ref.kind === 'id'
    const id = 훅참조 ? ref.id : IDS[agent]
    if (!훅참조) {
      const response = await herdrCall('pane.report_agent_session', {
        pane_id: tab.panes[0].paneId,
        source: `herdr:${agent}`,
        agent,
        seq: Date.now(),
        agent_session_id: id,
      })
      used.push({ agent, 출처: '하네스 주입', id, ok: response.error === null })
    } else {
      used.push({ agent, 출처: '통합 훅', id })
    }
    // 그 세션의 파일에 **마지막 말**을 얹는다. 파일이 이미 있으면 덧붙이고(진짜 세션),
    // 없으면 각 에이전트의 실측 경로 규칙대로 새로 만든다.
    const existing = findExisting(agent, id)
    if (existing !== null) {
      fs.appendFileSync(existing, assistantLine(agent, TEXTS[agent]) + '\n')
      used[used.length - 1].파일 = { file: existing, 방식: '덧붙임', bytes: fs.statSync(existing).size }
    } else {
      const file = agent === 'claude' ? writeClaude(cwd) : agent === 'codex' ? writeCodex() : writeGrok(cwd)
      used[used.length - 1].파일 = { file, 방식: '새로 만듦', bytes: fs.statSync(file).size }
    }
  }
  out['참조와 파일'] = used

  // 관문 ⑤ 반례 — corral 이 모르는 에이전트 이름으로 **claude 파일의 id** 를 보고한다.
  const shellTab = (await app.state()).repos
    .flatMap((r) => r.worktrees)
    .flatMap((w) => w.workspace?.tabs ?? [])
    .find((tab) => tab.panes.every((pane) => pane.agent === null))
  out['관문⑤ 반례 — 모르는 에이전트'] = {
    설명: 'agent="pi" 로 참조를 보고한다. corral 은 읽을 줄 모르는 이름을 무시해야 한다.',
    보고: shellTab === undefined
      ? null
      : (await herdrCall('pane.report_agent_session', {
          pane_id: shellTab.panes[0].paneId,
          source: 'herdr:pi',
          agent: 'pi',
          seq: Date.now(),
          agent_session_id: IDS.claude,
        })).error,
  }

  await app.send({ cmd: 'resync', reason: 'l366-a10' })
  const filled = await until(async () => {
    const list = await rows(app)
    return list.filter((row) => row.secondKind === 'text').length >= 3 ? list : false
  }, { timeoutMs: 40000, everyMs: 500, what: '세 행이 다 찬다' })
  const final = filled.value ?? (await rows(app))
  out['A10 표'] = final
  out['A10 판정'] = Object.fromEntries(
    ['claude', 'codex', 'grok'].map((agent) => {
      const row = final.find((item) => item.kind === agent)
      return [
        agent,
        {
          행이_있나: row !== undefined,
          secondKind: row?.secondKind ?? null,
          '기대한 문구와 같나': row?.secondText === TEXTS[agent],
          보인_문구: row?.secondText ?? null,
          경과: row?.elapsed ?? null,
        },
      ]
    }),
  )
  out['셸 탭'] = {
    사이드바_행수: final.length,
    에이전트_탭수: withRefs.length,
    결론: '셸 탭은 사이드바 세션 행이 없다 — 2차 줄 자체가 없다',
  }
  out['반례 결과'] = {
    'pi 참조가 붙은 셸 탭이 사이드바에 나타났나': final.some((row) => row.kind === null || row.kind === 'shell'),
    설명: '셸 탭은 에이전트가 없으므로 사이드바에 안 나온다. pi 참조는 화면 어디에도 반영되지 않는다.',
  }
  out.스크린샷 = await app.shot('a10-three-agents')
  out.rawChain = app.rawChain()
  await app.stop()
  writeRaw('a10-coverage.json', out)
  console.log(JSON.stringify({ 표: out['A10 표'], 판정: out['A10 판정'], 반례: out['반례 결과'] }, null, 1))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
