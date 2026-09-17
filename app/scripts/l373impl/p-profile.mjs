// **G-4 — P3 렌더러 프로파일** (`11-gate1-fix.md` 1단계). **앱 코드는 0줄 고친다.**
//
// 네 라운드 동안 P3 에서 배제한 것은 전부 **측정 쪽 후보**였다(예열·순서·이상점·기계 부하).
// 렌더러 안을 직접 본 적은 없다. 이 회차가 그 자리다.
//
// 재는 것은 **한 회차의 플레임그래프가 아니라 낮은 모드 대 높은 모드의 대조**다 —
// 같은 부하(판정점 모양)에서 창을 여러 번 돌려 두 모드를 다 잡고, **높은 모드에서 어느 함수의
// 자기시간이 늘어나는가**를 본다.
//
// 어떻게 앱을 안 고치고 프로파일을 잡나: Electron 바이너리에 `--remote-debugging-port` 를
// 붙이고(하네스의 `startApp({extraArgs})`) 렌더러 타깃에 CDP 로 붙어 `Profiler` 를 쓴다.
// WebSocket 은 node 22 의 내장 전역이다 — 의존성을 안 더한다.
//
// **이 회차의 수는 판정 표본이 아니다** (11-gate1-fix): 프로파일러는 재는 대상을 흔든다.
// 판정은 §14-9 의 조용한 12 표본이 계속 진다.
//
// 격리: `life373-` 세션 전용 · `CORRAL_UI_PREFS` · M0-e 부하 기록.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, press, quiesce } from './app-steps.mjs'
import { APP_DIR, ensureWorkspace, loadSnapshot, m0End, m0Start, paneList, paneRead, psSample, resetPanes, writeRaw, 부하델타 } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-prof-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const PORT = Number(process.env.L373_CDP_PORT ?? 9333)
const WINDOWS = Number(process.env.L373_PROFILE_WINDOWS ?? 8)
const HZ = Number(process.env.L373_PROFILE_HZ ?? 15)
const WINDOW_MS = 12000
const LOAD_SECS = 40
const HEAVY_EVERY = 5
const HEAVY_RICH = '2'
const SAMPLE_US = Number(process.env.L373_SAMPLE_US ?? 250)
const WIN_W = Number(process.env.L373_WIN_W ?? 1950)
const WIN_H = Number(process.env.L373_WIN_H ?? 1080)
const OUT_NAME = process.env.L373_OUT ?? 'p-profile.json'
/**
 * **대조 회차** — `1` 이면 CDP 도 `--remote-debugging-port` 도 프로파일러도 **안 붙인다**.
 *
 * 1차 프로파일 20창이 48.4~53.4 에만 모여 **높은 모드가 한 번도 안 나왔다**. 그게 프로파일러
 * 때문인지, 아니면 *"한 앱 세션에서 창을 반복한다"* 는 이 회차의 구조 때문인지 갈라야 한다.
 * 이 대조는 **구조만 남기고 프로파일러를 뺀다.**
 */
const PROFILE_OFF = process.env.L373_PROFILE_OFF === '1'
const ETX = '\u0003'

const 결과 = {
  at: new Date().toISOString(),
  세션: SESSION,
  M0,
  무엇: 'G-4 렌더러 프로파일 — 낮은 모드 대 높은 모드 대조 (판정 표본 아님)',
  조건: { pane: 4, hz: HZ, 색런: HEAVY_EVERY, 속성: '전경+배경(24비트)+굵기', 창ms: WINDOW_MS, 표본간격us: SAMPLE_US, 창수: WINDOWS },
  창: { width: WIN_W, height: WIN_H },
  'M0-e': { 조건표시: process.env.L373_LOAD_TAG ?? null, 회차직전: null, 회차직후: null, 회차전체: null },
  창들: [],
}

// --- CDP ------------------------------------------------------------------------------
async function cdpTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      // `globalThis.` 를 붙여 둔다 — 이 하네스의 eslint env 는 node 22 전역을 모른다(lint 증감 0 규율).
      const res = await globalThis.fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(500)
  }
  throw new Error(`CDP 타깃을 못 찾았다 (port ${PORT})`)
}

