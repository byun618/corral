// A7 — **세션 8개 동시**일 때 폴링 1주기 비용과 터미널 프레임 간격.
//
// 통과선 두 개다: ① 주기당 총 200ms 이하 ② 터미널 스트리밍 프레임 간격 p95 가 붙이기 전보다
// 나빠지지 않는다. ②를 재려면 **같은 화면에서 붙이기 전/후를 둘 다** 재야 한다 — 그래서 한 번의
// 기동 안에서 A(참조 없음) → B(참조 8개) 두 구간을 나눠 잰다. 터미널은 두 구간 내내 같은 루프로
// 출력을 뿜는다(셸 pane 에 date 루프).
//
// 트랜스크립트는 **격리 HOME 에 하네스가 만든다** — 사용자 파일을 복사하지 않는다(E6).
// 크기는 실측 분포를 따라간다: 30MB 1개 · 10MB 1개 · 1MB 2개 · 50KB 4개
// (사용자 실물 분포는 중앙값 0.85MB · 최대 100MB, `raw/claude/a5-a6-cost.json`).
//
// ## 수정 라운드 1 — 판정식을 기준 A7′ 로 갈았다 (V1)
//
// 1회차 판정식은 두 곳에서 기준과 달랐다: ⓐ 최악 구간 C 를 **안 보고** ⓑ 기준에 없는 `×1.1`
// 여유를 스스로 얹었다. 리뷰 3자가 독립으로 같은 자리를 짚었고, 코디네이터가 **재측정 전에**
// 통과선을 개정했다 (`01-criteria.md` [2026-09-15 기준 개정] A7′, 관문 ③ 절차).
//
//   ①′ 세 구간 전부 주기당 총 ≤ 200ms. **주기 수가 0인 구간이 있으면 미달**
//   ②′ 같은 길이·같은 최소 프레임 수로 재고, `p95(B) ≤ p95(A)+5ms` **그리고** `p95(C) ≤ p95(A)+5ms`.
//      곱셈 여유 금지
//
// 그래서 세 구간을 **전부 15초**로 맞췄다 (1회차 C 는 6초였다). C 는 그 15초 내내 8파일을
// 1.3초마다 덧붙여 "전부 바뀐 주기" 를 이어 만든다 — 한 번만 덧붙이면 대부분의 주기가 stat 만
// 하는 구간이 되어 최악이 아니다.
//
// 메인 프로세스 **CPU** 도 같이 잰다 (V12) — 기준 본문이 재라고 한 값인데 1회차는 벽시계만 쟀다.
//
// 관문 ⑤ 반례 둘: ⓐ 구간 A 의 `transcript.read` 는 **주기는 돌되 files 0** 이어야 한다 — 8이
// 나오면 구간 나누기가 안 된 것이다 ⓑ **아무것도 안 돈 구간**(앱이 뜨기 전 시간대)에 ①′ 판정식을
// 그대로 먹이면 미달이 나와야 한다. 여기서 통과가 나오면 "주기 0 = 미달" 조항이 죽은 것이다.

import fs from 'node:fs'
import path from 'node:path'
import {
  buildMixedFixture,
  herdrCall,
  isolatedHome,
  makeScratchRepo,
  resetSession,
  sleep,
  startApp,
  until,
  writeRaw,
} from './lib.mjs'

const SESSION_COUNT = 8
/** 세 구간의 길이를 **같게** 못 박는다 (기준 A7-②′ "같은 길이"). */
const WINDOW_MS = 15000
/**
 * 구간 하나가 가져야 하는 **최소 프레임 수** (A7-②′ "같은 최소 프레임 수").
 * 15초 · 간격 p50 60ms ⇒ 대략 250개다. 절반인 125 를 바닥으로 둔다 — 이보다 적으면 p95 가
 * 표본 부족이라 비교 자체가 성립하지 않는다.
 */
const MIN_FRAMES = 125

function percentile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 100) / 100
}

/** 크기를 맞춘 claude 트랜스크립트를 격리 HOME 에 만든다. */
function makeTranscript({ id, bytes, tailText }) {
  const dir = path.join(isolatedHome(), '.claude', 'projects', 'l366-a7')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  const filler = 'ㄱ'.repeat(300)
  const at = Date.now() - 3600000
  const line = (text, stamp) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(stamp).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n'
  const stream = fs.createWriteStream(file)
  let written = 0
  let index = 0
  const chunkLine = line(filler, at)
  while (written < bytes) {
    stream.write(chunkLine)
    written += chunkLine.length
    index += 1
  }
  stream.write(line(tailText, Date.now() - 60000))
  stream.end()
  return { file, lines: index + 1 }
}

