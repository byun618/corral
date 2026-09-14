// 앱 실측 본편 — **A4(일감의 존재 이유)** 와 B1~B8 · D1 · A8 · D4 를 한 번의 기동으로 잰다.
//
// 한 번에 묶는 이유: fixture 가 같다. 같은 worktree 에 에이전트 세션 3 + 셸 1 을 붙여 놓으면
// "두 세션이 갈리나"(A4) · "빈 상태는 어떻게 보이나"(B7) · "행 높이가 안 튀나"(B4) 가 같은
// 화면에서 나온다. 기동을 나누면 fixture 를 세 번 다시 만들어야 하고 비교 기준도 흔들린다.
//
// # 참조는 훅 대신 **직접 보고**로 넣는다
//
// 실제 훅 경로는 A3ⓐ 에서 이미 증명됐다(`raw/claude/a3-agent-session-probe.json`). 여기서
// 필요한 건 "참조가 있을 때 화면이 무엇을 보이나" 라서, 훅과 **똑같은 RPC**(`pane.report_agent_session`)
// 를 하네스가 직접 부른다. 훅이 하는 일이 정확히 그 한 줄이다. 이렇게 하면 세션 id 를 하네스가
// 정할 수 있어서 트랜스크립트를 **원하는 내용으로 미리 깔아 둘 수 있다** — A4 의 "서로 다른 값"
// 을 지어낸 값이 아니라 실제 판독 결과로 증명하기 위해서다.
//
// # 관문 ⑤ 반례
//
// A4 의 비교식(`두 2차 줄이 다른가`)을 **참조를 넣기 전에도** 돌린다. 그때는 두 행이 같은
// 문구라 비교식이 `false` 여야 한다. `until()` 이 타임아웃을 성공으로 읽어 버리는 함정
// (LIFE-357 14-handoff §3-②)을 이 반례가 막는다.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  SESSION,
  buildMixedFixture,
  resetSession,
  herdrCall,
  installIntegration,
  integrationStatus,
  isolatedHome,
  makeScratchRepo,
  sleep,
  startApp,
  until,
  writeRaw,
} from './lib.mjs'

const AGENTS = ['claude', 'codex', 'grok']

/** 격리 HOME 의 통합을 **지운다** — B8(미설치가 보이나) 의 출발 상태를 만든다. */
function uninstallIntegrations() {
  const env = { ...process.env, HOME: isolatedHome() }
  const out = {}
  for (const agent of AGENTS) {
    try {
      out[agent] = execFileSync('herdr', ['integration', 'uninstall', agent], { encoding: 'utf8', env }).trim()
    } catch (error) {
      out[agent] = `실패: ${String(error.stderr ?? error.message).trim()}`
    }
  }
  return out
}

/** claude 트랜스크립트를 격리 HOME 에 깐다. 내용은 하네스가 지어낸 것 — 사용자 대화가 아니다. */
function writeClaudeTranscript({ id, folder, lines }) {
  const dir = path.join(isolatedHome(), '.claude', 'projects', folder)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n')
  return file
}

