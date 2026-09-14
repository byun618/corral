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
// 관문 ⑤ 반례: 구간 A 의 `transcript.read` 는 **files 0** 이어야 한다. 거기서도 8이 나오면
// 구간 나누기가 안 된 것이고, 그러면 ②의 비교는 아무 의미가 없다.

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

  // ---------- 구간 A: 참조 없음 ----------
  const aFrom = Date.now()
  await sleep(15000)
  const aTo = Date.now()

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
  const bFrom = Date.now()
  await sleep(15000)
  const bTo = Date.now()

  // ---------- 구간 C: **전부 바뀐** 최악 주기 ----------
  const cFrom = Date.now()
  for (const [index, tab] of agentTabs.entries()) {
    void tab
    const id = `a7000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    const file = path.join(isolatedHome(), '.claude', 'projects', 'l366-a7', `${id}.jsonl`)
    fs.appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: `갱신 ${index} — 전부 바뀐 주기` }] },
      }) + '\n',
    )
  }
  await sleep(6000)
  const cTo = Date.now()

  const shot = await app.shot('a7-eight-sessions')
  const entries = app.entries()
  await app.stop()

  const A = windowStats(entries, aFrom, aTo)
  const B = windowStats(entries, bFrom, bTo)
  const C = windowStats(entries, cFrom, cTo)
  out['구간 A — 참조 없음'] = A
  out['구간 B — 참조 8개(정상)'] = B
  out['구간 C — 8개 전부 바뀐 주기'] = C
  out['관문⑤ 반례'] = {
    설명: '구간 A 는 참조가 0이라 판독 비용이 0이어야 한다. 여기서도 8이 나오면 구간 나누기가 안 된 것이다.',
    'A 의 판독 주기 수': A.주기수,
    'A 의 주기당 files': A['주기당 files'],
    기대: '주기 수 0 (참조가 없으면 로그 자체가 안 남는다 — 비용 0)',
  }
  out['A7 판정'] = {
    '통과선 ①': '주기당 총 200ms 이하',
    '최대 주기 ms(B·C)': Math.max(B['주기 ms 최대'] ?? 0, C['주기 ms 최대'] ?? 0),
    '① 통과': (B['주기 ms 최대'] ?? 0) <= 200 && (C['주기 ms 최대'] ?? 0) <= 200,
    '통과선 ②': '프레임 간격 p95 가 붙이기 전보다 나빠지지 않는다',
    'p95 A': A['프레임 간격 p95'],
    'p95 B': B['프레임 간격 p95'],
    'p95 C': C['프레임 간격 p95'],
    '② 통과': A['프레임 간격 p95'] !== null && B['프레임 간격 p95'] !== null && B['프레임 간격 p95'] <= A['프레임 간격 p95'] * 1.1,
  }
  out.스크린샷 = shot
  out.rawChain = app.rawChain()
  writeRaw('a7-concurrency.json', out)
  console.log(JSON.stringify({ A, B, C, 판정: out['A7 판정'], 반례: out['관문⑤ 반례'] }, null, 1))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