/** 로그에서 한 구간의 `transcript.read` 비용과 `stream.frame` 간격을 뽑는다. */
function windowStats(entries, from, to) {
  const reads = entries.filter((entry) => entry.tag === 'transcript.read' && entry.at >= from && entry.at <= to)
  const frames = entries
    .filter((entry) => entry.tag === 'stream.frame' && entry.at >= from && entry.at <= to)
    .map((entry) => entry.at)
    .sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i] - frames[i - 1])
  return {
    '구간 길이 ms': to - from,
    주기수: reads.length,
    '주기당 files': reads.length === 0 ? null : Math.max(...reads.map((read) => read.files)),
    '주기당 statOnly 최대': reads.length === 0 ? null : Math.max(...reads.map((read) => read.statOnly)),
    '주기 ms 최대': reads.length === 0 ? null : Math.max(...reads.map((read) => read.ms)),
    '주기 ms p95': percentile(reads.map((read) => read.ms), 0.95),
    '주기 바이트 최대': reads.length === 0 ? null : Math.max(...reads.map((read) => read.bytes)),
    프레임수: frames.length,
    '프레임 간격 p50': percentile(gaps, 0.5),
    '프레임 간격 p95': percentile(gaps, 0.95),
    '프레임 간격 최대': gaps.length === 0 ? null : Math.max(...gaps),
  }
}

