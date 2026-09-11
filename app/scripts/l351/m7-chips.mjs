// M7 — N8(상태 칩은 정직하다). **칩이 구분하는 상태 전부**를 만들어 보고 오라클과 맞춘다.
//
// 이 구현이 노출하기로 한 칩은 셋이고, 각각의 오라클은 herdr 다 (R1 은 상태를 만들지 않는다):
//   ① worktree 열림/닫힘 → `worktree.list` 의 `open_workspace_id` 유무
//   ② pane 에이전트 상태 → `pane.list` 의 `agent_status` (미상·대기·작업중·막힘 **4종**)
//   ③ pane 에이전트 이름 → `pane.list` 의 `agent`
//
// 상태를 어떻게 만드나: herdr 의 `pane.report_agent` 로 **하네스가 밖에서** 상태를 심는다.
// 심는 쪽도 herdr 의 정식 경로고 그 결과는 `pane.list` 에 그대로 나오므로 오라클은 여전히 herdr 다.
//
// **`done` 은 이제 노출하지 않는다** (수정 1회차 M7). 1회차는 `done` 을 칩 어휘에 넣어 놓고
// 라이브 대조 없이 "통과(공백 1)" 로 적었고, 기준 N8("노출한 것 **전부** 대조")이 그걸 허락하지
// 않는다는 판정을 받았다. 사실관계는 이렇다:
//   · herdr 0.9.0 스키마 `AgentStatus`(이벤트·스냅샷·응답)에는 `done` 이 **있다**
//   · `pane.report_agent` 가 받는 `PaneAgentState` 에는 **없다** — 그래서 그 거절은 스키마와 일치한다
//   · 설치된 탐지 매니페스트가 쓰는 state 는 blocked·idle·unknown·working 넷뿐이다
// 즉 0.9.0 은 `done` 을 만들지 않는다. 만들 수 없는 값을 칩으로 노출하면 영영 대조할 수 없으므로
// 칩 어휘에서 뺐다. 어댑터는 `done` 이 와도 **미상으로 옮기고 로그에 남긴다** — 그 동작을
// 여기서 실측으로 확인한다 (아래 `done 처리 재생`).
//
// 읽는 쪽은 **DOM 이다**: 앱 상태 객체가 아니라 화면에 실제로 그려진 `data-chip-value` 를 읽는다.

import { REPO_DIR, look, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

/** 라이브로 만들 수 있는 상태. `done` 은 아래에서 거절당하는 것을 실측으로 남긴다. */
const STATES = ['working', 'idle', 'blocked']

/** 설치된 탐지 매니페스트가 실제로 내는 state 집합 — `done` 이 없다는 주장의 실물 근거. */
const manifestStates = await (async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const pathMod = await import('node:path')
  const dir = pathMod.join(os.homedir(), '.local/state/herdr/agent-detection/remote')
  try {
    const found = new Set()
    for (const name of fs.readdirSync(dir)) {
      for (const match of fs.readFileSync(pathMod.join(dir, name), 'utf8').matchAll(/state\s*=\s*"(\w+)"/g)) {
        found.add(match[1])
      }
    }
    return [...found].sort()
  } catch (error) {
    return { 못읽음: String(error) }
  }
})()

await tidySession(REPO_DIR)
const app = await startApp({ name: 'n8-chips' })
await sleep(800)
await app.addRepo(REPO_DIR)
await until(async () => (await app.state()).repos.length === 1, { what: '레포 등록' })
await until(async () => (await look(app)).일치, { what: '출발 수렴', timeoutMs: 10000, everyMs: 40 })

const out = { at: new Date().toISOString(), 노출하는칩: {}, 대조: [] }

/** 화면에서 그 칩의 값을 **DOM 으로** 읽는다. */
async function chip(selector) {
  const response = await app.send({ cmd: 'query', selector })
  return response.found
}
async function chipValue(attr, key) {
  const response = await app.send({
    cmd: 'query',
    selector: `[${attr}="${key}"]`,
  })
  return response.found[0] ?? null
}

