// §4 성능 P2~P5 + §7-3 (LIFE-373 · §10-R2·R10·R11·R26-3).
//
//   P2 pane 당 렌더 패스/s ≥ **26.85** (0.98 × F=27.4, R10) — 포화 부하 · 크롭 skip 켠 채
//   P3 렌더러 CPU ≤ **70%**
//   P4 `term.write` 호출→콜백 p95 ≤ **25ms** (1차 스파이크 M2 와 같은 정의)
//   P5 rAF/s ≥ **0.70 × 유휴 바닥값**, 68~73% 는 **보류** (R11). 바닥값은 **각 런 앞뒤로** 잰다
//   §7-3 창 크기 변화의 발사 빈도(분모) vs herdr 로 나간 `client.resize` 수
//
// **무엇으로 재나**
//   · 렌더 패스·write 지연 → 앱의 계측 프로브 `window.corralPaneWrites()` (진단 실행에서만 붙는다).
//     pane 마다 따로 센다 — 하나만 보면 나머지 셋이 굶고 있어도 통과한다
//   · rAF → 렌더러에 심는 카운터(하네스가 eval 로 설치, 앱 무수정)
//   · CPU → **렌더러 프로세스**의 누적 CPU 시간 차 / 벽시계. `ps` 의 %CPU 순간값이 아니다
//   · 부하 성립·pane 구성 → **제3 오라클**(control 소켓). 재는 대상의 말로 판정하지 않는다
//
// **R27 뒤 달라진 것** (코디네이터 재정 2026-09-16)
//   · 분모 F 를 **이 런에서** 잰다 — 앱 연결이 받은 서피스 수(`counters.surfaces`). 별도 연결로
//     잰 27.4/s 는 그 관측자의 소화 속도였다 (`f-observer.json`, §15)
//   · **렌더 패스**를 1차 스파이크와 **같은 오라클**로도 센다 — `MutationObserver(.xterm-rows)`.
//     쓰기 수(`term.write` 완료)와 DOM 패스는 포화에서 크게 갈린다(스파이크: 5232 vs 60.7)
//   · **프레임 무게**를 싣는다 — 바이트·격자·셀당 바이트 (R27-a). `L373_LOAD=heavy` 면
//     `load-heavy.mjs` 로 1차와 같은 급(100×30 전체 리페인트)으로 때린다 (R27-b)
//
// 비교: `1 · 2 · 4 pane` 을 같은 런에서 순서대로. 기본 케이스는 **4 pane**이다.
// 격리: `life373-` 세션 전용. M0(내 유령) · M0-b(종료 후) · M0-c(prefs) · M0-d(형제 worktree).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, press, quiesce, resizeEvents } from './app-steps.mjs'
import { APP_DIR, ensureWorkspace, layout as herdrLayout, m0End, m0Start, paneList, pct, psSample, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-p-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
/** 포화 부하 — 서버 push 천장(F≈27.4/s)을 넘겨 때린다. 1차 스파이크의 `saturate` 와 같은 결. */
const LOAD_HZ = Number(process.env.L373_LOAD_HZ ?? 60)
const LOAD_SECS = 180
/** `light`(기본) = `load.sh` 40×20 박스 · `heavy` = `load-heavy.mjs` pane 격자 전체 리페인트. */
const LOAD_KIND = process.env.L373_LOAD ?? 'light'
/** heavy 는 색이 몇 칸마다 바뀌나로 무게를 맞춘다 (셀당 바이트가 여기서 정해진다). */
const HEAVY_EVERY = Number(process.env.L373_HEAVY_EVERY ?? 2)
const HEAVY_HZ = Number(process.env.L373_HEAVY_HZ ?? 30)
const OUT_NAME = process.env.L373_OUT ?? (LOAD_KIND === 'heavy' ? 'p-series-heavy.json' : 'p-series.json')
const WINDOW_MS = Number(process.env.L373_WINDOW_MS ?? 20000)
const IDLE_MS = 6000
const P2_LINE = 26.85
const P3_LINE = 70
const P4_LINE = 25
const P5_RATIO = 0.7
/** 셸을 멈추는 바이트 (`Ctrl-C`). `send-keys` 는 이 이름을 모른다 — 글자로 보낸다. */
const ETX = '\u0003'

const 결과 = {
  at: new Date().toISOString(),
  세션: SESSION,
  통과선: { P2: P2_LINE, P3: P3_LINE, P4: P4_LINE, P5: `${P5_RATIO} × 유휴 바닥`, 보류밴드: '0.68~0.73' },
  부하: {
    종류: LOAD_KIND,
    hz: LOAD_KIND === 'heavy' ? HEAVY_HZ : LOAD_HZ,
    창ms: WINDOW_MS,
    스크립트: LOAD_KIND === 'heavy' ? 'scripts/l373impl/load-heavy.mjs' : 'scripts/l373impl/load.sh',
    heavy: LOAD_KIND === 'heavy' ? { every: HEAVY_EVERY } : null,
  },
  M0,
  단계: [],
}

/** 렌더러 프로세스 pid — Electron 은 프로세스가 여럿이다. `--type=renderer` 만 고른다. */
function rendererPid() {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const mine = path.join(APP_DIR, 'node_modules')
  const rows = out
    .split('\n')
    .filter((line) => line.includes(mine) && line.includes('--type=renderer'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
  return rows[0] ?? null
}

const rafStart = (app) =>
  app.send({
    cmd: 'eval',
    code: `(() => {
      window.__l373raf = { n: 0, t0: performance.now(), stop: false }
      const tick = () => { if (window.__l373raf.stop) return; window.__l373raf.n += 1; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      return 1
    })()`,
  })
const rafRead = async (app) =>
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const r = window.__l373raf
        if (!r) return null
        r.stop = true
        const ms = performance.now() - r.t0
        return { n: r.n, ms: Math.round(ms), perSec: +(r.n / (ms / 1000)).toFixed(2) }
      })()`,
    })
  ).result

/** 유휴 rAF 바닥값 — 부하 **직전·직후** 둘 다 잰다 (R11). */
async function idleFloor(app, label) {
  await rafStart(app)
  await sleep(IDLE_MS)
  const row = await rafRead(app)
  console.log('  유휴 바닥', label, JSON.stringify(row))
  return row
}

/**
 * **렌더 패스** — 1차 스파이크가 쓴 오라클 그대로(`MutationObserver(.xterm-rows)`).
 *
 * 쓰기 수(`term.write` 완료)와 같지 않다: 스파이크는 포화에서 초당 5232 장을 써 넣고도 DOM
 * 패스는 60.7 이었다. 두 수를 나란히 싣는다 — P2 가 무엇을 재는 항목인지는 코디네이터가 정한다.
 */
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
  (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        for (const mo of window.__l373mo ?? []) mo.disconnect()
        return window.__l373pass ?? null
      })()`,
    })
  ).result

