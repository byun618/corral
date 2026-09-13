// M1 — 행 생성. L1(20회 연속 기동) · L2(busy 재시도) · A1(생성 레이턴시).
//
// UI 실물 클릭(좌표)으로 새 행을 만들고, **기동 판정은 herdr `pane.process_info` 의 포그라운드
// cmdline** 으로 한다 (관문 ⑤: 화면 표시가 아니라 herdr 응답). 재시도는 앱 로그에서 읽는다.
//
// 정리: 매 회차 관측 후 herdr tab.close 로 그 탭을 닫는다 (하네스 정리 — 20개 claude 가 안 쌓이게).
// 측정 대상은 "UI 로 걸어 결국 뜬다" 이지 정리 경로가 아니라서 정리는 herdr 로 직접 한다.

import { control } from './lib.mjs'
import { REPO_DIR, herdrRequest, makeScratchRepo, pct, readLog, startApp, until, writeRaw } from './lib.mjs'

const ROUNDS = 20
const KIND = 'claude'

const app = await startApp({ name: 'm1-create' })
const out = { at: new Date().toISOString(), kind: KIND, rounds: ROUNDS, ready: app.ready, natural: [], forcedRace: null }

/** herdr pane.list 를 pane_id→tab_id 맵으로. 제3 오라클. */
async function paneMap(workspaceId) {
  const list = await herdrRequest('pane.list', {})
  const map = new Map()
  for (const pane of list.panes) if (pane.workspace_id === workspaceId) map.set(pane.pane_id, pane.tab_id)
  return map
}

/** 그 pane 의 포그라운드에 kind 실행 파일이 보이나 (herdr 오라클). */
async function launched(paneId, kind) {
  const info = await herdrRequest('pane.process_info', { pane_id: paneId })
  const fg = info.process_info?.foreground_processes ?? []
  const cmd = fg.map((p) => p.cmdline ?? p.name ?? '').join(' ')
  return new RegExp(kind).test(cmd) ? { cmd, fg } : null
}

/** 앱 로그에서 이 pane 의 busy 재시도·기동 결과를 읽는다. */
function retriesFor(paneId) {
  const entries = readLog(app.logPath)
  const busy = entries.filter((e) => e.tag === 'lifecycle.agent_busy_retry' && e.paneId === paneId).length
  const started = entries.find((e) => e.tag === 'lifecycle.agent_started' && e.paneId === paneId)
  const failed = entries.find((e) => e.tag === 'lifecycle.agent_start_failed' && e.paneId === paneId)
  return { busyLogged: busy, startedRetries: started?.retries ?? null, failed: failed ? failed.code : null }
}

try {
  const repo = makeScratchRepo('m1')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const wsSeen = await until(
    async () => {
      const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
      return wt?.workspace?.workspaceId ?? null
    },
    { what: 'workspace', timeoutMs: 15000 },
  )
  const workspaceId = wsSeen.value
  out.workspaceId = workspaceId

  // --- L1 자연 20회 ---
  for (let round = 1; round <= ROUNDS; round++) {
    const before = new Set((await paneMap(workspaceId)).keys())
    const click = await app.click(`[data-create-row="${workspaceId}"][data-kind="${KIND}"]`)
    const clickAt = click.at
    // 새 pane 이 herdr 목록에 뜰 때까지
    const appeared = await until(
      async () => {
        for (const [paneId, tabId] of await paneMap(workspaceId)) if (!before.has(paneId)) return { paneId, tabId }
        return null
      },
      { what: `round${round} new pane`, timeoutMs: 15000, everyMs: 60 },
    )
    if (!appeared.ok) {
      out.natural.push({ round, hit: click.hit, error: '새 pane 안 뜸' })
      continue
    }
    const { paneId, tabId } = appeared.value
    const obs = await until(async () => launched(paneId, KIND), { what: `round${round} launch`, timeoutMs: 30000, everyMs: 300 })
    const retries = retriesFor(paneId)
    out.natural.push({
      round,
      hit: click.hit,
      paneId,
      tabId,
      launched: obs.ok,
      launchMs: obs.ms,
      sinceClickMs: obs.ok ? Date.now() - clickAt : null,
      cmd: obs.value?.cmd ?? null,
      ...retries,
    })
    console.log(`[L1 ${round}/${ROUNDS}] launched=${obs.ok} ${obs.ms}ms busy=${retries.busyLogged}`)
    // 정리 (하네스)
    await herdrRequest('tab.close', { tab_id: tabId }).catch(() => {})
    await until(async () => !(await paneMap(workspaceId)).has(paneId), { what: 'cleanup', timeoutMs: 8000 }).catch(() => {})
  }

  // --- L2 강제 레이스: 5개 연속 빠르게 (생성 직후 즉시 start) ---
  const raceBefore = new Set((await paneMap(workspaceId)).keys())
  for (let i = 0; i < 5; i++) await app.click(`[data-create-row="${workspaceId}"][data-kind="${KIND}"]`)
  // 5개 새 pane 이 다 뜰 때까지
  const raceGrew = await until(
    async () => {
      const now = [...(await paneMap(workspaceId)).keys()].filter((id) => !raceBefore.has(id))
      return now.length >= 5 ? now : null
    },
    { what: 'race 5 panes', timeoutMs: 20000, everyMs: 100 },
  )
  const racePanes = raceGrew.value ?? []
  const raceResults = []
  for (const paneId of racePanes) {
    const obs = await until(async () => launched(paneId, KIND), { what: `race launch ${paneId}`, timeoutMs: 30000, everyMs: 300 })
    raceResults.push({ paneId, launched: obs.ok, launchMs: obs.ms, ...retriesFor(paneId) })
  }
  out.forcedRace = {
    count: racePanes.length,
    launched: raceResults.filter((r) => r.launched).length,
    totalBusyRetries: raceResults.reduce((sum, r) => sum + r.busyLogged, 0),
    results: raceResults,
  }
  for (const paneId of racePanes) {
    const tabId = (await paneMap(workspaceId)).get(paneId)
    if (tabId) await herdrRequest('tab.close', { tab_id: tabId }).catch(() => {})
  }

  // --- 집계 ---
  const launchedRounds = out.natural.filter((r) => r.launched)
  const sinceClick = launchedRounds.map((r) => r.sinceClickMs).filter((v) => typeof v === 'number')
  out.summary = {
    l1LaunchedOf20: launchedRounds.length,
    l1Failures: out.natural.filter((r) => !r.launched).length,
    naturalBusyRetriesTotal: out.natural.reduce((sum, r) => sum + (r.busyLogged ?? 0), 0),
    a1SinceClickP50: pct(sinceClick, 50),
    a1SinceClickP95: pct(sinceClick, 95),
  }
  out.verdict =
    out.summary.l1LaunchedOf20 === ROUNDS && out.forcedRace.launched === out.forcedRace.count ? 'PASS' : 'FAIL'

  // 뒷정리
  await herdrRequest('workspace.close', { workspace_id: workspaceId, close_group: true }).catch(() => {})
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('m1-create.json', out)
console.log('\nM1:', out.verdict, JSON.stringify(out.summary))
void REPO_DIR
void control
if (out.verdict !== 'PASS') process.exitCode = 1
