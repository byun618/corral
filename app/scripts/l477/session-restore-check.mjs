// LIFE-477 수정 라운드 1 (R2) — herdr 서버를 띄우기 **전에** session.json 에서 다시 붙을(복구될) 에이전트 pane 을 센다.
// 복구 대상 = `agent_session` 이 남은 pane(herdr 0.9.0 은 서버 기동 때 그 세션을 다시 띄운다 — 477 K10 에서 claude 1·grok 2 가 다시 붙었다).
// 출력은 개수와 provider 종류별 개수뿐이다(경로·세션 id·대화 없음). 1개 이상이면 exit 7 — `--allow-session-restore` 를 줄 때만 0.
// 라운드 2 (R2-01): herdr 가 읽는 두 형식을 모두 센다 — 현재 `workspaces[].tabs[].panes` · 구형 `workspaces[].panes`(LegacyWorkspaceSnapshot 이관, agent_session 보존).
// 그 밖의 구조는 0 으로 통과시키지 않고 exit 8(허용 플래그로도 못 넘김).
// 라운드 3 (R3-01): 형식 판별은 **upstream 순서 그대로** — herdr 고정 commit b99002ac99b09e00b4ca692436cb15a6b0d676f1 `src/persist/snapshot.rs`
// `migrate_workspace`(L205 부근): `identity_cwd` 가 있으면 현재 형식, 없고 `layout` 이 있으면 구형. 둘 다 아니면 모르는 구조.
// 구형은 `deny_unknown_fields` 가 없어 덧붙은 `tabs` 를 무시하고 `panes` 를 옮긴다 — 그래서 `tabs` 유무로 먼저 고르면 구형 pane 을 건너뛴다(r2 결함).
// 사용: node session-restore-check.mjs <session.json> [--allow-session-restore]
//       node session-restore-check.mjs --self-check   (합성 session.json 으로 멈춤/진행·허용 플래그를 본다 — 사용자 파일 무접촉)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 복구 대상 에이전트 pane — 종류별 개수. 파일이 없으면 0(복구할 것이 없다). 모르는 구조는 `unknown` 에 이유를 싣는다. */
export function restoreTargets(file) {
  if (!fs.existsSync(file)) return { count: 0, agents: {}, unknown: null }
  const session = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!isRecord(session)) return { count: 0, agents: {}, unknown: 'session 이 객체가 아니다' }
  const workspaces = session.workspaces ?? []
  if (!Array.isArray(workspaces)) return { count: 0, agents: {}, unknown: 'workspaces 가 배열이 아니다' }
  const paneMaps = []
  for (const [index, workspace] of workspaces.entries()) {
    if (!isRecord(workspace)) return { count: 0, agents: {}, unknown: `workspace ${index} 가 객체가 아니다` }
    if ('identity_cwd' in workspace) {
      // 현재 형식 — tabs[].panes
      if (!Array.isArray(workspace.tabs)) return { count: 0, agents: {}, unknown: `workspace ${index} 는 현재 형식(identity_cwd)인데 tabs 가 배열이 아니다` }
      for (const [tabIndex, tab] of workspace.tabs.entries()) {
        if (!isRecord(tab) || !isRecord(tab.panes)) return { count: 0, agents: {}, unknown: `workspace ${index} tab ${tabIndex} 의 panes 를 모른다` }
        paneMaps.push(tab.panes)
      }
    } else if ('layout' in workspace) {
      // 구형 — workspace 가 pane 을 직접 든다(덧붙은 tabs 는 upstream 처럼 무시)
      if (!isRecord(workspace.panes)) return { count: 0, agents: {}, unknown: `workspace ${index} 는 구형(layout)인데 panes 가 객체가 아니다` }
      paneMaps.push(workspace.panes)
    } else {
      return { count: 0, agents: {}, unknown: `workspace ${index} 구조를 모른다(identity_cwd 도 layout 도 없다)` }
    }
  }
  const agents = {}
  let count = 0
  for (const panes of paneMaps)
    for (const pane of Object.values(panes)) {
      if (!isRecord(pane) || pane.agent_session === undefined || pane.agent_session === null) continue
      count += 1
      const kind = typeof pane.agent_session.agent === 'string' ? pane.agent_session.agent : 'unknown'
      agents[kind] = (agents[kind] ?? 0) + 1
    }
  return { count, agents, unknown: null }
}