function assistantRecord(text, at) {
  return {
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

/** 화면의 세션 행들을 **DOM 에서** 읽는다 — 상태가 아니라 그려진 결과를 본다. */
async function readRows(app) {
  const code = `(() => [...document.querySelectorAll('.session-row')].map((row) => {
    const second = row.querySelector('.session-row-second')
    const title = row.querySelector('.session-row-title')
    const elapsed = row.querySelector('.session-row-elapsed')
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x*10)/10, y: Math.round(r.y*10)/10, w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10 } }
    const style = (el, props) => { if (!el) return null; const s = getComputedStyle(el); const out = {}; for (const p of props) out[p] = s.getPropertyValue(p); return out }
    return {
      tabId: row.getAttribute('data-tab'),
      rowHeight: box(row).h,
      title: title ? title.textContent : null,
      secondKind: second ? second.getAttribute('data-second-kind') : null,
      secondText: second ? second.textContent : null,
      secondTooltip: second ? second.getAttribute('title') : null,
      // **getClientRects().length 는 판별력이 0 이다** (수정 라운드 1, V4). 2차 줄은 block div 라
      // 텍스트가 3줄로 감겨도 rect 는 늘 1개다 — 여러 개가 나오는 건 인라인 박스뿐이다.
      // 감김을 실제로 가르는 값은 **넘치는 높이**다: scrollHeight / line-height.
      secondLines: second ? second.getClientRects().length : null,
      secondWrap: second
        ? (() => {
            const s = getComputedStyle(second)
            const lineHeight = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2
            return {
              scrollHeight: second.scrollHeight,
              clientHeight: second.clientHeight,
              lineHeight,
              줄수: Math.max(1, Math.round(second.scrollHeight / lineHeight)),
              가로가_넘치나: second.scrollWidth > second.clientWidth,
            }
          })()
        : null,
      elapsed: elapsed ? elapsed.textContent : null,
      titleBox: box(title),
      secondBox: box(second),
      rowBox: box(row),
      secondStyle: style(second, ['font-size', 'color', 'white-space', 'overflow', 'text-overflow']),
      titleStyle: style(title, ['font-size', 'color']),
    }
  }))()`
  return (await app.send({ cmd: 'eval', code })).result
}

const byTab = (rows, tabId) => rows.find((row) => row.tabId === tabId) ?? null

/** A4 의 비교식 — **이 함수 하나**를 반례와 본실험에 똑같이 쓴다. */
function twoSecondLinesDiffer(rows, tabA, tabB) {
  const a = byTab(rows, tabA)
  const b = byTab(rows, tabB)
  if (a === null || b === null) return false
  if (a.secondKind !== 'text' || b.secondKind !== 'text') return false
  return a.secondText !== b.secondText && a.secondText.trim().length > 0 && b.secondText.trim().length > 0
}

async function paneStatusCounts() {
  const response = await herdrCall('pane.list', {})
  const panes = response?.result?.panes ?? response?.panes ?? []
  const counts = {}
  for (const pane of panes) {
    const status = pane.agent_status ?? pane.agentStatus ?? '(없음)'
    counts[status] = (counts[status] ?? 0) + 1
  }
  return { total: panes.length, counts }
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }

  // 세션을 비우고 새로 띄운다 — 지난 실행의 pane 이 든 낡은 참조가 이번 실측에 섞이면 안 된다.
  out['세션 초기화'] = await resetSession()
  // **지난 실행이 깐 트랜스크립트를 먼저 치운다.** 세션 id 를 고정값으로 쓰므로 안 치우면
  // "방금 뜬 세션(파일 없음)" 칸이 지난 실행의 파일을 읽어 버린다 — 1차 실행에서 그랬다.
  for (const folder of ['l366-a', 'l366-b', 'l366-c', 'l366-d']) {
    fs.rmSync(path.join(isolatedHome(), '.claude', 'projects', folder), { recursive: true, force: true })
  }
  out['통합 지우기(B8 출발 상태)'] = uninstallIntegrations()
  out['통합 상태 — 설치 전'] = integrationStatus()
  out['D4 — agent_status 분포(설치 전)'] = await paneStatusCounts()

  const repo = makeScratchRepo('app-sessions')
  const app = await startApp({ name: '10-app-sessions' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, {
    timeoutMs: 15000,
    what: 'worktree row',
  })
  await app.click(`[data-worktree="${repo.root}"]`)
  const opened = await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null,
    { timeoutMs: 30000, what: 'worktree opened' },
  )
  out['worktree 열림'] = { ok: opened.ok, ms: opened.ms }

  // 에이전트 4 + 셸 1. 셸 탭은 B7 의 "에이전트 미부착" 칸이다.
  //   A·B = A4 의 두 세션 · C = 참조만 있고 파일 없음(B7) · D = 고의 손상 3종(A8)
  const fixture = await buildMixedFixture(app, repo.root, { agents: 4, shells: 1 })
  out.fixture = { agentTabCount: fixture.agentTabCount, shellTabCount: fixture.shellTabCount ?? null }

  const state = await app.state()
  const workspace = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root).workspace
  const agentTabs = workspace.tabs.filter((tab) => tab.panes.some((pane) => pane.agent !== null))
  const shellTabs = workspace.tabs.filter((tab) => tab.panes.every((pane) => pane.agent === null))
  const [tabA, tabB, tabC, tabD] = agentTabs
  out.tabs = {
    agent: agentTabs.map((tab) => ({ tabId: tab.tabId, paneId: tab.panes[0].paneId, agent: tab.panes[0].agent })),
    shell: shellTabs.map((tab) => tab.tabId),
  }

  // ---------- ① 참조 없음 + 통합 미설치 (B7·B8) ----------
  const beforeRows = await until(async () => {
    const rows = await readRows(app)
    return rows.length >= agentTabs.length + shellTabs.length ? rows : false
  }, { timeoutMs: 20000, what: '세션 행이 다 그려짐' })
  const notInstalled = await until(async () => {
    const rows = await readRows(app)
    return rows.some((row) => row.secondKind === 'notice') ? rows : false
  }, { timeoutMs: 20000, everyMs: 300, what: '미설치 안내 문구' })
  out['B8 — 통합 미설치가 보이나'] = {
    rows: (notInstalled.value ?? beforeRows.value ?? []).map((row) => ({
      tabId: row.tabId,
      secondKind: row.secondKind,
      secondText: row.secondText,
    })),
    ok: notInstalled.ok,
  }
  out['B7 — 빈 상태 스크린샷(미설치·셸)'] = await app.shot('b7-not-installed')

  // ---------- 관문 ⑤ 반례 — 참조 전에는 A4 비교식이 실패해야 한다 ----------
  const counterRows = notInstalled.value ?? beforeRows.value
  out['관문⑤ 반례 — 참조 전 A4 비교식'] = {
    설명: '같은 비교식을 참조 주입 전에 돌린다. 통과하면 비교식이 아무거나 통과시킨다는 뜻이다.',
    두_줄이_다른가: twoSecondLinesDiffer(counterRows, tabA.tabId, tabB.tabId),
    기대: false,
    행: [tabA.tabId, tabB.tabId].map((id) => {
      const row = byTab(counterRows, id)
      return { tabId: id, secondKind: row?.secondKind ?? null, secondText: row?.secondText ?? null }
    }),
  }

  // ---------- ② 통합 설치 → 미설치 안내가 사라진다 (A1·B8·D4) ----------
  const installed = {}
  for (const agent of AGENTS) installed[agent] = installIntegration(agent)
  out['통합 설치'] = installed
  out['통합 상태 — 설치 후'] = integrationStatus()
  const noticeGone = await until(async () => {
    const rows = await readRows(app)
    return rows.every((row) => row.secondKind !== 'notice') ? rows : false
  }, { timeoutMs: 40000, everyMs: 500, what: '미설치 안내가 사라짐' })
  out['A1 — corral 이 통합 상태를 읽는다'] = {
    상태: (await app.state()).integrations,
    안내_사라짐: noticeGone.ok,
    ms: noticeGone.ms,
  }
  out['D4 — agent_status 분포(설치 후)'] = await paneStatusCounts()

  // ---------- ③ 참조 + 트랜스크립트 주입 → A4 ----------
  const now = Date.now()
  const idA = '11111111-aaaa-4aaa-8aaa-000000000001'
  const idB = '22222222-bbbb-4bbb-8bbb-000000000002'
  const idC = '33333333-cccc-4ccc-8ccc-000000000003'
  const idD = '44444444-dddd-4ddd-8ddd-000000000004'
  const textA = '토큰 원본에 --h-session-row-2 를 역반영했다. 이제 두 파일이 같은 값을 본다.'
  const textB = 'vitest 113개 전부 통과. 경계 검사도 위반 0건이다.'
  // A 의 시각을 **뚜렷하게 과거로** 잡는다 — 경과 시간이 `now` 로만 나오면 D1 이 "실재하는
  // 시각을 쓴다" 를 증명하지 못한다. 마지막 레코드가 44분 전이면 화면에 `44m` 이 떠야 한다.
  const tsA = { 앞선턴: now - 3600000, aiTitle: now - 3000000, 마지막말: now - 2700000, toolUse: now - 2640000 }
  const fileA = writeClaudeTranscript({
    id: idA,
    folder: 'l366-a',
    lines: [
      assistantRecord('앞선 턴 — 이건 보이면 안 된다', tsA.앞선턴),
      { type: 'ai-title', sessionId: idA, aiTitle: '세션 지문 판독층 구현', timestamp: new Date(tsA.aiTitle).toISOString() },
      assistantRecord(textA, tsA.마지막말),
      // tool_use 뿐인 턴 — 판독층이 건너뛰고 더 거슬러 올라가는지 같이 본다. **가장 최근**
      // 레코드라 경과 시간은 이 시각(44분 전)에서 나와야 한다.
      { type: 'assistant', timestamp: new Date(tsA.toolUse).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    ],
  })
  // B 는 ai-title 이 **없다** — 제목이 터미널 제목 티어로 내려가는지 같이 본다 (C1 ③).
  const fileB = writeClaudeTranscript({ id: idB, folder: 'l366-b', lines: [assistantRecord(textB, now - 45000)] })

  const report = async (paneId, id) =>
    herdrCall('pane.report_agent_session', {
      pane_id: paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: id,
    })
  out['참조 주입'] = {
    A: await report(tabA.panes[0].paneId, idA),
    B: await report(tabB.panes[0].paneId, idB),
    C: await report(tabC.panes[0].paneId, idC),
  }
  // **재동기를 한 번 당긴다.** herdr 는 `pane.report_agent_session` 에 push 를 안 준다
  // (`raw/claude/push-probe.json`) — 참조는 스냅샷으로만 온다. 앱은 에이전트 검출 직후
  // 두 번 당겨 오지만(`link.ts` AGENT_SESSION_NUDGE_MS), 여기 주입은 검출보다 한참 뒤라
  // 그 창을 이미 지났다. 재는 것은 "참조가 있을 때 화면이 뭘 보이나" 이지 참조 도달 지연이
  // 아니므로(그건 `11-live-agent.mjs` 가 따로 잰다) 여기서는 당겨 쓴다.
  out['재동기 당김'] = await app.send({ cmd: 'resync', reason: 'l366-ref-injected' })

  const a4 = await until(async () => {
    const rows = await readRows(app)
    return twoSecondLinesDiffer(rows, tabA.tabId, tabB.tabId) ? rows : false
  }, { timeoutMs: 30000, everyMs: 300, what: 'A4 — 두 2차 줄이 갈린다' })
  const textRows = a4.value ?? (await readRows(app))
  out['A4 — 같은 worktree 2세션이 갈린다'] = {
    통과: a4.ok,
    ms: a4.ms,
    A: byTab(textRows, tabA.tabId),
    B: byTab(textRows, tabB.tabId),
    깐_파일: { A: fileA, B: fileB },
    기대한_문구: { A: textA, B: textB },
  }
  out['A4 스크린샷'] = await app.shot('a4-two-sessions')

  // C 는 참조만 있고 파일이 없다 — **방금 뜬 세션**의 모습이다 (B7). 안내 문구를 지어내지
  // 않고 빈 슬롯으로 둔다.
  out['B7 — 방금 뜬 세션(참조 있음·파일 없음)'] = byTab(textRows, tabC.tabId)
  out['B7 방금 뜬 세션 스크린샷'] = await app.shot('b7-fresh-session')
  // 셸 탭은 **사이드바 세션 행이 아예 없다** (LIFE-357: 사이드바 목록 = 에이전트 탭).
  out['B7 — 셸 탭'] = {
    셸_탭_수: shellTabs.length,
    세션_행_수: textRows.length,
    에이전트_탭_수: agentTabs.length,
    결론: '셸 탭은 사이드바에 행 자체가 없다 — 2차 줄도 없다 (A10 의 "셸 탭은 2차 줄 자체가 없다")',
  }

  // ---------- ④ 비주얼 계약 B1~B5 · C1 · D1 ----------
  const rowA = byTab(textRows, tabA.tabId)
  const rowB = byTab(textRows, tabB.tabId)
  out['B1 — 2차 줄이 존재한다'] = { A: rowA.secondText, B: rowB.secondText, 행높이: rowA.rowHeight }
  out['B2 — 위계(한 급 작고 한 급 흐리다)'] = {
    '1차': rowA.titleStyle,
    '2차': rowA.secondStyle,
    작은가: parseFloat(rowA.secondStyle['font-size']) < parseFloat(rowA.titleStyle['font-size']),
    색이_다른가: rowA.secondStyle.color !== rowA.titleStyle.color,
  }
  out['B3 — 제목 왼쪽 끝에 맞는다'] = {
    titleX: rowA.titleBox.x,
    secondX: rowA.secondBox.x,
    차이: Math.round((rowA.secondBox.x - rowA.titleBox.x) * 10) / 10,
  }
  // B5 — 한 줄인가. **판별력 있는 값으로 판정한다** (수정 라운드 1, V4): `getClientRects().length`
  // 는 block div 에서 늘 1이라 감김을 못 가른다. 넘치는 높이(`scrollHeight / line-height`)로 센다.
  //
  // 관문 ⑤ 반례: **일부러 감기게** 만든다 — 같은 행에 `white-space: normal` 을 inline 으로 얹고
  // 다시 잰다. 판정식이 살아 있으면 여기서 줄수가 1을 넘어 미달이 나와야 한다. 재고 나면 되돌린다.
  const wrapProbe = (await app.send({
    cmd: 'eval',
    code: `(() => {
      const el = document.querySelector('[data-tab="${tabA.tabId}"] .session-row-second')
      if (!el) return null
      const measure = () => {
        const s = getComputedStyle(el)
        const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2
        return { scrollHeight: el.scrollHeight, lineHeight: lh, 줄수: Math.max(1, Math.round(el.scrollHeight / lh)), whiteSpace: s.whiteSpace }
      }
      const before = measure()
      el.style.whiteSpace = 'normal'
      el.style.overflow = 'visible'
      const wrapped = measure()
      el.style.whiteSpace = ''
      el.style.overflow = ''
      const after = measure()
      return { before, wrapped, after }
    })()`,
  })).result
  out['B5 — 한 줄 말줄임 + 전문 툴팁'] = {
    '줄수(판별력 있는 값)': rowA.secondWrap?.줄수 ?? null,
    측정: rowA.secondWrap,
    '줄수(1회차가 쓴 getClientRects — 참고용)': rowA.secondLines,
    whiteSpace: rowA.secondStyle['white-space'],
    textOverflow: rowA.secondStyle['text-overflow'],
    가로가_넘치나: rowA.secondWrap?.가로가_넘치나 ?? null,
    툴팁이_전문인가: rowA.secondTooltip === textA,
    툴팁길이: rowA.secondTooltip?.length ?? null,
    본문길이: textA.length,
    판정: rowA.secondWrap !== null && rowA.secondWrap.줄수 === 1,
    '관문⑤ 반례 — 일부러 감기게': {
      설명: 'white-space 를 normal 로 얹으면 같은 판정식이 미달이어야 한다. 1이 그대로 나오면 그 칸은 감김을 못 재는 것이다.',
      전: wrapProbe?.before ?? null,
      감긴_동안: wrapProbe?.wrapped ?? null,
      되돌린_뒤: wrapProbe?.after ?? null,
      반례가_성립하나: (wrapProbe?.wrapped?.줄수 ?? 1) > 1,
      '되돌아왔나': (wrapProbe?.after?.줄수 ?? null) === 1,
    },
  }
  out['C1 — 제목 티어가 화면에 반영됐나'] = {
    'A(ai-title 있음)': rowA.title,
    'B(ai-title 없음 → 터미널 제목/폴백)': rowB.title,
    기대: { A: '세션 지문 판독층 구현' },
  }
  const digestA = (await app.state()).repos
    .flatMap((r) => r.worktrees)
    .flatMap((w) => w.workspace?.tabs ?? [])
    .find((t) => t.tabId === tabA.tabId)?.digest
  out['D1 — 경과 시간'] = {
    A: rowA.elapsed,
    B: rowB.elapsed,
    'A 의 lastActivityAt': digestA?.lastActivityAt ?? null,
    'A 파일의 가장 최근 레코드 시각': tsA.toolUse,
    일치하나: digestA?.lastActivityAt === tsA.toolUse,
    근거: '트랜스크립트 레코드 timestamp — 렌더러가 처음 본 시각이 아니다',
  }

  // ---------- ⑤ B4 — 행 높이가 안 튄다 ----------
  const heights = {
    '① 값 없음(참조 전)': byTab(counterRows, tabA.tabId)?.rowHeight ?? null,
    '② 도착(텍스트)': rowA.rowHeight,
    '참조만 있고 파일 없음(빈 슬롯)': byTab(textRows, tabC.tabId)?.rowHeight ?? null,
  }
  fs.rmSync(fileA, { force: true })
  const gone = await until(async () => {
    const rows = await readRows(app)
    const row = byTab(rows, tabA.tabId)
    return row !== null && row.secondKind !== 'text' ? rows : false
  }, { timeoutMs: 30000, everyMs: 400, what: '텍스트가 사라짐' })
  const goneRows = gone.value ?? (await readRows(app))
  heights['③ 사라짐(파일 삭제)'] = byTab(goneRows, tabA.tabId)?.rowHeight ?? null
  // **전이 상태와 안정 상태를 둘 다 싣는다** (수정 라운드 1, V11). 파일이 사라진 **그 주기**는
  // `statSync` 가 ENOENT 라 `unreadable`(「기록을 읽지 못했다」)로 내려앉고, 같은 호출이 캐시를
  // 지우므로 **다음 주기에는** 재탐색이 돌아 `unresolved`(빈 슬롯)가 된다. 1회차 원자료는 앞의
  // 것만 실어서 1.5초짜리 깜빡임이 최종 상태처럼 읽혔다.
  await sleep(3200)
  const settledRows = await readRows(app)
  heights['③-2 사라진 뒤 두 주기'] = byTab(settledRows, tabA.tabId)?.rowHeight ?? null
  out['B4 — 행 높이가 안 튄다'] = {
    높이: heights,
    전부_같은가: new Set(Object.values(heights).filter((h) => h !== null)).size === 1,
    '③ 상태 — 사라진 직후(전이, 한 주기)': {
      secondKind: byTab(goneRows, tabA.tabId)?.secondKind,
      secondText: byTab(goneRows, tabA.tabId)?.secondText,
      'until ok': gone.ok,
      'until ms': gone.ms,
    },
    '③ 상태 — 두 주기 뒤(안정)': {
      secondKind: byTab(settledRows, tabA.tabId)?.secondKind,
      secondText: byTab(settledRows, tabA.tabId)?.secondText,
    },
  }
  out['B4 스크린샷(사라진 뒤)'] = await app.shot('b4-cleared')

  // ---------- ⑥ A8 — 고의 손상 3종 ----------
  const damaged = []
  /** 손상 입력 안에 **실제로 들어 있는** 텍스트 — 판정식이 "지어냈나" 를 이걸로 가른다. */
  const 파일에_실재하는_텍스트 = ['온전한 앞줄']
  const damage = [
    { 이름: '빈 파일', lines: [] },
    { 이름: '알 수 없는 type 만', lines: [{ type: 'quantum-thing', payload: { a: 1 } }, { type: 'another', x: 2 }] },
    { 이름: '마지막 줄이 잘림', lines: [assistantRecord('온전한 앞줄', now - 90000), '{"type":"assistant","message":{"content":[{"type":"te'] },
  ]
  // **파일을 깔고 나서 참조를 보고한다.** 실제 훅도 그 순서다(세션이 뜨면 파일이 먼저 생기고
  // SessionStart 훅이 뒤이어 id 를 알린다). 반대로 하면 참조가 미해소 상태로 굳어 재탐색
  // 백오프(`transcript.ts` RESOLVE_RETRY_MS)를 기다리게 되고, A8 이 아니라 그 지연을 재게 된다
  // — 2차 실행에서 그렇게 어긋났다.
  let damageRefReported = false
  for (const kind of damage) {
    const file = writeClaudeTranscript({ id: idD, folder: 'l366-d', lines: kind.lines })
    if (!damageRefReported) {
      out['A8 참조 주입'] = await report(tabD.panes[0].paneId, idD)
      out['A8 재동기 당김'] = await app.send({ cmd: 'resync', reason: 'l366-damage-ref' })
      damageRefReported = true
    }
    // **폴링 두 주기를 확실히 태운 뒤 본다.** `until` 로 "뭐든 값이 오면" 을 기다리면 아직
    // 파일을 읽기 전 상태(unresolved → 빈 슬롯)를 정답으로 착각한다 — 1차 실행에서 그랬다.
    await sleep(3200)
    const rows = await readRows(app)
    const row = byTab(rows, tabD.tabId)
    damaged.push({
      입력: kind.이름,
      bytes: fs.statSync(file).size,
      secondKind: row?.secondKind ?? null,
      secondText: row?.secondText ?? null,
      행이_남아있나: row !== null,
      행높이: row?.rowHeight ?? null,
      제목: row?.title ?? null,
    })
  }
  // 관문 ⑤ 반례 (수정 라운드 1, V3) — **검출기가 실제로 반응하나.**
  //
  // 1회차의 「예외 전파 없음」 다리는 `transcript.error` 태그를 봤는데 그 태그가 코드에 없었다.
  // 없는 것을 세었으니 매번 참이었다 — 관측이 아니라 무관측이다. 이번엔 판독층이 실패를 실제로
  // 태그로 남기게 했고(`transcript.ts`), 여기서 **읽을 수 없는 파일을 심어 그 태그를 뽑아낸다.**
  // 태그 수가 **늘면** 검출기가 산 것이고, 그래야 이 칸의 수가 뜻을 갖는다. (0 에서 출발하지는
  // 않는다 — 바로 앞 B4 가 파일을 지웠고 그 ENOENT 도 실제 판독 실패라 이미 한 건 찍혀 있다.)
  const errorsBefore = app.entries().filter((entry) => entry.tag === 'transcript.error').length
  const eaccesFile = writeClaudeTranscript({
    id: idC,
    folder: 'l366-c',
    lines: [assistantRecord('이 파일은 열 수 없다', now - 30000)],
  })
  fs.chmodSync(eaccesFile, 0o000)
  await sleep(3400)
  const eaccesRows = await readRows(app)
  const errorsAfter = app.entries().filter((entry) => entry.tag === 'transcript.error')
  fs.chmodSync(eaccesFile, 0o600)
  out['관문⑤ 반례 — 판독 실패 검출기'] = {
    설명: '읽을 수 없는 파일(chmod 000)을 심는다. transcript.error 수가 늘어야 이 검출기가 관측이다.',
    '전 transcript.error 수': errorsBefore,
    '후 transcript.error 수': errorsAfter.length,
    '전 건은 무엇이었나': '바로 앞 B4 가 파일을 지운 ENOENT (where: stat) — 그것도 실제 판독 실패다',
    마지막_태그: errorsAfter.slice(-1)[0] ?? null,
    반례가_성립하나: errorsAfter.length > errorsBefore,
    '그때 화면': {
      secondKind: byTab(eaccesRows, tabC.tabId)?.secondKind ?? null,
      secondText: byTab(eaccesRows, tabC.tabId)?.secondText ?? null,
      행이_남아있나: byTab(eaccesRows, tabC.tabId) !== null,
      행높이: byTab(eaccesRows, tabC.tabId)?.rowHeight ?? null,
    },
  }
  // 미처리 예외는 로그가 아니라 **stderr** 로 샌다 (판독층은 타이머 콜백에서 돈다).
  const stdoutText = fs.existsSync(path.join(app.dir, 'stdout.txt'))
    ? fs.readFileSync(path.join(app.dir, 'stdout.txt'), 'utf8')
    : ''
  const uncaught = stdoutText
    .split('\n')
    .filter((line) => /uncaught|unhandled|Error:.*transcript|at readSessionDigest/i.test(line))
    .slice(-10)

  out['A8 — 포맷이 깨져도 거짓말하지 않는다'] = {
    결과: damaged,
    // 통과선은 "**비거나 부재로 표시**" 이고 미달은 "지어낸 문자열·예외 전파·행 소멸" 이다.
    // 그래서 판정을 "text 가 안 나왔나" 로 잡으면 안 된다 — 잘린 마지막 줄을 건너뛰고
    // **파일에 실재하는 앞 레코드**를 보이는 것은 지어낸 값이 아니라 맞는 동작이다.
    // 판정식: 보인 문구가 (ⓐ 안내이거나 빈 슬롯) 이거나 (ⓑ 그 파일에 실재하는 텍스트) 인가.
    지어낸_문자열_없나: damaged.every(
      (d) => d.secondKind !== 'text' || 파일에_실재하는_텍스트.includes(d.secondText),
    ),
    행이_다_살아있나: damaged.every((d) => d.행이_남아있나),
    // **미처리 예외**는 stderr 로 샌다 — 판독층이 타이머 콜백에서 돌기 때문에 로그 파일엔 안 남는다.
    // 손상 3종을 태운 뒤 stdout.txt 를 훑는다 (앞의 「판독 실패 검출기」 반례가 이 다리도 받친다:
    // 심은 실패는 `transcript.error` 로 잡히고 stderr 로는 새지 않는다).
    미처리_예외_없나: uncaught.length === 0,
    'stderr 에서 걸린 줄': uncaught,
    '반례 전까지의 transcript.error 수': errorsBefore,
  }
  out['A8 스크린샷'] = await app.shot('a8-damaged')

  // ---------- 로그에서 비용·예외 ----------
  const entries = app.entries()
  out['transcript.read 로그(마지막 10줄)'] = entries.filter((e) => e.tag === 'transcript.read').slice(-10)
  out['예외 로그'] = entries.filter((e) => typeof e.tag === 'string' && /error|throw|uncaught/i.test(e.tag)).slice(-10)
  out.rawChain = app.rawChain()

  await app.stop()
  writeRaw('app-sessions-r1.json', out)
  console.log(JSON.stringify({
    A4: out['A4 — 같은 worktree 2세션이 갈린다'].통과,
    반례: out['관문⑤ 반례 — 참조 전 A4 비교식'].두_줄이_다른가,
    B4: out['B4 — 행 높이가 안 튄다'],
    B8: out['B8 — 통합 미설치가 보이나'].ok,
    A8: out['A8 — 포맷이 깨져도 거짓말하지 않는다'],
  }, null, 1))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