// ── ① worktree 열림/닫힘 ────────────────────────────────────────────────────
{
  const state = await app.state()
  const repo = state.repos[0]
  const herdr = await request('worktree.list', { cwd: repo.root })
  const oracle = new Map(herdr.worktrees.map((item) => [item.path, item.open_workspace_id ?? null]))
  const rows = []
  for (const worktree of repo.worktrees) {
    // DOM 의 data-chip-value 를 직접 읽는다 (상태 객체가 아니라 화면).
    const dom = await app.send({ cmd: 'query', selector: `[data-chip-worktree="${worktree.path}"]` })
    rows.push({
      path: worktree.path,
      화면칩: dom.found[0] ?? null,
      herdr_open: oracle.get(worktree.path) ?? null,
      기대: (oracle.get(worktree.path) ?? null) === null ? '닫힘' : '열림',
      일치: (dom.found[0] ?? null) === ((oracle.get(worktree.path) ?? null) === null ? '닫힘' : '열림'),
    })
  }
  out.노출하는칩['① worktree 열림/닫힘'] = { 오라클: 'herdr worktree.list 의 open_workspace_id', 값: ['열림', '닫힘'] }
  out.대조.push({ 칩: '① worktree 열림/닫힘', rows, 샷: (await app.shot('n8-worktree-chips')).file })
}

// ── ②③ pane 에이전트 상태·이름 ─────────────────────────────────────────────
{
  const panes = (await request('pane.list', {})).panes
  const paneId = panes[0].pane_id
  const rows = []

  // 시작값(미상) 먼저 — 아무것도 심지 않은 상태다.
  {
    const truth = (await request('pane.list', {})).panes.find((item) => item.pane_id === paneId)
    const status = await chipValue('data-chip-pane', paneId)
    const agent = await chipValue('data-chip-agent', paneId)
    rows.push({
      심은상태: '(없음 — 시작값)',
      herdr_agent_status: truth.agent_status,
      herdr_agent: truth.agent ?? null,
      화면_상태칩: status,
      화면_이름칩: agent,
      일치: status === '미상' && truth.agent_status === 'unknown' && agent === null,
      샷: (await app.shot(`n8-pane-unknown`)).file,
    })
  }

  for (const state of STATES) {
    await request('pane.report_agent', { pane_id: paneId, source: 'l351-harness', agent: 'claude', state })
    // 화면이 그 값을 들 때까지 본다 — 고정 대기로 판정하지 않는다.
    const label = { working: '작업중', idle: '대기', blocked: '막힘' }[state]
    const seen = await until(async () => ((await chipValue('data-chip-pane', paneId)) === label ? label : null), {
      what: `칩 ${label}`,
      timeoutMs: 8000,
      everyMs: 60,
    })
    // **오라클은 같은 시각의 herdr 다.**
    const truth = (await request('pane.list', {})).panes.find((item) => item.pane_id === paneId)
    const status = await chipValue('data-chip-pane', paneId)
    const agent = await chipValue('data-chip-agent', paneId)
    rows.push({
      심은상태: state,
      반영ms: seen.ms,
      herdr_agent_status: truth.agent_status,
      herdr_agent: truth.agent ?? null,
      화면_상태칩: status,
      화면_이름칩: agent,
      일치: status === label && truth.agent_status === state && agent === (truth.agent ?? null),
      샷: (await app.shot(`n8-pane-${state}`)).file,
    })
  }

  // 에이전트를 떼면 미상으로 돌아가야 한다 (released 경로).
  await request('pane.release_agent', { pane_id: paneId, source: 'l351-harness', agent: 'claude' })
  const back = await until(async () => ((await chipValue('data-chip-pane', paneId)) === '미상' ? '미상' : null), {
    what: '미상 복귀',
    timeoutMs: 8000,
    everyMs: 60,
  })
  {
    const truth = (await request('pane.list', {})).panes.find((item) => item.pane_id === paneId)
    const status = await chipValue('data-chip-pane', paneId)
    const agent = await chipValue('data-chip-agent', paneId)
    rows.push({
      심은상태: '(뗌 — release_agent)',
      반영ms: back.ms,
      herdr_agent_status: truth.agent_status,
      herdr_agent: truth.agent ?? null,
      화면_상태칩: status,
      화면_이름칩: agent,
      일치: status === '미상' && truth.agent_status === 'unknown' && agent === (truth.agent ?? null),
      샷: (await app.shot('n8-pane-released')).file,
    })
  }

  // `done` 은 **만들어 보려다 거절당한 것**을 그대로 싣는다. 안 해 본 것과 못 한 것은 다르다.
  let doneRejection = null
  try {
    await request('pane.report_agent', { pane_id: paneId, source: 'l351-harness', agent: 'claude', state: 'done' })
    doneRejection = '(거절되지 않았다 — 기준을 다시 본다)'
  } catch (error) {
    doneRejection = String(error)
  }

  out.노출하는칩['② pane 에이전트 상태'] = {
    오라클: 'herdr pane.list 의 agent_status',
    값: ['미상(unknown)', '대기(idle)', '작업중(working)', '막힘(blocked)'],
    'done 을 노출하지 않는다 (수정 1회차 M7)': {
      '스키마 AgentStatus (이벤트·스냅샷·응답)': ['idle', 'working', 'blocked', 'done', 'unknown'],
      '스키마 PaneAgentState (report_agent 입력)': ['idle', 'working', 'blocked', 'unknown'],
      거절응답: doneRejection,
      '거절은 스키마와 일치한다': String(doneRejection).includes('unknown variant'),
      탐지매니페스트가쓰는state: manifestStates,
      결론: '0.9.0 은 done 을 만들지 않는다 → 칩 어휘에서 뺐다. 오면 미상으로 옮기고 로그에 남긴다',
    },
  }
  out.노출하는칩['③ pane 에이전트 이름'] = { 오라클: 'herdr pane.list 의 agent', 값: '문자열 또는 없음' }
  out.대조.push({ 칩: '②③ pane 에이전트 상태·이름', paneId, rows })
}