/** 최소 CDP 클라이언트 — node 22 내장 `WebSocket`. */
function cdpConnect(url) {
  const ws = new globalThis.WebSocket(url)
  const 대기 = new Map()
  let seq = 0
  const 열림 = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error(`CDP 연결 실패: ${e.message ?? 'unknown'}`)))
  })
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id === undefined) return
    const pending = 대기.get(msg.id)
    if (pending === undefined) return
    대기.delete(msg.id)
    if (msg.error) pending.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`))
    else pending.resolve(msg.result)
  })
  return {
    열림,
    send(method, params = {}) {
      seq += 1
      const id = seq
      const p = new Promise((resolve, reject) => 대기.set(id, { resolve, reject }))
      ws.send(JSON.stringify({ id, method, params }))
      return p
    },
    close: () => ws.close(),
  }
}

/**
 * `Profiler.stop` 이 준 프로파일을 **자기시간**으로 접는다.
 *
 * `samples[i]` 가 그 순간 **맨 위** 프레임이므로, 표본마다 `timeDeltas[i]` 를 그 노드에 더하면
 * 자기시간이다. 부모로 접지 않는다 — 우리가 묻는 것이 *"어느 함수가 더 도나"* 이기 때문이다.
 */
function 접기(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const 자기 = new Map()
  const deltas = profile.timeDeltas ?? []
  let 총 = 0
  profile.samples.forEach((id, i) => {
    const us = deltas[i] ?? 0
    if (us <= 0) return
    총 += us
    자기.set(id, (자기.get(id) ?? 0) + us)
  })
  const 이름 = (node) => {
    const cf = node.callFrame
    const fn = cf.functionName === '' ? '(anonymous)' : cf.functionName
    const url = cf.url === '' ? '' : cf.url.replace(/^file:\/\/.*\/out\//, 'out/').replace(/^file:\/\/.*\/node_modules\//, 'node_modules/')
    return url === '' ? fn : `${fn} @ ${url}:${cf.lineNumber + 1}`
  }
  /** 늘어난 자리가 **우리 코드인지**를 갈라야 ⓐ/ⓑ 판정이 선다 (11-gate1-fix G-4). */
  const 갈래 = (node) => {
    const url = node.callFrame.url ?? ''
    const fn = node.callFrame.functionName ?? ''
    if (fn.startsWith('(') && url === '') return fn === '(program)' ? 'Chromium/V8 내부' : fn === '(garbage collector)' ? 'GC' : fn === '(idle)' ? '유휴' : 'Chromium/V8 내부'
    if (url.includes('@xterm') || url.includes('xterm')) return 'xterm'
    if (url.includes('node_modules')) return '다른 의존성'
    if (url === '') return 'Chromium/V8 내부'
    return '우리 코드(renderer)'
  }
  const 행 = [...자기.entries()]
    .map(([id, us]) => {
      const node = byId.get(id)
      return { 이름: 이름(node), 갈래: 갈래(node), ms: +(us / 1000).toFixed(1) }
    })
    .sort((a, b) => b.ms - a.ms)
  const 갈래합 = {}
  for (const r of 행) 갈래합[r.갈래] = +((갈래합[r.갈래] ?? 0) + r.ms).toFixed(1)
  // 같은 이름이 여러 노드로 쪼개져 있다(호출 경로마다 노드가 다르다) — 이름으로 한 번 더 접는다.
  const 이름별 = new Map()
  for (const r of 행) {
    const 앞 = 이름별.get(r.이름)
    if (앞 === undefined) 이름별.set(r.이름, { ...r })
    else 앞.ms = +(앞.ms + r.ms).toFixed(1)
  }
  return {
    총ms: +(총 / 1000).toFixed(1),
    갈래합,
    상위: [...이름별.values()].sort((a, b) => b.ms - a.ms).slice(0, 25),
  }
}

// --- 부하 -----------------------------------------------------------------------------
function rendererPid() {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const mine = path.join(APP_DIR, 'node_modules')
  return (
    out
      .split('\n')
      .filter((line) => line.includes(mine) && line.includes('--type=renderer'))
      .map((line) => Number(line.trim().split(/\s+/)[0]))[0] ?? null
  )
}
const paneWrites = async (app) =>
  (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result
const grids = async (app) => new Map(((await paneWrites(app)) ?? []).map((row) => [row.paneId, { cols: row.cols, rows: row.rows }]))
const startLoad = (paneIds, gridMap) => {
  paneIds.forEach((paneId, index) => {
    const grid = gridMap.get(paneId)
    if (grid === undefined) throw new Error(`격자를 모르는 pane: ${paneId}`)
    execFileSync('herdr', [
      '--session',
      SESSION,
      'pane',
      'run',
      paneId,
      `${process.execPath} ${path.join(APP_DIR, 'scripts/l373impl/load-heavy.mjs')} --cols ${grid.cols} --rows ${grid.rows}` +
        ` --hz ${HZ} --secs ${LOAD_SECS} --every ${HEAVY_EVERY} --rich ${HEAVY_RICH} --tag p${index + 1}`,
    ])
  })
}
const stopLoad = (paneIds) => {
  for (const paneId of paneIds) {
    try {
      execFileSync('herdr', ['--session', SESSION, 'pane', 'send-text', paneId, ETX])
    } catch {
      /* 이미 끝났으면 그만이다 */
    }
  }
}

// --- 준비 -----------------------------------------------------------------------------
ensureWorkspace()
const 회차부하시작 = loadSnapshot()
결과['M0-e'].회차직전 = 회차부하시작 === null ? null : { at: new Date(회차부하시작.at).toISOString(), loadavg1: 회차부하시작.loadavg1 }
결과.초기화 = await resetPanes()
const app = await startApp({
  name: 'p-profile',
  env: APP_ENV,
  registryFile: REGISTRY,
  extraArgs: PROFILE_OFF ? [] : [`--remote-debugging-port=${PORT}`],
})
await attachThisWorktree(app)
await app.send({ cmd: 'resize-window', width: WIN_W, height: WIN_H })
await sleep(1500)
await quiesce(app)

await press(app, { key: 'd' })
await sleep(2400)
await press(app, { key: 'ArrowRight', alt: true })
await sleep(1200)
await press(app, { key: 'd', shift: true })
await sleep(2400)
await press(app, { key: 'ArrowLeft', alt: true })
await sleep(1200)
await press(app, { key: 'd', shift: true })
await sleep(2400)
await quiesce(app)

const 선택 = (await app.send({ cmd: 'eval', code: `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()` })).result
const tabId = paneList().find((p) => p.pane_id === 선택)?.tab_id ?? null
const 네pane = paneList()
  .filter((p) => p.tab_id === tabId)
  .map((p) => p.pane_id)
결과.준비 = { tabId, paneIds: 네pane }
console.log('# 준비', JSON.stringify(결과.준비))

let cdp = null
if (PROFILE_OFF) {
  console.log('# 대조 회차 — 프로파일러 없음 (구조만 같다)')
  결과.CDP = null
  결과.대조회차 = '프로파일러·원격디버깅 없음'
} else {
  const target = await cdpTarget()
  console.log('# CDP 타깃', target.url)
  cdp = cdpConnect(target.webSocketDebuggerUrl)
  await cdp.열림
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: SAMPLE_US })
  결과.CDP = { url: target.url, title: target.title }
}

// --- 창 반복 --------------------------------------------------------------------------
const 프로파일보관 = []
for (let i = 1; i <= WINDOWS; i += 1) {
  console.log(`\n## 창 ${i}/${WINDOWS}`)
  const gridMap = await grids(app)
  startLoad(네pane, gridMap)
  await sleep(3500)
  const 부하확인 = 네pane.map((paneId) => ({ paneId, 걸렸나: /[▏▎▍▌▋▊▉█░▒▓]/.test(paneRead(paneId, 4)) }))
  const cpuBefore = psSample(rendererPid())
  const 부하전 = loadSnapshot()
  if (cdp !== null) await cdp.send('Profiler.start')
  const t0 = Date.now()
  await sleep(WINDOW_MS)
  const profile = cdp === null ? null : (await cdp.send('Profiler.stop')).profile
  const t1 = Date.now()
  const 부하후 = loadSnapshot()
  const cpuAfter = psSample(rendererPid())
  stopLoad(네pane)
  const 프레임 = ((await paneWrites(app)) ?? []).reduce((sum, row) => sum + row.writes.filter((w) => w.at >= t0 && w.at <= t1).length, 0)
  const cpuPct =
    cpuBefore === null || cpuAfter === null || cpuBefore.cpuSec === null || cpuAfter.cpuSec === null
      ? null
      : +(((cpuAfter.cpuSec - cpuBefore.cpuSec) / ((cpuAfter.at - cpuBefore.at) / 1000)) * 100).toFixed(1)
  const 접힌 = profile === null ? null : 접기(profile)
  const row = {
    창: i,
    렌더러CPU: cpuPct,
    부하걸렸나: 부하확인.every((r) => r.걸렸나),
    총프레임_초당: +(프레임 / ((t1 - t0) / 1000)).toFixed(2),
    부하: 부하델타(부하전, 부하후),
    프로파일: 접힌,
  }
  if (profile !== null) 프로파일보관.push({ 창: i, cpuPct, profile })
  결과.창들.push(row)
  console.log(
    `  CPU ${cpuPct} | 프레임/s ${row.총프레임_초당} | 부하 ${row.부하걸렸나} | 표본총 ${접힌?.총ms ?? '없음'}ms | 밖합 ${row.부하?.밖합}`,
  )
  if (접힌 !== null) console.log('  상위5', 접힌.상위.slice(0, 5).map((r) => `${r.이름.slice(0, 44)} ${r.ms}`).join(' · '))
  await sleep(2500)
}

