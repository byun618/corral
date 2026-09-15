// 수정 라운드 5 — **Orca 동등**을 화면에서 확인한다 (C1′ · B9 · G7 · P5/G8).
//
// 단위 테스트가 순서·게이트를 못 박고, 여기서는 **앱 안에서도 같은 판정이 나는지**를 본다.
// 재료는 전부 격리 HOME 에 하네스가 깐 것이다 (관문 ④ — 사용자 HOME 에는 안 쓴다).
//
//   ⓐ 셸 탭 폴백이 `terminal N` 이다 (브랜치가 아니다 — r3 G3 를 걷어냈다)
//   ⓑ 첫 사용자 발화가 제목이 된다 (ai-title 이 없는 동안)
//   ⓒ ai-title 이 오면 **첫 발화를 이긴다** (C1′ 순서 — 관문 ⑤ 반례가 이 칸이다)
//   ⓓ `working` 일 때만 2차 줄이 `Bash: …` 다 — 상태를 `idle` 로 되돌리면 마지막 말로 돌아온다
//   ⓔ 과도기 모양(자리와 다른 번호가 label 에 앉은 순간)에도 제목이 숫자로 안 떨어진다 (G7)
//   ⓖ 개명 사전 차단이 **범위**(1..탭수)다 — `357` 은 살아야 한다 (G7 + LIFE-357 J-4)
//   ⓕ 접은 그룹이 상태 클러스터 줄이다 (P6/C7)
//
// ⓔ 를 **직접 심는 이유**: 닫기 과도기는 몇 프레임짜리라 잡기가 운에 달렸다(r4 에서 확인:
// 닫기 봉투만으로는 label 이 안 따라오고 resync 뒤에야 바뀐다). 그래서 herdr `tab.rename` 으로
// **그 과도기와 같은 모양**(자리 1 탭에 label "2")을 심는다 — 봉투가 하는 일과 같다.
// 닫기 전후 제목도 같이 샘플링해 표로 남긴다.

import fs from 'node:fs'
import path from 'node:path'
import {
  SESSION,
  createTab,
  herdrCall,
  isolatedHome,
  makeScratchRepo,
  resetSession,
  sleep,
  startApp,
  tabsOf,
  until,
  writeRaw,
} from './lib.mjs'

const BRANCH = 'LIFE-366-r5-orca'
const FIRST_PROMPT = '트랜스크립트 판독층의 머리 읽기를 고쳐라. 그리고 결과를 알려라.'
const FIRST_PROMPT_TITLE = '트랜스크립트 판독층의 머리 읽기를 고쳐라'
const AI_TITLE = 'ai-title 이 첫 발화를 이긴다'
const TOOL_LINE = 'Bash: npm run typecheck'
const LAST_TEXT = '하네스가 지어낸 마지막 말이다.'
const USER_NAME = '357'
const SESSION_ID = 'a5a5a5a5-b5b5-4b5b-8b5b-000000000055'