const paneWrites = async (app) =>
  (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result

/** pane 마다 **앱이 실제로 쓰고 있는 격자** — heavy 부하가 그 크기로 칠한다 (R27-b). */
const grids = async (app) => new Map(((await paneWrites(app)) ?? []).map((row) => [row.paneId, { cols: row.cols, rows: row.rows }]))

/**
 * 부하를 건다 — **제3 오라클**로 각 pane 셸에 직접 명령을 넣는다 (화면을 거치지 않는다).
 *
 * heavy 는 **그 pane 의 격자**를 통째로 다시 칠한다. 격자는 앱이 실제로 쓰고 있는 값(쓰기 링의
 * `cols`·`rows`)에서 받는다 — 짐작한 크기로 칠하면 herdr 가 잘라내거나 줄바꿈해서 무게가 어긋난다.
 */
function startLoad(paneIds, grids) {
  paneIds.forEach((paneId, index) => {
    const grid = grids?.get(paneId) ?? null
    const command =
      LOAD_KIND === 'heavy' && grid !== null
        ? `${process.execPath} ${path.join(APP_DIR, 'scripts/l373impl/load-heavy.mjs')} --cols ${grid.cols} --rows ${grid.rows}` +
          ` --hz ${HEAVY_HZ} --secs ${LOAD_SECS} --every ${HEAVY_EVERY} --tag p${index + 1}`
        : `bash ${path.join(APP_DIR, 'scripts/l373impl/load.sh')} ${LOAD_HZ} ${LOAD_SECS} p${index + 1}`
    execFileSync('herdr', ['--session', SESSION, 'pane', 'run', paneId, command])
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

/**
 * 한 단계 — pane N 개를 포화로 때리고 창 하나를 잰다.
 * 쓰기 기록은 **폴링해서 합친다**: 앱의 링이 pane 당 400개라 20초 창을 한 번에 못 담는다.
 */
async function phase(app, label, paneIds) {
  console.log('\n##', label, paneIds.join(' '))
  const floorBefore = await idleFloor(app, '부하 전')
  startLoad(paneIds, await grids(app))
  await sleep(4000) // 부하가 실제로 흐르기 시작할 때까지 (판정 창 밖)
  const cpuBefore = psSample(rendererPid())
  const mainBefore = (await app.send({ cmd: 'cpu' })).cpu
  const countersBefore = (await app.send({ cmd: 'counters' })).counters
  await passStart(app)
  await rafStart(app)
  const t0 = Date.now()
  const seen = new Map() // `${paneId}:${seq}:${at}` → record
  const polls = []
  while (Date.now() - t0 < WINDOW_MS) {
    await sleep(4000)
    const rows = await paneWrites(app)
    polls.push({ at: Date.now(), pane수: rows === null ? null : rows.length })
    for (const row of rows ?? []) for (const w of row.writes) seen.set(`${row.paneId}:${w.seq}:${w.at}`, w)
  }
  const t1 = Date.now()
  const raf = await rafRead(app)
  const passes = await passRead(app)
  const countersAfter = (await app.send({ cmd: 'counters' })).counters
  const cpuAfter = psSample(rendererPid())
  const mainAfter = (await app.send({ cmd: 'cpu' })).cpu
  const last = await paneWrites(app)
  for (const row of last ?? []) for (const w of row.writes) seen.set(`${row.paneId}:${w.seq}:${w.at}`, w)
  stopLoad(paneIds)
  await sleep(2500)
  const floorAfter = await idleFloor(app, '부하 후')

  // 창 **안에서** 완료된 쓰기만 센다 (폴링이 창 밖 기록도 데려온다).
  const inWindow = [...seen.values()].filter((w) => w.at >= t0 && w.at <= t1)
  const secs = (t1 - t0) / 1000
  const perPane = paneIds.map((paneId) => {
    const mine = inWindow.filter((w) => w.paneId === paneId)
    const 바이트 = mine.map((w) => w.bytes ?? 0)
    const 셀 = mine.length === 0 ? null : (mine.at(-1).cols ?? 0) * (mine.at(-1).rows ?? 0)
    const 평균바이트 = mine.length === 0 ? null : Math.round(바이트.reduce((a, b) => a + b, 0) / mine.length)
    return {
      paneId,
      쓰기수: mine.length,
      쓰기_초당: +(mine.length / secs).toFixed(2),
      // 1차 스파이크의 "pane 당 렌더 패스"와 같은 오라클 (DOM). 위 쓰기 수와 다를 수 있다.
      DOM패스_초당: passes?.[paneId] === undefined ? null : +(passes[paneId].콜백 / secs).toFixed(2),
      DOM변이_초당: passes?.[paneId] === undefined ? null : +(passes[paneId].변이 / secs).toFixed(2),
      격자: mine.length === 0 ? null : `${mine.at(-1).cols}x${mine.at(-1).rows}`,
      프레임바이트: { 평균: 평균바이트, p50: pct(바이트, 50), p95: pct(바이트, 95), max: 바이트.length === 0 ? null : Math.max(...바이트) },
      셀당바이트: 평균바이트 === null || 셀 === null || 셀 === 0 ? null : +(평균바이트 / 셀).toFixed(2),
      write_p50: pct(mine.map((w) => w.ms), 50),
      write_p95: pct(mine.map((w) => w.ms), 95),
      write_max: mine.length === 0 ? null : Math.max(...mine.map((w) => w.ms)),
    }
  })
  const cpuPct =
    cpuBefore === null || cpuAfter === null || cpuBefore.cpuSec === null || cpuAfter.cpuSec === null
      ? null
      : +(((cpuAfter.cpuSec - cpuBefore.cpuSec) / ((cpuAfter.at - cpuBefore.at) / 1000)) * 100).toFixed(1)
  const mainPct = +(((mainAfter.user + mainAfter.system - (mainBefore.user + mainBefore.system)) / 1000 / (t1 - t0)) * 100).toFixed(1)
  const floor = floorBefore === null || floorAfter === null ? null : Math.min(floorBefore.perSec, floorAfter.perSec)
  const ratio = floor === null || raf === null || floor === 0 ? null : +(raf.perSec / floor).toFixed(3)
  const drift =
    floorBefore === null || floorAfter === null
      ? null
      : +(Math.abs(floorBefore.perSec - floorAfter.perSec) / Math.max(floorBefore.perSec, floorAfter.perSec)).toFixed(3)
  const 합 = (rows, key) => rows.reduce((sum, item) => sum + (item[key] ?? 0), 0)
  const 서피스 = 합(countersAfter, 'surfaces') - 합(countersBefore, 'surfaces')
  const 후보 = 합(countersAfter, 'candidates') - 합(countersBefore, 'candidates')
  const 건너뜀 = 합(countersAfter, 'skipped') - 합(countersBefore, 'skipped')
  const row = {
    label,
    pane수: paneIds.length,
    paneIds,
    창: { t0, t1, 초: +secs.toFixed(2) },
    // **같은 런의 분모** (R27-1). 별도 연결로 잰 F 는 부하의 박자를 같이 잰다 — §15 참고.
    서피스: {
      수: 서피스,
      초당: +(서피스 / secs).toFixed(2),
      후보: 후보,
      건너뜀: 건너뜀,
      쓴프레임: 후보 - 건너뜀,
      쓴비율_후보대비: 후보 === 0 ? null : +((후보 - 건너뜀) / 후보).toFixed(4),
      pane당쓰기_서피스대비: 서피스 === 0 ? null : +((후보 - 건너뜀) / paneIds.length / 서피스).toFixed(4),
    },
    유휴바닥: { 전: floorBefore, 후: floorAfter, 쓴값: floor, 변동률: drift },
    rAF: raf,
    P5_비율: ratio,
    렌더러CPU: { 전: cpuBefore, 후: cpuAfter, 퍼센트: cpuPct },
    mainCPU퍼센트: mainPct,
    pane별: perPane,
    write_p50_전체: pct(inWindow.map((w) => w.ms), 50),
    write_p95_전체: pct(inWindow.map((w) => w.ms), 95),
    폴링: polls,
    오라클: { pane수: paneList().length, focused: herdrLayout().focused_pane_id },
  }
  row.판정 = {
    // P2 의 분모(F=27.4)가 R27-1 로 깨졌다 — 얼어 있는 통과선을 혼자 고치지 않는다.
    // 옛 통과선 그대로의 값과, 같은 런 분모로 읽은 두 비율을 **나란히** 싣는다. 판단은 코디네이터.
    P2_옛통과선_26_85: perPane.length === 0 ? '못 쟀다' : perPane.every((p) => p.쓰기_초당 >= P2_LINE) ? '통과' : '미달',
    P2_같은런_서피스대비: row.서피스.pane당쓰기_서피스대비,
    P2_후보대비_안흘렸나: row.서피스.쓴비율_후보대비,
    P3: cpuPct === null ? '못 쟀다' : cpuPct <= P3_LINE ? '통과' : '미달',
    P4: row.write_p95_전체 === null ? '못 쟀다' : row.write_p95_전체 <= P4_LINE ? '통과' : '미달',
    P5: ratio === null ? '못 쟀다' : ratio >= 0.73 ? '통과' : ratio >= 0.68 ? '보류' : '미달',
    바닥변동10퍼센트초과: drift !== null && drift > 0.1,
  }
  console.log(' ', label, JSON.stringify(row.판정), 'rAF', raf?.perSec, '바닥', floor, 'CPU', cpuPct)
  console.log('  서피스', JSON.stringify(row.서피스))
  console.log('  pane별', JSON.stringify(perPane))
  결과.단계.push(row)
  return row
}

ensureWorkspace()
결과.초기화 = await resetPanes()
const app = await startApp({ name: 'p-series', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
// heavy 는 **1차 스파이크와 같은 격자**(pane 당 100×30 급)를 만들어야 한다 — 기본 창으로 4분할하면
// pane 이 60×20 언저리라 같은 자리에서 못 비교한다. 창을 키워 pane 을 키운다 (실제 격자는 기록한다).
if (LOAD_KIND === 'heavy') {
  await app.send({ cmd: 'resize-window', width: 2000, height: 1250 })
  await sleep(1200)
}
await sleep(800)
await quiesce(app)
결과.rendererPid = rendererPid()

/** 화면이 보고 있는 탭의 pane 들 — 부하를 걸 대상이다 (제3 오라클로 id 를 받는다). */
const panesOfActiveTab = async () => {
  const selected = (
    await app.send({ cmd: 'eval', code: `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()` })
  ).result
  const tabId = paneList().find((p) => p.pane_id === selected)?.tab_id ?? null
  return paneList()
    .filter((p) => p.tab_id === tabId)
    .map((p) => p.pane_id)
}

// --- 1 pane -------------------------------------------------------------------------
결과.전제 = { 활성탭pane: await panesOfActiveTab(), 오라클pane수: paneList().length }
await phase(app, '1 pane', await panesOfActiveTab())

// --- 2 pane -------------------------------------------------------------------------
await press(app, { key: 'd' })
await sleep(2500)
await quiesce(app)
await phase(app, '2 pane', await panesOfActiveTab())

// --- 4 pane (기본 케이스) ------------------------------------------------------------
await press(app, { key: 'd', shift: true })
await sleep(2500)
await press(app, { key: 'd' })
await sleep(2500)
await quiesce(app)
결과.기본케이스 = await phase(app, '4 pane (기본)', await panesOfActiveTab())

// --- §7-3 창 크기 변화 발사 빈도 (S3 의 분모) -----------------------------------------
//
// 진짜 OS 창 드래그는 못 만든다(R24-1 과 같은 벽). **같은 모양의 사건 흐름**을 만든다:
// 창 크기를 60번 연속 바꾸고 ⓐ 렌더러가 본 `resize` 이벤트 ⓑ herdr 로 나간 `client.resize`
// 를 센다. 디바운스가 없으면 ⓑ == ⓐ 여야 하고, 우리 구현은 연결당 1회로 뭉쳐야 한다.
{
  await app.send({
    cmd: 'eval',
    code: `(() => { window.__l373resize = 0; window.addEventListener('resize', () => { window.__l373resize += 1 }); return 1 })()`,
  })
  const since = Date.now()
  for (let i = 0; i < 60; i++) {
    await app.send({ cmd: 'resize-window', width: 1200 + (i % 2 === 0 ? i * 3 : -i * 2), height: 800 + (i % 3) * 4 })
    await sleep(16)
  }
  await sleep(2500)
  const rendererSaw = (await app.send({ cmd: 'eval', code: '(() => window.__l373resize ?? null)()' })).result
  const sent = resizeEvents(app, since)
  결과.드래그분모 = {
    보낸크기변경: 60,
    간격ms: 16,
    렌더러가본resize: rendererSaw,
    herdr로나간_client_resize: sent.length,
    뭉침비율: sent.length === 0 ? null : +(rendererSaw / sent.length).toFixed(2),
    비고: '진짜 OS 드래그가 아니라 같은 모양의 사건 흐름이다 (창을 16ms 간격으로 60번 바꿨다)',
  }
  console.log('\n§7-3', JSON.stringify(결과.드래그분모))
}

결과.끝오라클 = { pane수: paneList().length }
await app.stop()
await sleep(1500)
결과.M0_끝 = m0End()
writeRaw(OUT_NAME, 결과)
console.log('\nP 요약')
for (const row of 결과.단계)
  if (row.판정)
    console.log(' ', row.label, JSON.stringify(row.판정), '| rAF', row.rAF?.perSec, '/ 바닥', row.유휴바닥?.쓴값, '| CPU', row.렌더러CPU?.퍼센트, '| p95', row.write_p95_전체)