// --- 두 모드 대조 ---------------------------------------------------------------------
const 유효 = 결과.창들.filter((r) => r.부하걸렸나 && r.렌더러CPU !== null)
const 정렬 = [...유효].sort((a, b) => a.렌더러CPU - b.렌더러CPU)
const 낮 = 정렬[0] ?? null
const 높 = 정렬.at(-1) ?? null
if (낮 !== null && 높 !== null && 낮.프로파일 !== null && 높.프로파일 !== null) {
  const 맵 = (row) => new Map(row.프로파일.상위.map((r) => [r.이름, r.ms]))
  const 낮맵 = 맵(낮)
  const 높맵 = 맵(높)
  const 이름들 = new Set([...낮맵.keys(), ...높맵.keys()])
  결과.대조 = {
    낮은모드: { 창: 낮.창, CPU: 낮.렌더러CPU, 총ms: 낮.프로파일.총ms, 갈래합: 낮.프로파일.갈래합 },
    높은모드: { 창: 높.창, CPU: 높.렌더러CPU, 총ms: 높.프로파일.총ms, 갈래합: 높.프로파일.갈래합 },
    비: 낮.렌더러CPU === 0 ? null : +(높.렌더러CPU / 낮.렌더러CPU).toFixed(3),
    함수별차: [...이름들]
      .map((이름) => ({ 이름, 낮: 낮맵.get(이름) ?? 0, 높: 높맵.get(이름) ?? 0, 차: +((높맵.get(이름) ?? 0) - (낮맵.get(이름) ?? 0)).toFixed(1) }))
      .sort((a, b) => b.차 - a.차)
      .slice(0, 20),
  }
  console.log('\n대조', JSON.stringify(결과.대조, null, 1))
  // 대조 쌍의 **원본 프로파일만** 남긴다 — 전량은 수십 MB 다.
  for (const [태그, row] of [['낮은모드', 낮], ['높은모드', 높]]) {
    const 원본 = 프로파일보관.find((p) => p.창 === row.창)
    if (원본 !== undefined) writeRaw(`${OUT_NAME.replace(/\.json$/, '')}-${태그}.cpuprofile`, 원본.profile)
  }
}

if (cdp !== null) cdp.close()
await app.stop()
await sleep(1500)
{
  const 회차부하끝 = loadSnapshot()
  결과['M0-e'].회차직후 = 회차부하끝 === null ? null : { at: new Date(회차부하끝.at).toISOString(), loadavg1: 회차부하끝.loadavg1 }
  결과['M0-e'].회차전체 = 부하델타(회차부하시작, 회차부하끝)
}
결과.M0_끝 = m0End()
writeRaw(OUT_NAME, 결과)