/** 메인 탭바를 **DOM 에서** 읽는다 — 상태가 아니라 그려진 결과를 본다. */
async function readTabs(app) {
  const code = `(() => [...document.querySelectorAll('.main-tab')].map((tab) => ({
    tabId: tab.getAttribute('data-main-tab'),
    label: (tab.querySelector('.main-tab-label') ?? {}).textContent ?? null,
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

/** 사이드바 세션 행 — 1차 줄(제목)과 2차 줄을 같이 읽는다 (B9 는 2차 줄 얘기다). */
async function readRows(app) {
  const code = `(() => [...document.querySelectorAll('.session-row')].map((row) => ({
    tabId: row.getAttribute('data-tab'),
    title: (row.querySelector('.session-row-title') ?? {}).textContent ?? null,
    second: (row.querySelector('.session-row-second') ?? {}).textContent ?? null,
    secondKind: row.getAttribute('data-secondary'),
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

/** 접힘 요약 행 — 클러스터·아이콘·두 층의 `+N` 을 **DOM 그대로** 읽는다 (C7). */
async function readSummary(app, worktreePath) {
  const code = `(() => {
    const row = document.querySelector('[data-agent-group-summary="${worktreePath}"]')
    if (row === null) return null
    return {
      clusters: [...row.querySelectorAll('[data-summary-cluster]')].map((cluster) => ({
        status: cluster.getAttribute('data-summary-cluster'),
        count: Number(cluster.getAttribute('data-summary-count')),
        icons: [...cluster.querySelectorAll('[data-agent-kind]')].map((icon) => icon.getAttribute('data-agent-kind')),
        hiddenIcons: Number((cluster.querySelector('[data-summary-hidden-icons]') ?? {}).getAttribute?.('data-summary-hidden-icons') ?? 0),
      })),
      hiddenSessions: Number((row.querySelector('[data-agent-group-hidden]') ?? {}).getAttribute?.('data-agent-group-hidden') ?? 0),
      sessionRows: document.querySelectorAll('[data-tab]').length,
      text: row.textContent,
    }
  })()`
  return (await app.send({ cmd: 'eval', code })).result
}

/** 인라인 알림 줄 — ⓖ 는 **막았다고 말했는지**로 잡는다 (제목으로 잡으면 판별력이 없다). */
async function readNotices(app) {
  return (await app.send({ cmd: 'eval', code: `(() => [...document.querySelectorAll('.inline-notice')].map((el) => el.textContent))()` })).result
}

/** 탭 이름을 인라인 편집으로 바꾼다 — 사용자 손과 같은 경로다 (사전 차단이 여기 붙어 있다). */
async function renameTab(app, tabId, label) {
  await app.dblclick(`[data-main-tab="${tabId}"]`)
  await sleep(300)
  await app.key('a', ['meta'])
  await app.type(label)
  await app.key('Enter')
  await sleep(600)
}

/** 격리 HOME 에 트랜스크립트를 깐다. 줄 목록을 그대로 쓴다 — 자라는 것도 여기서 흉내 낸다. */
function writeTranscript(lines) {
  const dir = path.join(isolatedHome(), '.claude', 'projects', 'l366-r5')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const userRecord = (text) =>
  JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  })

const assistantText = (text) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

const assistantTool = (name, input) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input }] },
  })

const aiTitleRecord = (title) =>
  JSON.stringify({ type: 'ai-title', sessionId: SESSION_ID, aiTitle: title, timestamp: new Date().toISOString() })

