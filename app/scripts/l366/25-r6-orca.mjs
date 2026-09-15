// 수정 라운드 6 — **사용자가 신고한 장면을 화면에서 그대로 재현**한다 (C6′-①).
//
// codex 의 R1 은 판독층 단위에서 잡혔고(`24-r6-race.mts`), 코디네이터가 그것을 최상위로 올린
// 이유는 **그 결함이 사용자가 게이트 ②에서 밟을 길**이기 때문이다. 그래서 같은 순서를 앱에서 낸다:
//
//   ⓐ 세션 참조가 먼저 붙는다 — 트랜스크립트에 **메타 한 줄**뿐인 순간이다 → 제목은 폴백(`claude N`)
//   ⓑ 사용자가 첫 말을 친다 (하네스가 그 줄을 append 한다) → **다음 갱신에 제목이 그 말이 된다**
//   ⓒ 그 뒤로 더 쳐도 제목은 **첫 말 그대로** — 나중 발화로 안 바뀐다 (C6′-④ 의 화면 쪽 얼굴)
//
// r5 빌드에서 돌리면 ⓑ 가 실패한다 — 앱을 껐다 켜기 전에는 제목이 영영 폴백이다(관문 ⑤ 반례 ⓐ).
// 격리(관문 ④): 앱·herdr 세션·스크래치 레포·트랜스크립트 전부 격리 HOME.

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

const BRANCH = 'LIFE-366-r6-race'
const SESSION_ID = 'a6a6a6a6-b6b6-4b6b-8b6b-000000000066'
const FIRST_PROMPT = '늦게 붙은 첫 발화가 제목이 되어야 한다. 그리고 결과를 알려라.'
const FIRST_PROMPT_TITLE = '늦게 붙은 첫 발화가 제목이 되어야 한다'
const SECOND_PROMPT = '두 번째로 친 말은 제목이 아니다. 첫 말이 그대로 남아야 한다.'