function selfCheck() {
  const here = fileURLToPath(import.meta.url)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l477-restorecheck-'))
  const agent = (kind) => ({ cwd: '/synthetic', agent_session: { agent: kind, kind: 'id', source: `herdr:${kind}`, value: 'x' } })
  const shell = { cwd: '/synthetic' }
  const write = (name, session) => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, JSON.stringify(session))
    return file
  }
  const current = (panes) => ({ version: 1, workspaces: [{ id: 'w1', identity_cwd: '/synthetic', tabs: [{ layout: { Pane: 1 }, panes }] }] })
  const legacy = (panes) => ({ version: 1, workspaces: [{ id: 'w1', layout: { Pane: 1 }, panes, zoomed: false }] })
  const files = {
    current2: write('current2.json', current({ 1: shell, 2: agent('claude'), 3: agent('grok') })),
    currentShell: write('current-shell.json', current({ 1: shell })),
    legacy1: write('legacy1.json', legacy({ 1: shell, 2: agent('claude') })),
    legacyShell: write('legacy-shell.json', legacy({ 1: shell })),
    mixed: write('mixed.json', { version: 1, workspaces: [current({ 1: agent('claude') }).workspaces[0], legacy({ 1: agent('codex') }).workspaces[0]] }),
    empty: write('empty.json', { version: 1, workspaces: [] }),
    unknownWs: write('unknown-ws.json', { version: 1, workspaces: [{ id: 'w1', panes: { 1: agent('claude') } }] }),
    unknownTab: write('unknown-tab.json', { version: 1, workspaces: [{ id: 'w1', identity_cwd: '/synthetic', tabs: [{ layout: { Pane: 1 } }] }] }),
    // r3 — 코디 재현 입력 c48-r3-01-mixed.json(구형 + 덧붙은 빈 tabs) · c48-r3-01-tabsonly.json 그대로
    legacyExtraTabs: write('legacy-extra-tabs.json', { version: 3, active: 0, selected: 0, workspaces: [{ layout: { Pane: 1 }, panes: { 1: { cwd: '/synthetic', agent_session: { source: 'herdr:claude', agent: 'claude', kind: 'id', value: '11111111-1111-4111-8111-111111111111' } } }, zoomed: false, focused: 1, root_pane: 1, tabs: [] }] }),
    tabsOnly: write('tabs-only.json', { version: 3, workspaces: [{ tabs: [] }] }),
    currentBadTabs: write('current-bad-tabs.json', { version: 1, workspaces: [{ id: 'w1', identity_cwd: '/synthetic', tabs: {} }] }),
    legacyBadPanes: write('legacy-bad-panes.json', { version: 1, workspaces: [{ id: 'w1', layout: { Pane: 1 }, panes: [] }] }),
    unknownTop: write('unknown-top.json', { version: 1, workspaces: { w1: {} } }),
  }
  const run = (args) => spawnSync(process.execPath, [here, ...args], { encoding: 'utf8' })
  const cases = [
    { name: '현재 형식 복구 대상 2개 → 멈춤(7)', args: [files.current2], want: 7, out: '"count":2' },
    { name: '현재 형식 셸만 → 진행(0)', args: [files.currentShell], want: 0, out: '"count":0' },
    { name: '구형 형식(workspace.panes+layout) 복구 대상 1개 → 멈춤(7)', args: [files.legacy1], want: 7, out: '"count":1' },
    { name: '구형 형식 셸만 → 진행(0)', args: [files.legacyShell], want: 0, out: '"count":0' },
    { name: '현재+구형 섞임 → 둘 다 셈(7, 2개)', args: [files.mixed], want: 7, out: '"count":2' },
    { name: '빈 세션 → 진행(0)', args: [files.empty], want: 0, out: '"count":0' },
    { name: '파일 없음 → 진행(0)', args: [path.join(dir, 'none.json')], want: 0, out: '"count":0' },
    { name: '모르는 workspace 구조(tabs·layout 없이 panes) → 멈춤(8)', args: [files.unknownWs], want: 8, out: '구조를 모른다' },
    { name: '[r3] 구형 + 덧붙은 빈 tabs(코디 c48 mixed) → 구형 pane 계수, 멈춤(7, 1개)', args: [files.legacyExtraTabs], want: 7, out: '"count":1' },
    { name: '[r3] tabs 만(판별자 없음, 코디 c48 tabsonly) → 멈춤(8)', args: [files.tabsOnly], want: 8, out: '구조를 모른다' },
    { name: '[r3] tabs 만 + 허용 플래그 → 그래도 멈춤(8)', args: [files.tabsOnly, '--allow-session-restore'], want: 8, out: '구조를 모른다' },
    { name: '[r3] 현재 형식인데 tabs 가 배열 아님 → 멈춤(8)', args: [files.currentBadTabs], want: 8, out: 'tabs 가 배열이 아니다' },
    { name: '[r3] 구형인데 panes 가 객체 아님 → 멈춤(8)', args: [files.legacyBadPanes], want: 8, out: 'panes 가 객체가 아니다' },
    { name: '모르는 tab 구조(현재 형식, panes 없음) → 멈춤(8)', args: [files.unknownTab], want: 8, out: 'panes 를 모른다' },
    { name: 'workspaces 가 배열 아님 → 멈춤(8)', args: [files.unknownTop], want: 8, out: '배열이 아니다' },
    { name: '모르는 구조 + 허용 플래그 → 그래도 멈춤(8)', args: [files.unknownWs, '--allow-session-restore'], want: 8, out: '구조를 모른다' },
    { name: '복구 대상 + 허용 플래그 → 진행(0)', args: [files.current2, '--allow-session-restore'], want: 0, out: '"allowed":true' },
    { name: '구형 복구 대상 + 허용 플래그 → 진행(0)', args: [files.legacy1, '--allow-session-restore'], want: 0, out: '"allowed":true' },
  ]
  const results = cases.map((item) => {
    const res = run(item.args)
    return { name: item.name, exit: res.status, pass: res.status === item.want && res.stdout.includes(item.out) && !res.stdout.includes('/synthetic') }
  })
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify({ selfCheck: results.every((r) => r.pass) ? 'pass' : 'fail', results }, null, 1))
  process.exit(results.every((r) => r.pass) ? 0 : 1)
}

if (process.argv[2] === '--self-check') selfCheck()
else {
  const file = process.argv[2]
  const allowed = process.argv.includes('--allow-session-restore')
  const result = restoreTargets(file)
  console.log(JSON.stringify({ count: result.count, agents: result.agents, allowed, unknown: result.unknown }))
  if (result.unknown !== null) {
    console.log(`✘ session.json 구조를 모른다 — 복구 대상을 셀 수 없어 멈춘다(${result.unknown})`)
    process.exit(8)
  }
  if (result.count > 0 && !allowed) {
    console.log(`✘ herdr 서버를 띄우면 에이전트 세션 ${result.count}개가 다시 붙는다 — 승인된 범위 밖이라 멈춘다(허용하려면 --allow-session-restore)`)
    process.exit(7)
  }
}