async function main() {
  const out = { at: new Date().toISOString(), 세션수: SESSION_COUNT }
  out['세션 초기화'] = await resetSession()
  fs.rmSync(path.join(isolatedHome(), '.claude', 'projects', 'l366-a7'), { recursive: true, force: true })

  const repo = makeScratchRepo('a7')
  const app = await startApp({ name: '13-a7-concurrency' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null,
    { timeoutMs: 30000, what: 'worktree opened' },
  )
  const fixture = await buildMixedFixture(app, repo.root, { agents: SESSION_COUNT, shells: 1 })
  out.fixture = { agentTabCount: fixture.agentTabCount, shellTabCount: fixture.shellTabCount }

  const state = await app.state()
  const workspace = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root).workspace
  const agentTabs = workspace.tabs.filter((tab) => tab.panes.some((pane) => pane.agent !== null))
  const shellTab = workspace.tabs.find((tab) => tab.panes.every((pane) => pane.agent === null))
  out['탭 수'] = { 에이전트: agentTabs.length, 셸: shellTab === undefined ? 0 : 1 }

  // 셸 pane 을 골라 **끊임없이 출력**시킨다 — 프레임 간격을 잴 대상이다.
  await app.click(`[data-main-tab="${shellTab.tabId}"]`)
  await sleep(600)
  // **터미널을 눌러 포커스를 준다.** 탭만 고르면 입력이 xterm 으로 안 간다 — 1차 실행에서
  // 루프가 아예 안 돌아 프레임이 0이었다.
  out['터미널 클릭'] = await app.click('.term-host')
  await sleep(400)
  await app.type("while :; do printf 'l366 %s\\n' \"$(date +%s)\"; sleep 0.05; done\r")
  await sleep(3000)
  out['출력 루프 확인'] = (await app.send({ cmd: 'term-read' })).term?.rows?.slice?.(-2) ?? null

  // 앱이 뜨기 **전** 시간대 — 관문 ⑤ 반례ⓑ 가 쓸 "아무것도 안 돈 구간" 이다.
  const deadFrom = Date.now() - 120000
  const deadTo = Date.now() - 110000

  // ---------- 구간 A: 참조 없음 ----------
  const cpuA0 = await app.cpu()
  const aFrom = Date.now()
  await sleep(WINDOW_MS)
  const aTo = Date.now()
  const cpuA1 = await app.cpu()

  // ---------- 참조 8개 + 트랜스크립트 ----------
  const plan = [
    { mb: 30, count: 1 },
    { mb: 10, count: 1 },
    { mb: 1, count: 2 },
    { mb: 0.05, count: 4 },
  ]
  const specs = []
  for (const item of plan) for (let i = 0; i < item.count; i += 1) specs.push(item.mb)
  const attached = []
  for (const [index, tab] of agentTabs.entries()) {
    const mb = specs[index] ?? 0.05
    const id = `a7000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    const made = makeTranscript({ id, bytes: Math.round(mb * 1024 * 1024), tailText: `세션 ${index} 의 마지막 말` })
    const report = await herdrCall('pane.report_agent_session', {
      pane_id: tab.panes[0].paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: id,
    })
    attached.push({ tabId: tab.tabId, mb, bytes: fs.statSync(made.file).size, lines: made.lines, ok: report.error === null })
  }
  out['붙인 트랜스크립트'] = attached
  out['재동기 당김'] = await app.send({ cmd: 'resync', reason: 'l366-a7' })
  const filled = await until(async () => {
    const rows = (await app.send({
      cmd: 'eval',
      code: `(() => [...document.querySelectorAll('.session-row-second')].map((el) => el.getAttribute('data-second-kind')))()`,
    })).result
    return rows.filter((kind) => kind === 'text').length >= SESSION_COUNT ? rows : false
  }, { timeoutMs: 40000, everyMs: 500, what: '8행 모두 2차 줄이 찼다' })
  out['2차 줄이 다 차기까지'] = { ok: filled.ok, ms: filled.ms, kinds: filled.value }

  // ---------- 구간 B: 참조 8개 (정상 상태 — 대부분 stat 만) ----------
  const cpuB0 = await app.cpu()
  const bFrom = Date.now()
  await sleep(WINDOW_MS)
  const bTo = Date.now()
  const cpuB1 = await app.cpu()

  // ---------- 구간 C: **전부 바뀐** 최악 주기를 15초 내내 이어 만든다 ----------
  const touchAll = (round) => {
    for (const index of agentTabs.keys()) {
      const id = `a7000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      const file = path.join(isolatedHome(), '.claude', 'projects', 'l366-a7', `${id}.jsonl`)
      fs.appendFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: `갱신 ${round}-${index} — 전부 바뀐 주기` }] },
        }) + '\n',
      )
    }
  }
  const cpuC0 = await app.cpu()
  const cFrom = Date.now()
  let rounds = 0
  // 폴링이 1.5초라 1.3초마다 건드리면 **거의 모든 주기가 "전부 바뀐 주기"** 가 된다.
  while (Date.now() - cFrom < WINDOW_MS) {
    touchAll(rounds)
    rounds += 1
    await sleep(1300)
  }
  const cTo = Date.now()
  const cpuC1 = await app.cpu()
  out['구간 C — 덧붙인 횟수'] = { rounds, '파일당 줄': rounds, '매 회차 파일수': agentTabs.length }

  const shot = await app.shot('a7-eight-sessions')
  const entries = app.entries()
  await app.stop()

  const A = windowStats(entries, aFrom, aTo)
  const B = windowStats(entries, bFrom, bTo)
  const C = windowStats(entries, cFrom, cTo)
  out['구간 A — 참조 없음'] = A
  out['구간 B — 참조 8개(정상)'] = B
  out['구간 C — 8개 전부 바뀐 주기'] = C
  // --- 기준 A7′ 판정식 (한 군데서만 쓴다 — 반례도 이 함수를 그대로 먹인다) -------------------
  /** ①′ 주기당 총 ≤200ms, **주기 수 0 이면 미달**. */
  const passes1 = (windows) =>
    windows.every((window) => window.주기수 > 0 && (window['주기 ms 최대'] ?? Number.POSITIVE_INFINITY) <= 200)
  /** ②′ `p95(B) ≤ p95(A)+5` **그리고** `p95(C) ≤ p95(A)+5`. 곱셈 여유 없음. */
  const ALLOWANCE_MS = 5
  const passes2 = (base, others) =>
    base !== null && others.every((value) => value !== null && value <= base + ALLOWANCE_MS)

  const dead = windowStats(entries, deadFrom, deadTo)
  out['관문⑤ 반례'] = {
    'ⓐ 구간 A 의 판독 files': {
      설명: '구간 A 는 참조가 0이라 주기는 돌되 files 가 0이어야 한다. 8이 나오면 구간 나누기가 안 된 것이다.',
      'A 의 판독 주기 수': A.주기수,
      'A 의 주기당 files': A['주기당 files'],
      'A 의 주기 바이트 최대': A['주기 바이트 최대'],
      통과: A.주기수 > 0 && A['주기당 files'] === 0,
    },
    'ⓑ 아무것도 안 돈 구간에 ①′ 를 먹인다': {
      설명: '앱이 뜨기 전 시간대다. 「주기 0이면 미달」 조항이 살아 있으면 여기서 ①′ 는 미달이어야 한다.',
      구간: { from: deadFrom, to: deadTo },
      주기수: dead.주기수,
      '①′ 결과': passes1([dead]),
      기대: false,
      반례가_성립하나: passes1([dead]) === false,
    },
  }
  const cpuDelta = (before, after) =>
    before === null || after === null
      ? null
      : { user_ms: Math.round((after.user - before.user) / 1000), system_ms: Math.round((after.system - before.system) / 1000) }
  // 구간 밖이지만 **가장 비싼 주기**다 — 참조가 처음 붙는 주기에 8파일이 한꺼번에 첫 판독을
  // 받는다. 수정 라운드 1 의 제목 훑기(V2)가 파일당 한 번 여기서 돈다: 이 주기만 바이트가 크고
  // 그 다음부터는 안 그렇다(구간 B·C 가 그 증거다). 숨기지 않고 표에 싣는다.
  const allReads = entries.filter((entry) => entry.tag === 'transcript.read' && entry.bytes > 0)
  const worst = allReads.length === 0 ? null : allReads.reduce((max, read) => (read.bytes > max.bytes ? read : max))
  out['첫 채움 주기 (구간 밖)'] = {
    설명: '참조 8개가 처음 붙는 주기. 제목 훑기(V2)가 파일당 한 번 도는 자리라 이 주기만 바이트가 크다.',
    '읽은 주기 수(전체 실행)': allReads.length,
    '가장 비싼 주기': worst === null ? null : { files: worst.files, bytes: worst.bytes, ms: worst.ms },
    '200ms 이하인가': worst === null ? null : worst.ms <= 200,
  }
  out['메인 프로세스 CPU (V12)'] = {
    설명: '구간 앞뒤의 process.cpuUsage() 차 — 통과선은 아니고 기준 본문이 재라고 한 값이다',
    A: cpuDelta(cpuA0, cpuA1),
    B: cpuDelta(cpuB0, cpuB1),
    C: cpuDelta(cpuC0, cpuC1),
    'B−A user_ms': cpuDelta(cpuA0, cpuA1) === null || cpuDelta(cpuB0, cpuB1) === null ? null : cpuDelta(cpuB0, cpuB1).user_ms - cpuDelta(cpuA0, cpuA1).user_ms,
    'C−A user_ms': cpuDelta(cpuA0, cpuA1) === null || cpuDelta(cpuC0, cpuC1) === null ? null : cpuDelta(cpuC0, cpuC1).user_ms - cpuDelta(cpuA0, cpuA1).user_ms,
  }
  out['A7 판정'] = {
    기준: '01-criteria.md [2026-09-15 기준 개정] A7′',
    '구간 길이': { A: A['구간 길이 ms'], B: B['구간 길이 ms'], C: C['구간 길이 ms'] },
    '표본 — 프레임수': { A: A.프레임수, B: B.프레임수, C: C.프레임수, 최소선: MIN_FRAMES },
    '표본 — 주기수': { A: A.주기수, B: B.주기수, C: C.주기수 },
    '같은 길이인가': Math.max(A['구간 길이 ms'], B['구간 길이 ms'], C['구간 길이 ms']) - Math.min(A['구간 길이 ms'], B['구간 길이 ms'], C['구간 길이 ms']) <= 1500,
    '최소 프레임 수를 넘나': [A, B, C].every((window) => window.프레임수 >= MIN_FRAMES),
    '통과선 ①′': '세 구간 전부 주기당 총 ≤200ms · 주기 수 0이면 미달',
    '주기 ms 최대': { A: A['주기 ms 최대'], B: B['주기 ms 최대'], C: C['주기 ms 최대'] },
    '①′ 통과': passes1([A, B, C]),
    '통과선 ②′': 'p95(B) ≤ p95(A)+5ms 그리고 p95(C) ≤ p95(A)+5ms · 곱셈 여유 금지',
    'p95': { A: A['프레임 간격 p95'], B: B['프레임 간격 p95'], C: C['프레임 간격 p95'] },
    '여유 ms': ALLOWANCE_MS,
    '②′ 통과': passes2(A['프레임 간격 p95'], [B['프레임 간격 p95'], C['프레임 간격 p95']]),
  }
  out.스크린샷 = shot
  out.rawChain = app.rawChain()
  writeRaw('a7-concurrency-r1.json', out)
  console.log(JSON.stringify({ A, B, C, 판정: out['A7 판정'], 반례: out['관문⑤ 반례'] }, null, 1))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