/** 같은 id 의 파일이 격리 HOME 안에 또 있으면 판독층이 엉뚱한 쪽을 집는다 (r4 에서 두 실행을 잃었다). */
function idCollisions() {
  const projects = path.join(isolatedHome(), '.claude', 'projects')
  if (!fs.existsSync(projects)) return []
  return fs
    .readdirSync(projects)
    .filter((folder) => folder !== 'l366-r5')
    .map((folder) => path.join(projects, folder, `${SESSION_ID}.jsonl`))
    .filter((candidate) => fs.existsSync(candidate))
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }
  out['세션 초기화'] = await resetSession()
  fs.rmSync(path.join(isolatedHome(), '.claude', 'projects', 'l366-r5'), { recursive: true, force: true })

  const repo = makeScratchRepo('r5-orca')
  repo.git('checkout', '-b', BRANCH)
  out['스크래치 레포'] = { root: repo.root, branch: BRANCH, leaf: path.basename(repo.root) }

  const app = await startApp({ name: '22-r5-orca' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await tabsOf(app, repo.root)).length > 0, { timeoutMs: 30000, what: 'worktree opened' })

  // --- 탭 셋: 셸(기본) · 셸 · claude ---------------------------------------------------
  {
    const count = (await tabsOf(app, repo.root)).length
    await app.click('[data-main-tabbar-add]')
    await until(async () => (await tabsOf(app, repo.root)).length === count + 1, { timeoutMs: 20000, everyMs: 200, what: '두 번째 셸 탭' })
  }
  await createTab(app, repo.root, 'claude')
  const three = await until(
    async () => {
      const tabs = await tabsOf(app, repo.root)
      return tabs.length === 3 && tabs.some((tab) => tab.panes.some((pane) => pane.agent !== null)) ? tabs : false
    },
    { timeoutMs: 40000, everyMs: 300, what: '세 번째 탭(claude)' },
  )
  const tabs = three.value ?? (await tabsOf(app, repo.root))
  const agent = tabs.find((tab) => tab.panes.some((pane) => pane.agent !== null)) ?? null
  const shells = tabs.filter((tab) => tab.panes.length > 0 && tab.panes.every((pane) => pane.agent === null))
  if (agent === null || shells.length < 2) throw new Error('탭 구성을 못 만들었다')
  const drawnOf = async (tabId) => (await readTabs(app)).find((row) => row.tabId === tabId)?.label ?? null
  const rowOf = async (tabId) => (await readRows(app)).find((row) => row.tabId === tabId) ?? null

  // --- ⓐ 셸 탭 폴백은 `terminal N` (P5/G8) ---------------------------------------------
  const shellOk = await until(
    async () => {
      const drawn = await Promise.all(shells.map((tab) => drawnOf(tab.tabId)))
      return drawn.every((label, index) => label === `terminal ${shells[index].number}`)
    },
    { timeoutMs: 15000, everyMs: 200, what: 'ⓐ 셸 탭이 terminal N' },
  )
  out['ⓐ 셸 탭 폴백'] = {
    브랜치: BRANCH,
    탭: shells.map((tab) => ({ tabId: tab.tabId, number: tab.number, 기대: `terminal ${tab.number}` })),
    그려진_제목: await Promise.all(shells.map((tab) => drawnOf(tab.tabId))),
    '브랜치가 제목에 안 섞였나': (await readTabs(app)).every((row) => !String(row.label ?? '').includes(BRANCH)),
    통과: shellOk.ok,
  }

  // --- ⓑ 첫 사용자 발화가 제목이 된다 (C1′ ③) -------------------------------------------
  //
  // ai-title 은 **아직 안 깐다** — 깔면 이 칸이 ai-title 로 통과해 판별력을 잃는다.
  const collisions = idCollisions()
  writeTranscript([userRecord(FIRST_PROMPT), assistantText(LAST_TEXT)])
  out['참조 주입'] = {
    'id 충돌': collisions,
    보고: await herdrCall('pane.report_agent_session', {
      pane_id: agent.panes[0].paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: SESSION_ID,
    }),
  }
  await app.send({ cmd: 'resync', reason: 'l366-r5-ref' })
  const prompted = await until(async () => (await drawnOf(agent.tabId)) === FIRST_PROMPT_TITLE, {
    timeoutMs: 30000,
    everyMs: 300,
    what: 'ⓑ claude 탭이 첫 발화 제목',
  })
  out['ⓑ 첫 발화가 제목'] = {
    원문: FIRST_PROMPT,
    기대: FIRST_PROMPT_TITLE,
    '그려진 탭 제목': await drawnOf(agent.tabId),
    '그려진 사이드바 제목': (await rowOf(agent.tabId))?.title ?? null,
    '탭바와 사이드바가 같은가': (await drawnOf(agent.tabId)) === ((await rowOf(agent.tabId))?.title ?? null),
    ms: prompted.ms,
    통과: prompted.ok,
  }
  const shotPrompt = await app.shot('r5-first-prompt-title')

  // --- ⓒ ai-title 이 첫 발화를 **이긴다** (C1′ 순서 — 관문 ⑤) -----------------------------
  writeTranscript([userRecord(FIRST_PROMPT), assistantText(LAST_TEXT), aiTitleRecord(AI_TITLE)])
  const titled = await until(async () => (await drawnOf(agent.tabId)) === AI_TITLE, {
    timeoutMs: 30000,
    everyMs: 300,
    what: 'ⓒ ai-title 이 이긴다',
  })
  out['ⓒ ai-title 이 첫 발화를 이긴다'] = {
    'ai-title': AI_TITLE,
    '첫 발화는 그대로 있다': FIRST_PROMPT_TITLE,
    '그려진 제목': await drawnOf(agent.tabId),
    ms: titled.ms,
    통과: titled.ok,
    설명: '순서를 뒤집으면(첫 발화가 위) 이 칸이 첫 발화 제목으로 남는다 — 그게 반례다.',
  }

  // --- ⓓ 진행 중 도구는 `working` 일 때만 (B9) -------------------------------------------
  //
  // ⚠ **실제 claude pane 에서는 상태를 만들 수 없다.** corral 은 `tab.create` → `agent.start` 로
  // 탭을 만들고, 그 뒤 `agent_status` 는 herdr 의 탐지기가 쥔다 — `pane.report_agent` 는 `ok` 를
  // 주고도 값이 안 바뀐다(두 실행에서 30초씩 기다렸다). 격리 HOME 의 claude 는 인증 전이라
  // **진짜로 일하는 상태**도 못 만든다.
  //
  // 그래서 상태를 만들 수 있는 pane 을 쓴다 — 셸 pane 에 권한을 내려놓고 보고한다. 순서가 중요하다
  // (실측): **상태를 먼저**(source `l366-harness`) 보고해야 `agent`+`agent_status` 가 앉고,
  // **참조는 `herdr:claude`** 로 보내야 `agent_session` 이 앉는다. 뒤집으면 한쪽이 조용히 안 먹는다.
  //
  // 그리고 반례를 **토글이 아니라 두 행**으로 잡는다: 같은 세션 참조(=같은 꼬리)를 단 두 pane 을
  // `working` 과 `idle` 로 두고 **나란히** 본다. 상태만 다른 두 행이 한 화면에 있으니, 게이트가
  // 빠지면 두 행이 같은 글월이 되어 바로 드러난다.
  writeTranscript([
    userRecord(FIRST_PROMPT),
    assistantText(LAST_TEXT),
    aiTitleRecord(AI_TITLE),
    assistantTool('Bash', { command: 'npm run typecheck', description: '타입 검사' }),
  ])
  const attach = async (tab, state) => {
    const paneId = tab.panes[0].paneId
    await herdrCall('pane.clear_agent_authority', { pane_id: paneId })
    const reported = await herdrCall('pane.report_agent', {
      pane_id: paneId,
      source: 'l366-harness',
      agent: 'claude',
      state,
      seq: Date.now(),
    })
    const ref = await herdrCall('pane.report_agent_session', {
      pane_id: paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: SESSION_ID,
    })
    return { paneId, state, 상태보고: reported.result ?? reported.error, 참조보고: ref.result ?? ref.error }
  }
  const b9Working = shells[1]
  // 반례용 탭 하나를 더 만든다 — **같은 꼬리, 다른 상태**.
  {
    const count = (await tabsOf(app, repo.root)).length
    await app.click('[data-main-tabbar-add]')
    await until(async () => (await tabsOf(app, repo.root)).length === count + 1, { timeoutMs: 20000, everyMs: 200, what: 'B9 반례용 탭' })
  }
  const b9Idle = (await tabsOf(app, repo.root)).at(-1)
  out['ⓓ-0 상태·참조 보고'] = [await attach(b9Working, 'working'), await attach(b9Idle, 'idle')]
  await app.send({ cmd: 'resync', reason: 'l366-r5-tool' })

  const paneStateOf = async (tabId) =>
    ((await tabsOf(app, repo.root)).find((tab) => tab.tabId === tabId)?.panes ?? []).map((pane) => ({
      paneId: pane.paneId,
      agent: pane.agent,
      agentStatus: pane.agentStatus,
    }))
  const both = await until(
    async () => {
      const working = (await rowOf(b9Working.tabId))?.second ?? null
      const idle = (await rowOf(b9Idle.tabId))?.second ?? null
      return working === TOOL_LINE && idle === LAST_TEXT
    },
    { timeoutMs: 30000, everyMs: 300, what: 'ⓓ 두 행이 갈린다' },
  )
  out['ⓓ-1 working 이면 도구가 보인다'] = {
    기대: TOOL_LINE,
    '그려진 2차 줄': (await rowOf(b9Working.tabId))?.second ?? null,
    pane: await paneStateOf(b9Working.tabId),
    ms: both.ms,
    통과: ((await rowOf(b9Working.tabId))?.second ?? null) === TOOL_LINE,
  }
  out['ⓓ-2 반례: 같은 꼬리·상태만 idle 이면 지어내지 않는다'] = {
    '꼬리는 같다': '두 행이 같은 세션 참조를 본다 — 마지막 어시스턴트 턴이 tool_use 뿐이다',
    기대: LAST_TEXT,
    '그려진 2차 줄': (await rowOf(b9Idle.tabId))?.second ?? null,
    pane: await paneStateOf(b9Idle.tabId),
    통과: ((await rowOf(b9Idle.tabId))?.second ?? null) === LAST_TEXT,
  }
  const shotTool = await app.shot('r5-tool-line-working')

  // --- ⓔ 과도기 모양 (G7) --------------------------------------------------------------
  //
  // 자리 1 인 셸 탭에 herdr 가 label "2" 를 앉힌 상태 = 닫기 과도기에 실제로 지나가는 모양이다.
  const first = shells[0]
  const beforeTransient = await drawnOf(first.tabId)
  out['ⓔ-0 과도기 심기'] = await herdrCall('tab.rename', { tab_id: first.tabId, label: '2' })
  await app.send({ cmd: 'resync', reason: 'l366-r5-transient' })
  const transientSamples = []
  for (let index = 0; index < 20; index += 1) {
    transientSamples.push(await drawnOf(first.tabId))
    await sleep(120)
  }
  const numericSamples = transientSamples.filter((label) => /^\d+$/.test(String(label ?? '')))
  const herdrLabel = ((await herdrCall('tab.list', {})).result?.tabs ?? []).find((item) => item.tab_id === first.tabId)?.label ?? null
  out['ⓔ 과도기에도 숫자로 안 떨어진다'] = {
    tabId: first.tabId,
    '자리': 1,
    'herdr label': herdrLabel,
    'corral 이 들고 있는 label': (await tabsOf(app, repo.root)).find((tab) => tab.tabId === first.tabId)?.label ?? null,
    '심기 전 제목': beforeTransient,
    '샘플(20회 · 120ms)': [...new Set(transientSamples)],
    '숫자로 떨어진 샘플 수': numericSamples.length,
    통과: numericSamples.length === 0 && transientSamples.every((label) => label === `terminal ${first.number}`),
    설명: '자리 정확 일치로 되돌리면 이 칸이 `2` 로 떨어진다 (사용자가 본 깜빡임의 정지 화면).',
  }
  const shotTransient = await app.shot('r5-transient-no-flicker')

  // 닫기 과도기도 **같이 본다** — 몇 프레임짜리라 못 잡을 수 있어 판정이 아니라 관측으로 싣는다.
  await herdrCall('tab.rename', { tab_id: first.tabId, label: '' })
  await app.send({ cmd: 'resync', reason: 'l366-r5-restore' })
  await sleep(500)
  const closeSamples = []
  const middle = shells[1]
  await app.click(`[data-main-tab-close="${middle.tabId}"]`)
  await sleep(250)
  // ⓓ 에서 에이전트로 보고한 탭이라 종료 확인 모달이 뜬다.
  if ((await app.query('[data-confirm-close-modal]')).found.length > 0) await app.click('[data-close-confirm-ok]')
  for (let index = 0; index < 25; index += 1) {
    closeSamples.push(await readTabs(app))
    await sleep(80)
  }
  await app.send({ cmd: 'resync', reason: 'l366-r5-after-close' })
  for (let index = 0; index < 10; index += 1) {
    closeSamples.push(await readTabs(app))
    await sleep(150)
  }
  const flat = closeSamples.flat().map((row) => String(row.label ?? ''))
  out['ⓔ-2 닫기 과도기 관측'] = {
    '닫은 탭': middle.tabId,
    '샘플 수': flat.length,
    '본 제목들': [...new Set(flat)],
    '숫자로 떨어진 샘플 수': flat.filter((label) => /^\d+$/.test(label)).length,
    설명: '닫기 과도기는 몇 프레임이라 못 잡을 수 있다 — 판정은 ⓔ(직접 심은 모양)가 한다.',
  }

  // --- ⓖ 개명 사전 차단이 **범위**로 넓어졌다 (G7) -----------------------------------------
  //
  // r4 의 차단은 "자리 정확 일치"였고 알림 글월도 달랐다(`기본 표찰과 같아`). r5 에서 판별자를
  // `1..탭수` 범위로 넓히면서 글월도 바뀌었으니 — **r4 의 ⓒ-1 프로브는 이제 이 알림을 못 잡는다**.
  // 그래서 이 칸을 새로 둔다. 판별력은 `357` 반례가 준다: 차단이 숫자 전체로 넓어지면 거기서 깨진다.
  const renameTarget = agent
  const tabCountAtRename = (await tabsOf(app, repo.root)).length
  const inRangeName = '2'
  const titleBeforeRename = await drawnOf(renameTarget.tabId)
  const herdrLabelOf = async (tabId) =>
    ((await herdrCall('tab.list', {})).result?.tabs ?? []).find((item) => item.tab_id === tabId)?.label ?? null
  // **`친_이름` 과 비교하면 안 된다**: 이 탭의 herdr 기본 표찰이 마침 `"2"` 다(자리 2). 그래서
  // 개명 **전 값**과 견준다 — 실측에서 이 함정에 한 번 걸렸다 (`herdr label 이 그대로인가: false`).
  const herdrLabelBefore = await herdrLabelOf(renameTarget.tabId)
  await renameTab(app, renameTarget.tabId, inRangeName)
  const notices = await readNotices(app)
  out['ⓖ-1 범위 안 숫자로 개명 → 막힌다'] = {
    tabId: renameTarget.tabId,
    친_이름: inRangeName,
    '그때 탭 수': tabCountAtRename,
    알림: notices,
    '막았다고 알렸나': notices.some((text) => typeof text === 'string' && text.includes('이름으로 구분되지 않는다')),
    '개명 전 제목': titleBeforeRename,
    '그려진 제목': await drawnOf(renameTarget.tabId),
    '제목이 그대로인가': (await drawnOf(renameTarget.tabId)) === titleBeforeRename,
    'herdr 기본 표찰(개명 전)': herdrLabelBefore,
    'herdr label 이 그대로인가': (await herdrLabelOf(renameTarget.tabId)) === herdrLabelBefore,
  }
  // 알림이 **떠 있는 동안** 찍는다 — 357 개명 뒤에 찍으면 차단 장면이 아니라 생존 장면이다.
  const shotRename = await app.shot('r5-rename-blocked')
  await renameTab(app, renameTarget.tabId, USER_NAME)
  const named = await until(async () => (await drawnOf(renameTarget.tabId)) === USER_NAME, {
    timeoutMs: 10000,
    everyMs: 200,
    what: 'ⓖ-2 반례 — `357` 은 이름으로 산다',
  })
  out['ⓖ-2 반례 — 357 은 이름이다'] = {
    친_이름: USER_NAME,
    '그려진 제목': await drawnOf(renameTarget.tabId),
    통과: named.ok,
    설명: '차단이 숫자 전체로 넓어지면 여기서 깨진다 (LIFE-357 J-4 가 고친 자리).',
  }
  const shotNamed = await app.shot('r5-rename-357-survives')

  // --- ⓕ 접힘 요약 = 상태 클러스터 (P6/C7) ----------------------------------------------
  //
  // 상태가 다른 세션을 여럿 만들어 접는다. 상태는 ⓓ 와 같은 방법으로 심는다(셸 pane 에 권한을
  // 내려놓고 `pane.report_agent`) — 격리 HOME 에서 실제 에이전트의 상태를 만들 수 없기 때문이다.
  const clusterTabs = []
  for (const state of ['blocked', 'working', 'unknown', 'idle', 'idle']) {
    const count = (await tabsOf(app, repo.root)).length
    await app.click('[data-main-tabbar-add]')
    const grown = await until(
      async () => {
        const rows = await tabsOf(app, repo.root)
        return rows.length === count + 1 ? rows : false
      },
      { timeoutMs: 20000, everyMs: 200, what: `클러스터용 탭 (${state})` },
    )
    const fresh = (grown.value ?? []).at(-1)
    const paneId = fresh.panes[0].paneId
    await herdrCall('pane.clear_agent_authority', { pane_id: paneId })
    await herdrCall('pane.report_agent', { pane_id: paneId, source: 'l366-harness', agent: state === 'working' ? 'codex' : 'claude', state, seq: Date.now() })
    clusterTabs.push({ tabId: fresh.tabId, state })
  }
  await app.send({ cmd: 'resync', reason: 'l366-r5-clusters' })
  // 그룹을 **접는다** — 헤더를 누르면 토글이다.
  await until(async () => (await app.query(`[data-agent-group="${repo.root}"]`)).found.length === 1, {
    timeoutMs: 20000,
    everyMs: 200,
    what: '에이전트 그룹 헤더',
  })
  await app.click(`[data-agent-group="${repo.root}"]`)
  const summaryRow = await until(
    async () => {
      const row = await readSummary(app, repo.root)
      return row !== null && row.clusters.length > 0 ? row : false
    },
    { timeoutMs: 20000, everyMs: 300, what: 'ⓕ 접힘 요약 행' },
  )
  const summary = summaryRow.value ?? (await readSummary(app, repo.root))
  out['ⓕ 접힘 요약 = 상태 클러스터'] = {
    '심은 상태': clusterTabs.map((row) => row.state),
    클러스터: summary?.clusters ?? null,
    '바깥 +N (잘린 클러스터의 세션 합)': summary?.hiddenSessions ?? null,
    '접힌 동안 [data-tab] 수': summary?.sessionRows ?? null,
    '그려진 글월': summary?.text ?? null,
    통과:
      summary !== null &&
      summary.clusters.length === 3 &&
      summary.clusters.map((cluster) => cluster.status).join(',') === 'blocked,working,unknown' &&
      summary.hiddenSessions > 0 &&
      summary.sessionRows === 0,
    설명: '상태 4종이라 클러스터가 3으로 잘리고 바깥 +N 이 실제로 뜬다 (C7 반례 ⓐ).',
  }
  const shotSummary = await app.shot('r5-collapsed-clusters')

  out.판정 = {
    'ⓐ 셸 탭이 terminal N (브랜치 아님)': out['ⓐ 셸 탭 폴백'].통과 && out['ⓐ 셸 탭 폴백']['브랜치가 제목에 안 섞였나'],
    'ⓑ 첫 발화가 제목이 된다 (C5·C1′)': out['ⓑ 첫 발화가 제목'].통과,
    'ⓑ 탭바와 사이드바가 같은 제목 (B6)': out['ⓑ 첫 발화가 제목']['탭바와 사이드바가 같은가'],
    'ⓒ ai-title 이 첫 발화를 이긴다 (C1′ 순서)': out['ⓒ ai-title 이 첫 발화를 이긴다'].통과,
    'ⓓ-1 working 이면 도구가 보인다 (B9)': out['ⓓ-1 working 이면 도구가 보인다'].통과,
    'ⓓ-2 idle 이면 도구를 지어내지 않는다 (B9 반례)': out['ⓓ-2 반례: 같은 꼬리·상태만 idle 이면 지어내지 않는다'].통과,
    'ⓔ 과도기에도 제목이 숫자로 안 떨어진다 (G7)': out['ⓔ 과도기에도 숫자로 안 떨어진다'].통과,
    'ⓖ-1 범위 안 숫자 개명이 막힌다 (G7)':
      out['ⓖ-1 범위 안 숫자로 개명 → 막힌다']['막았다고 알렸나'] && out['ⓖ-1 범위 안 숫자로 개명 → 막힌다']['제목이 그대로인가'],
    'ⓖ-2 다른 이름은 산다 (J-4 회귀)': out['ⓖ-2 반례 — 357 은 이름이다'].통과,
    'ⓕ 접힘 요약이 상태 클러스터다 (C7)': out['ⓕ 접힘 요약 = 상태 클러스터'].통과,
    'id 가 유일한가 (하네스 전제)': collisions.length === 0,
  }
  out.샷 = { shotPrompt, shotTool, shotTransient, shotRename, shotNamed, shotSummary }
  await app.stop()
  writeRaw('r5-orca.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out.판정, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
