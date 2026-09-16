// §4 성능 **판정점 + 한계 곡선** (§10-R29).
//
// R29 가 판정점을 못 박았다 — 1차 스파이크의 보정점과 **같은 자리**에서 재라는 뜻이다:
//   · 4 pane (1·2 병기) · pane 격자 **100×30 ±10%** · **28±6 KB/pane · 셀당 9~12 B**
//   · 모든 pane 이 매 프레임 바뀐다 (크롭 skip 은 **켠 채** — 이 조건에서 skip 은 아무것도 못 걸러야 한다)
//   · **제3 오라클로 pane 글자를 읽어 부하 도달 확인** (실패하면 그 단계는 무효다)
//
// 그리고 한 점만으로는 못 쓴다 — **P3(70%)·P4(25ms)·P5(0.70)를 처음 넘는 지점**을
// 총 프레임/s · 총 셀/s · KB/s 세 축으로 같이 싣는다. 부하 hz 를 올려 가며 훑는다.
//
// 격자를 줄여 통과시키지 않는다. 미달이면 미달로 적는다 (R29-3).
//
// 격리: `life373-` 세션 전용. M0(내 유령) · M0-b(종료 후) · M0-c(prefs).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, press, quiesce } from './app-steps.mjs'
import { APP_DIR, ensureWorkspace, m0End, m0Start, paneList, paneRead, pct, psSample, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-plim-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
/** 훑는 부하 주기 — 마지막 값이 **판정점**(모든 pane 이 매 프레임 바뀌는 조건)이다. */
const HZ_LIST = (process.env.L373_HZ_LIST ?? '5,10,15,20,30,45,60').split(',').map(Number)
const WINDOW_MS = Number(process.env.L373_WINDOW_MS ?? 12000)
const IDLE_MS = 5000
const HEAVY_EVERY = Number(process.env.L373_HEAVY_EVERY ?? 2)
const LOAD_SECS = 40
/** 판정점 격자 — 100×30 ±10%. 창 크기는 여기에 맞춰 찾는다. */
const 목표 = { cols: 100, rows: 30, 여유: 0.1 }
const WIN_W = Number(process.env.L373_WIN_W ?? 1720)
const WIN_H = Number(process.env.L373_WIN_H ?? 1120)
const P3_LINE = 70
const P4_LINE = 25
const P5_RATIO = 0.7
const ETX = '\u0003'

const 결과 = {
  at: new Date().toISOString(),
  세션: SESSION,
  M0,
  판정점조건: { pane: 4, 격자: `${목표.cols}x${목표.rows} ±10%`, 프레임: '28±6 KB/pane · 셀당 9~12 B', skip: '켠 채 · 아무것도 못 걸러야 한다' },
  통과선: { P3: P3_LINE, P4: P4_LINE, P5: `${P5_RATIO} × 유휴 바닥` },
  창: { width: WIN_W, height: WIN_H },
  훑기: [],
}

function rendererPid() {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const mine = path.join(APP_DIR, 'node_modules')
  const rows = out
    .split('\n')
    .filter((line) => line.includes(mine) && line.includes('--type=renderer'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
  return rows[0] ?? null
}

/**
 * rAF 하트비트 — **세대 토큰**으로 이전 루프를 확실히 끊는다.
 *
 * `stop` 플래그만 쓰면 옛 루프가 새 객체의 `stop:false` 를 보고 되살아나 카운터를 같이 올린다.
 * 1회차에 유휴 바닥이 **287.8/s**(144 의 두 배)로 찍힌 자리가 그것이다 — 바닥이 두 배면 P5 가
 * 거짓말을 한다.
 */
const rafStart = (app) =>
  app.send({
    cmd: 'eval',
    code: `(() => {
      const gen = (window.__l373rafGen ?? 0) + 1
      window.__l373rafGen = gen
      window.__l373raf = { n: 0, t0: performance.now(), gen }
      const tick = () => {
        if (window.__l373rafGen !== gen) return
        window.__l373raf.n += 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      return gen
    })()`,
  })
const rafRead = async (app) =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const r = window.__l373raf
        if (!r) return null
        window.__l373rafGen = (window.__l373rafGen ?? 0) + 1
        const ms = performance.now() - r.t0
        return { n: r.n, ms: Math.round(ms), perSec: +(r.n / (ms / 1000)).toFixed(2), gen: r.gen }
      })()`,
    })
  ).result
const passStart = (app) =>
  app.send({
    cmd: 'eval',
    code: `(() => {
      for (const mo of window.__l373mo ?? []) mo.disconnect()
      window.__l373mo = []
      window.__l373pass = {}
      for (const box of document.querySelectorAll('[data-term-pane-box]')) {
        const id = box.dataset.termPaneBox
        const rows = box.querySelector('.xterm-rows')
        if (rows === null) continue
        window.__l373pass[id] = { 콜백: 0, 변이: 0 }
        const mo = new MutationObserver((records) => {
          window.__l373pass[id].콜백 += 1
          window.__l373pass[id].변이 += records.length
        })
        mo.observe(rows, { childList: true, subtree: true, characterData: true })
        window.__l373mo.push(mo)
      }
      return Object.keys(window.__l373pass).length
    })()`,
  })
const passRead = async (app) =>
  (await app.send({ cmd: 'eval', code: `(() => { for (const mo of window.__l373mo ?? []) mo.disconnect(); return window.__l373pass ?? null })()` })).result

const paneWrites = async (app) =>
  (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result
const grids = async (app) => new Map(((await paneWrites(app)) ?? []).map((row) => [row.paneId, { cols: row.cols, rows: row.rows }]))

async function idleFloor(app, label) {
  await rafStart(app)
  await sleep(IDLE_MS)
  const row = await rafRead(app)
  console.log('  유휴 바닥', label, JSON.stringify(row))
  return row
}

const startLoad = (paneIds, gridMap, hz) => {
  paneIds.forEach((paneId, index) => {
    const grid = gridMap.get(paneId)
    if (grid === undefined) throw new Error(`격자를 모르는 pane 에 부하를 못 건다: ${paneId}`)
    execFileSync('herdr', [
      '--session',
      SESSION,
      'pane',
      'run',
      paneId,
      `${process.execPath} ${path.join(APP_DIR, 'scripts/l373impl/load-heavy.mjs')} --cols ${grid.cols} --rows ${grid.rows}` +
        ` --hz ${hz} --secs ${LOAD_SECS} --every ${HEAVY_EVERY} --tag p${index + 1}`,
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

/** 한 점 — pane 들을 hz 로 때리고 창 하나를 잰다. */
async function 한점(app, paneIds, hz) {
  console.log(`\n## ${paneIds.length} pane · ${hz} Hz`)
  const floorBefore = await idleFloor(app, '전')
  const gridMap = await grids(app)
  startLoad(paneIds, gridMap, hz)
  await sleep(3500)
  // 관문 ② — **부하가 화면에 실제로 걸렸나**. 안 걸린 창을 통과로 올리지 않는다.
  const 부하확인 = paneIds.map((paneId) => {
    const text = paneRead(paneId, 4)
    return { paneId, 격자: gridMap.get(paneId) ?? null, 걸렸나: /[▏▎▍▌▋▊▉█░▒▓]/.test(text), 맛보기: text.slice(0, 60) }
  })
  const cpuBefore = psSample(rendererPid())
  const countersBefore = (await app.send({ cmd: 'counters' })).counters
  await passStart(app)
  await rafStart(app)
  const t0 = Date.now()
  const seen = new Map()
  while (Date.now() - t0 < WINDOW_MS) {
    await sleep(3000)
    for (const row of (await paneWrites(app)) ?? []) for (const w of row.writes) seen.set(`${row.paneId}:${w.seq}:${w.at}`, w)
  }
  const t1 = Date.now()
  const raf = await rafRead(app)
  const passes = await passRead(app)
  const countersAfter = (await app.send({ cmd: 'counters' })).counters
  const cpuAfter = psSample(rendererPid())
  for (const row of (await paneWrites(app)) ?? []) for (const w of row.writes) seen.set(`${row.paneId}:${w.seq}:${w.at}`, w)
  stopLoad(paneIds)
  await sleep(2000)
  const floorAfter = await idleFloor(app, '후')

  const inWindow = [...seen.values()].filter((w) => w.at >= t0 && w.at <= t1)
  const secs = (t1 - t0) / 1000
  const 합 = (rows, key) => rows.reduce((sum, item) => sum + (item[key] ?? 0), 0)
  const 서피스 = 합(countersAfter, 'surfaces') - 합(countersBefore, 'surfaces')
  const 후보 = 합(countersAfter, 'candidates') - 합(countersBefore, 'candidates')
  const 건너뜀 = 합(countersAfter, 'skipped') - 합(countersBefore, 'skipped')
  const perPane = paneIds.map((paneId) => {
    const mine = inWindow.filter((w) => w.paneId === paneId)
    const 바이트 = mine.map((w) => w.bytes ?? 0)
    const 셀 = mine.length === 0 ? null : (mine.at(-1).cols ?? 0) * (mine.at(-1).rows ?? 0)
    const 평균바이트 = mine.length === 0 ? null : Math.round(바이트.reduce((a, b) => a + b, 0) / mine.length)
    return {
      paneId,
      쓰기수: mine.length,
      쓰기_초당: +(mine.length / secs).toFixed(2),
      DOM패스_초당: passes?.[paneId] === undefined ? null : +(passes[paneId].콜백 / secs).toFixed(2),
      격자: mine.length === 0 ? null : `${mine.at(-1).cols}x${mine.at(-1).rows}`,
      셀: 셀,
      평균바이트,
      셀당바이트: 평균바이트 === null || 셀 === null || 셀 === 0 ? null : +(평균바이트 / 셀).toFixed(2),
      write_p95: pct(mine.map((w) => w.ms), 95),
    }
  })
  const 총쓰기 = perPane.reduce((a, p) => a + p.쓰기수, 0)
  const 총셀 = perPane.reduce((a, p) => a + p.쓰기수 * (p.셀 ?? 0), 0)
  const 총바이트 = perPane.reduce((a, p) => a + p.쓰기수 * (p.평균바이트 ?? 0), 0)
  const cpuPct =
    cpuBefore === null || cpuAfter === null || cpuBefore.cpuSec === null || cpuAfter.cpuSec === null
      ? null
      : +(((cpuAfter.cpuSec - cpuBefore.cpuSec) / ((cpuAfter.at - cpuBefore.at) / 1000)) * 100).toFixed(1)
  const floor = floorBefore === null || floorAfter === null ? null : Math.min(floorBefore.perSec, floorAfter.perSec)
  const ratio = floor === null || raf === null || floor === 0 ? null : +(raf.perSec / floor).toFixed(3)
  const p95 = pct(inWindow.map((w) => w.ms), 95)
  const row = {
    hz,
    pane수: paneIds.length,
    부하확인,
    부하걸렸나: 부하확인.every((r) => r.걸렸나),
    창초: +secs.toFixed(2),
    축: {
      총프레임_초당: +(총쓰기 / secs).toFixed(2),
      총셀_초당: Math.round(총셀 / secs),
      KB_초당: +(총바이트 / secs / 1024).toFixed(1),
    },
    서피스: { 수: 서피스, 초당: +(서피스 / secs).toFixed(2), 후보, 건너뜀, skip비율: 후보 === 0 ? null : +(건너뜀 / 후보).toFixed(4) },
    흘림: { 본체가보낸: 후보 - 건너뜀, 렌더러가쓴: 총쓰기, 도달비율: 후보 - 건너뜀 === 0 ? null : +(총쓰기 / (후보 - 건너뜀)).toFixed(4) },
    렌더러CPU: cpuPct,
    write_p95: p95,
    rAF: raf?.perSec ?? null,
    유휴바닥: floor,
    P5비율: ratio,
    pane별: perPane,
    판정: {
      P3: cpuPct === null ? '못 쟀다' : cpuPct <= P3_LINE ? '통과' : '미달',
      P4: p95 === null ? '못 쟀다' : p95 <= P4_LINE ? '통과' : '미달',
      P5: ratio === null ? '못 쟀다' : ratio >= 0.73 ? '통과' : ratio >= 0.68 ? '보류' : '미달',
    },
  }
  console.log(
    `  ${hz}Hz | 부하 ${row.부하걸렸나} | 프레임/s ${row.축.총프레임_초당} · 셀/s ${row.축.총셀_초당} · KB/s ${row.축.KB_초당}` +
      ` | CPU ${cpuPct} | p95 ${p95} | rAF ${raf?.perSec}/${floor} = ${ratio} | skip ${row.서피스.skip비율} | 도달 ${row.흘림.도달비율}`,
  )
  결과.훑기.push(row)
  return row
}