// `done` 처리 재생 — herdr 가 언제든 이 값을 보내면 어댑터가 무엇을 하나 (수정 1회차 M7).
// 이건 "노출한 칩을 대조한 근거" 가 아니라 "노출하지 않는 값이 와도 안전한가" 의 근거다.
{
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const pathMod = await import('node:path')
  const { APP_DIR } = await import('./lib.mjs')
  const outFile = pathMod.join(fs.mkdtempSync('/tmp/l351-done-'), 'store.mjs')
  execFileSync(pathMod.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    pathMod.join(APP_DIR, 'src/main/adapter/internal/store.ts'),
    '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`,
  ])
  const { WorkspaceStore } = await import(outFile)
  const store = new WorkspaceStore()
  store.applyEvent({ event: 'workspace_created', data: { workspace: { workspace_id: 'wZ', label: 'z', number: 1 } } })
  store.applyEvent({ event: 'tab_created', data: { tab: { tab_id: 'wZ:t1', workspace_id: 'wZ', number: 1 } } })
  store.applyEvent({ event: 'pane_created', data: { pane: { pane_id: 'wZ:p1', workspace_id: 'wZ', tab_id: 'wZ:t1' } } })
  store.applyEvent({
    event: 'pane_agent_status_changed',
    data: { pane_id: 'wZ:p1', workspace_id: 'wZ', agent: 'claude', agent_status: 'done' },
  })
  const row = store.rows()[0].tabs[0].panes[0]
  out['done 처리 재생'] = {
    '들어온 값': 'done',
    '저장소가 든 값': row.agentStatus,
    '화면 라벨': row.agentStatus === 'unknown' ? '미상' : `(칩 어휘에 없는 값: ${row.agentStatus})`,
    agent: row.agent,
  }
}

out.전체칩목록 = { 'data-chip-worktree': await chip('[data-chip-worktree]'), 'data-chip-pane': await chip('[data-chip-pane]') }
/**
 * 화면이 실제로 그릴 수 있는 라벨 전부 — **소스에서 뽑아 대조 목록과 맞춘다** (M7).
 * 문서에 적은 목록과 코드가 갈라지면 "노출한 것 전부를 대조했다" 가 다시 거짓이 된다.
 */
const labelSource = (await import('node:fs')).readFileSync(
  (await import('node:path')).join((await import('./lib.mjs')).APP_DIR, 'src/renderer/src/App.tsx'),
  'utf8',
)
const labelBlock = /const STATUS_LABEL: Record<AgentStatus, string> = \{([^}]*)\}/.exec(labelSource)?.[1] ?? ''
const 코드의칩어휘 = [...labelBlock.matchAll(/(\w+):/g)].map((match) => match[1]).sort()
const 대조한상태 = ['blocked', 'idle', 'unknown', 'working']

out.판정 = {
  '노출하는 칩 수': Object.keys(out.노출하는칩).length,
  '① worktree 칩 전부 일치': out.대조[0].rows.every((row) => row.일치),
  코드의칩어휘,
  '코드의 칩 어휘 = 대조한 상태 (노출한 것 전부를 댔나)': JSON.stringify(코드의칩어휘) === JSON.stringify(대조한상태),
  '② 만들 수 있는 상태를 전부 대조했나 (미상·작업중·대기·막힘 + 뗌)': out.대조[1].rows.length === 5,
  '②③ pane 칩 전부 일치': out.대조[1].rows.every((row) => row.일치),
  'done 은 노출하지 않는다': !코드의칩어휘.includes('done'),
  'done 이 와도 미상으로 간다': out['done 처리 재생']?.['저장소가 든 값'] === 'unknown',
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n8-chips.json', out)
await app.stop()
await tidySession(REPO_DIR)