async function readTabs(app) {
  const code = `(() => [...document.querySelectorAll('.main-tab')].map((tab) => ({
    tabId: tab.getAttribute('data-main-tab'),
    label: (tab.querySelector('.main-tab-label') ?? {}).textContent ?? null,
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

async function readRows(app) {
  const code = `(() => [...document.querySelectorAll('.session-row')].map((row) => ({
    tabId: row.getAttribute('data-tab'),
    title: (row.querySelector('.session-row-title') ?? {}).textContent ?? null,
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

const transcriptDir = () => path.join(isolatedHome(), '.claude', 'projects', 'l366-r6')

function writeTranscript(lines) {
  const dir = transcriptDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function appendTranscript(lines) {
  fs.appendFileSync(path.join(transcriptDir(), `${SESSION_ID}.jsonl`), lines.join('\n') + '\n')
}

const metaRecord = () => JSON.stringify({ type: 'attachment', sessionId: SESSION_ID })

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

/** 같은 id 파일이 격리 HOME 안에 또 있으면 판독층이 엉뚱한 쪽을 집는다 (r4·r6 에서 한 번씩 밟았다). */
function idCollisions() {
  const projects = path.join(isolatedHome(), '.claude', 'projects')
  if (!fs.existsSync(projects)) return []
  return fs
    .readdirSync(projects)
    .filter((folder) => folder !== 'l366-r6')
    .map((folder) => path.join(projects, folder, `${SESSION_ID}.jsonl`))
    .filter((candidate) => fs.existsSync(candidate))
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }
  out['세션 초기화'] = await resetSession()
  fs.rmSync(transcriptDir(), { recursive: true, force: true })

  const repo = makeScratchRepo('r6-race')
  repo.git('checkout', '-b', BRANCH)
  out['스크래치 레포'] = { root: repo.root, branch: BRANCH }

  const app = await startApp({ name: '25-r6-orca' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await tabsOf(app, repo.root)).length > 0, { timeoutMs: 30000, what: 'worktree opened' })

  await createTab(app, repo.root, 'claude')
  const found = await until(
    async () => {
      const tabs = await tabsOf(app, repo.root)
      const agent = tabs.find((tab) => tab.panes.some((pane) => pane.agent !== null)) ?? null
      return agent === null ? false : agent
    },
    { timeoutMs: 40000, everyMs: 300, what: 'claude 탭' },
  )
  const agent = found.value
  const drawnOf = async (tabId) => (await readTabs(app)).find((row) => row.tabId === tabId)?.label ?? null
  const rowOf = async (tabId) => (await readRows(app)).find((row) => row.tabId === tabId)?.title ?? null

  // --- ⓐ 참조가 **메타 한 줄뿐인 파일**에 먼저 붙는다 ------------------------------------
  const collisions = idCollisions()
  writeTranscript([metaRecord()])
  out['참조 주입'] = {
    'id 충돌': collisions,
    '그때 트랜스크립트': '메타 한 줄 (사람 발화 없음)',
    보고: await herdrCall('pane.report_agent_session', {
      pane_id: agent.panes[0].paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: SESSION_ID,
    }),
  }
  await app.send({ cmd: 'resync', reason: 'l366-r6-ref' })
  const fallback = `claude ${agent.number}`
  const atFallback = await until(async () => (await drawnOf(agent.tabId)) === fallback, {
    timeoutMs: 30000,
    everyMs: 300,
    what: 'ⓐ 폴백 제목',
  })
  // **여기서 기다리는 게 이 프로브의 핵심이다.** 폴백 제목만 보고 넘어가면 「아직 트랜스크립트를
  // 안 읽은 상태」와 구별이 안 된다 — 그러면 r5 빌드에서도 이 칸이 통과해 판별력이 사라진다
  // (실측으로 밟았다: 반례 실행이 ⓑ 까지 통과했다). 갱신 주기(1.5초)를 여러 번 지나며 폴백이
  // 유지되는 것을 확인해야 **메타 한 줄짜리 파일을 실제로 읽어 캐시에 앉혔다**는 뜻이 된다.
  const holdSamples = []
  for (let index = 0; index < 8; index += 1) {
    holdSamples.push(await drawnOf(agent.tabId))
    await sleep(800)
  }
  out['ⓐ 발화 전에는 폴백'] = {
    기대: fallback,
    '그려진 제목': await drawnOf(agent.tabId),
    '유지 샘플(8회 · 800ms = 6.4초 · 갱신 주기 1.5초)': [...new Set(holdSamples)],
    '그 사이 판독층이 메타뿐인 파일을 읽었다': holdSamples.every((label) => label === fallback),
    ms: atFallback.ms,
    통과: atFallback.ok && holdSamples.every((label) => label === fallback),
  }
  const shotBefore = await app.shot('r6-before-first-prompt')

  // --- ⓑ 사용자가 첫 말을 친다 → **다음 갱신에 제목이 산다** -------------------------------
  //
  // 앱은 계속 돌고 있고 캐시도 그대로다. r5 는 여기서 영영 안 살아났다 (codex R1).
  appendTranscript([userRecord(FIRST_PROMPT), assistantText('확인했다')])
  const revived = await until(async () => (await drawnOf(agent.tabId)) === FIRST_PROMPT_TITLE, {
    timeoutMs: 30000,
    everyMs: 300,
    what: 'ⓑ 늦게 붙은 첫 발화가 제목',
  })
  out['ⓑ 늦게 붙은 첫 발화가 제목이 된다'] = {
    기대: FIRST_PROMPT_TITLE,
    '그려진 탭 제목': await drawnOf(agent.tabId),
    '그려진 사이드바 제목': await rowOf(agent.tabId),
    '탭바와 사이드바가 같은가': (await drawnOf(agent.tabId)) === (await rowOf(agent.tabId)),
    '앱을 다시 안 켰다': true,
    ms: revived.ms,
    통과: revived.ok,
    설명: 'r5 빌드에서는 이 칸이 폴백(`claude N`)에 머문다 — 사용자가 신고한 「제목이 안 바뀐다」.',
  }
  const shotAfter = await app.shot('r6-after-first-prompt')

  // --- ⓒ 그 뒤에 친 말로는 **안 바뀐다** ---------------------------------------------------
  appendTranscript([userRecord(SECOND_PROMPT), assistantText('그래도 첫 말이 제목이다')])
  await app.send({ cmd: 'resync', reason: 'l366-r6-second' })
  await sleep(3000)
  out['ⓒ 나중 발화로는 안 바뀐다'] = {
    '두 번째 발화': SECOND_PROMPT,
    '그려진 제목': await drawnOf(agent.tabId),
    통과: (await drawnOf(agent.tabId)) === FIRST_PROMPT_TITLE,
    설명: '머리 판독은 첫 발화를 찾은 순간 끝난다 (C6′-④) — 제목이 대화 중에 흔들리면 안 된다.',
  }

  out.판정 = {
    'ⓐ 발화 전에는 폴백 (claude N)': out['ⓐ 발화 전에는 폴백'].통과,
    'ⓑ 늦게 붙은 첫 발화가 제목이 된다 (C6′-①)': out['ⓑ 늦게 붙은 첫 발화가 제목이 된다'].통과,
    'ⓑ 탭바와 사이드바가 같은 제목 (B6)': out['ⓑ 늦게 붙은 첫 발화가 제목이 된다']['탭바와 사이드바가 같은가'],
    'ⓒ 나중 발화로는 안 바뀐다 (C6′-④)': out['ⓒ 나중 발화로는 안 바뀐다'].통과,
    'id 가 유일한가 (하네스 전제)': collisions.length === 0,
  }
  // --- A6 재측정 (C6′-③) — **앱이 실제로 돈 주기**의 비용을 로그에서 그대로 가져온다 ---------
  //
  // 하네스가 따로 재는 값이 아니라 `transcript.read` 로그다. 재판독을 열었는데도 주기 비용이
  // 안 늘었다는 것을 여기서 본다: 파일이 안 바뀐 주기는 `statOnly`(0바이트), 바뀐 주기도
  // 파일이 창보다 작아 `headBytes = 0` 이다.
  const cycles = app
    .entries()
    .filter((entry) => entry.tag === 'transcript.read')
    .map((entry) => ({ ts: entry.ts, files: entry.files, statOnly: entry.statOnly, bytes: entry.bytes, headBytes: entry.headBytes, ms: entry.ms }))
  const headCycles = cycles.filter((cycle) => Number(cycle.headBytes) > 0)
  const otherCycles = cycles.filter((cycle) => Number(cycle.headBytes) === 0)
  out['A6 주기 비용 (개정 예산)'] = {
    주기수: cycles.length,
    '머리를 읽은 주기': headCycles.length,
    '머리를 읽은 주기 최대 바이트': headCycles.length === 0 ? null : Math.max(...headCycles.map((cycle) => Number(cycle.bytes))),
    '나머지 주기 최대 바이트': otherCycles.length === 0 ? null : Math.max(...otherCycles.map((cycle) => Number(cycle.bytes))),
    '최대 ms': cycles.length === 0 ? null : Math.max(...cycles.map((cycle) => Number(cycle.ms))),
    '주기당 머리 ≤256KB': cycles.every((cycle) => Number(cycle.headBytes) <= 256 * 1024),
    '머리를 읽은 주기 ≤2.25MB': headCycles.every((cycle) => Number(cycle.bytes) <= 2.25 * 1024 * 1024),
    '나머지 주기 ≤2MB': otherCycles.every((cycle) => Number(cycle.bytes) <= 2 * 1024 * 1024),
    표: cycles,
    설명: '메타뿐인 파일을 다시 읽는 주기도 여기 있다 — 파일이 안 바뀐 주기는 statOnly 라 0바이트다.',
  }
  out.판정['A6 주기 예산 (C6′-②③)'] =
    out['A6 주기 비용 (개정 예산)']['주기당 머리 ≤256KB'] &&
    out['A6 주기 비용 (개정 예산)']['머리를 읽은 주기 ≤2.25MB'] &&
    out['A6 주기 비용 (개정 예산)']['나머지 주기 ≤2MB']

  out.샷 = { shotBefore, shotAfter }
  await app.stop()
  writeRaw('r6-orca.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out.판정, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