// --- 준비 — 4 pane 을 **고르게** 나눈다 (2×2) ------------------------------------------
ensureWorkspace()
결과.초기화 = await resetPanes()
const app = await startApp({ name: 'p-limit', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await app.send({ cmd: 'resize-window', width: WIN_W, height: WIN_H })
await sleep(1500)
await quiesce(app)

const 화면pane들 = async () =>
  (await app.send({ cmd: 'eval', code: `(() => [...document.querySelectorAll('[data-term-pane-box]')].map((el) => el.dataset.termPaneBox))()` })).result
/** pane 상자와 그 크기 — 다음에 **어느 pane 을 쪼갤지**는 DOM 순서가 아니라 넓이로 고른다. */
const 상자들 = async () =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => [...document.querySelectorAll('[data-term-pane-box]')].map((el) => {
        const r = el.getBoundingClientRect()
        return { paneId: el.dataset.termPaneBox, w: Math.round(r.width), h: Math.round(r.height), 넓이: Math.round(r.width * r.height) }
      }))()`,
    })
  ).result

// **누르는 것으로 pane 을 고르지 않는다.** 1·2회차에서 클릭이 선택을 안 옮겨(선택은 mousedown
// 핸들러인데 가려짐 판정에 걸리면 아예 안 누른다) 왼쪽만 계속 쪼개져 15/14/30/63 이 나왔다.
// 분할은 **선택을 옮기지 않는다**(App.tsx `splitPaneAt` — 일부러 그렇다). 1·2회차가 여기서
// 왼쪽만 세 번 쪼개 15/14/30/63 이 나왔다. 선택을 옮기는 것은 `⌘⌥←→`(인접 pane 포커스) 뿐이다.
await press(app, { key: 'd' }) // 좌우
await sleep(2400)
await press(app, { key: 'ArrowRight', alt: true }) // 오른쪽 pane 을 고른다
await sleep(1200)
await press(app, { key: 'd', shift: true }) // 오른쪽을 위아래로
await sleep(2400)
await press(app, { key: 'ArrowLeft', alt: true }) // 왼쪽으로 돌아온다
await sleep(1200)
await press(app, { key: 'd', shift: true }) // 왼쪽을 위아래로
await sleep(2400)
await quiesce(app)
결과.분할 = await 상자들()
console.log('# 분할', JSON.stringify(결과.분할))

const 선택 = (await app.send({ cmd: 'eval', code: `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()` }))
  .result
const tabId = paneList().find((p) => p.pane_id === 선택)?.tab_id ?? null
const 네pane = paneList()
  .filter((p) => p.tab_id === tabId)
  .map((p) => p.pane_id)
const 격자들 = await grids(app)
결과.준비 = {
  tabId,
  paneIds: 네pane,
  격자: 네pane.map((id) => ({ paneId: id, ...(격자들.get(id) ?? {}) })),
  격자가_판정점인가: 네pane.every((id) => {
    const g = 격자들.get(id)
    if (g === undefined) return false
    return (
      Math.abs(g.cols - 목표.cols) <= 목표.cols * 목표.여유 && Math.abs(g.rows - 목표.rows) <= 목표.rows * 목표.여유
    )
  }),
}
console.log('# 준비', JSON.stringify(결과.준비))

// --- 훑기 — 4 pane 을 hz 별로 ----------------------------------------------------------
for (const hz of HZ_LIST) await 한점(app, 네pane, hz)

// --- 1 · 2 pane 병기 (판정점 hz 에서만) -------------------------------------------------
const 판정hz = HZ_LIST.at(-1)
결과.병기 = {}
{
  // pane 을 하나씩 닫아 2 pane · 1 pane 을 만든다 (격자는 바뀐다 — 그대로 기록한다).
  await app.click(`[data-term-pane-box="${네pane[0]}"]`)
  await sleep(600)
  const groupId = (await app.send({ cmd: 'eval', code: `(() => document.querySelector('.tab-group.is-active-group')?.dataset.tabGroup ?? null)()` }))
    .result
  for (const 남길 of [2, 1]) {
    while ((await 화면pane들()).length > 남길) {
      await app.click(`[data-group-close-pane="${groupId}"]`)
      await sleep(2000)
    }
    await quiesce(app)
    const 살아있는 = paneList()
      .filter((p) => p.tab_id === tabId)
      .map((p) => p.pane_id)
    결과.병기[`${남길} pane`] = await 한점(app, 살아있는, 판정hz)
  }
}

// --- 처음 넘는 지점 --------------------------------------------------------------------
// **4 pane 훑기만** 본다. `한점` 이 병기(2 pane·1 pane)도 같은 `훑기` 에 밀어 넣어서, 거르지
// 않으면 "P4 를 처음 넘는 점"이 pane 수가 다른 행을 집는다 — 축(hz)이 같은 곡선이 아니다.
// 첫 커밋(`873e67b`)의 `p-limit.json` 한계 블록이 그렇게 2 pane 행을 집었다.
const 유효 = 결과.훑기.filter((row) => row.부하걸렸나 && row.pane수 === 4)
const 첫돌파 = (값뽑기, 넘었나) => {
  const row = 유효.find(넘었나)
  return row === undefined ? null : { hz: row.hz, pane수: row.pane수, ...row.축, 값: 값뽑기(row) }
}
결과.한계 = {
  '훑은축': '4 pane 고정 · hz 오름차순',
  'P3 70% 를 처음 넘는 점': 첫돌파((row) => row.렌더러CPU, (row) => row.렌더러CPU !== null && row.렌더러CPU > P3_LINE),
  'P4 25ms 를 처음 넘는 점': 첫돌파((row) => row.write_p95, (row) => row.write_p95 !== null && row.write_p95 > P4_LINE),
  'P5 0.70 아래로 처음 떨어지는 점': 첫돌파((row) => row.P5비율, (row) => row.P5비율 !== null && row.P5비율 < P5_RATIO),
  'P2-a 도달 0.99 아래로 처음 떨어지는 점': 첫돌파((row) => row.흘림.도달비율, (row) => row.흘림.도달비율 !== null && row.흘림.도달비율 < 0.99),
}
console.log('\n한계', JSON.stringify(결과.한계, null, 1))

await app.stop()
await sleep(1500)
결과.M0_끝 = m0End()
writeRaw('p-limit.json', 결과)
console.log('wrote raw/claude/p-limit.json')
