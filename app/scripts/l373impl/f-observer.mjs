// R27-1 — "pane 당 렌더 49~52/s 인데 F 는 27.4/s" 모순을 가른다.
//
// 세 명이 **같은 부하를 같은 순간에** 본다:
//   ⓐ 앱 자신   — 연결이 받은 서피스 수 (`counters.surfaces`, 이 커밋에서 추가)
//   ⓑ cheap 관측자 — 별도 프로세스, 도착 시각만 찍는다
//   ⓒ heavy 관측자 — 별도 프로세스, `m1-frame-rate.mjs` 와 **같은** 크롭 해시를 판마다 돈다
//
// 가설: F=27.4 는 **서버 천장이 아니라 관측자의 소화 속도**였다. herdr 는 연결마다 따로 밀고
// 느린 소비자에게는 뭉쳐서 준다. m1 의 간격 분포(p50 18ms · p95 ~100ms)가 이미 그 모양이다 —
// 균일한 36ms(=27.4/s) 가 아니라 **버스트 + 스톨**이다.
//
// 판정: ⓐ ≈ ⓑ ≫ ⓒ 이면 F=27.4 는 관측자 산물이다(R27-1 의 2번). ⓐ ≈ ⓒ 면 앱의 카운터가
// 틀렸거나 부하가 실물 경로를 안 탄 것이다(1번).
//
// 격리: `life373-` 세션 전용. M0(내 유령) · M0-b(종료 후) · M0-c(prefs).

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, press, quiesce } from './app-steps.mjs'
import { APP_DIR, ensureWorkspace, m0End, m0Start, paneList, paneRead, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-fobs-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const LOAD_HZ = Number(process.env.L373_LOAD_HZ ?? 60)
const LOAD_SECS = 120
const LOAD_KIND = process.env.L373_LOAD ?? 'light'
const HEAVY_EVERY = Number(process.env.L373_HEAVY_EVERY ?? 2)
const HEAVY_RICH = String(process.env.L373_HEAVY_RICH ?? '0')
/**
 * `L373_GEOM=judgment` 면 **§14 판정점과 같은 자리**를 만든다 — 창 1950×1080 · 2×2 · 100×30.
 *
 * 왜 필요한가: P2-c 의 독립 오라클(별도 연결 크롭 해시)을 처음 잰 자리는 30 Hz · `d`/`D`/`d` 로
 * 만든 **고르지 않은** 4 pane 이었다. 통과선을 만든 쪽(코디네이터)이 **판정점 기하에서 한 번 더**
 * 확인하라고 해서, 여기에 p-limit 과 같은 2×2 시퀀스를 둔다. 분할은 선택을 안 옮기므로
 * `⌘⌥←→` 로 옮겨야 2×2 가 선다 (03-result §14-1).
 */
const GEOM = process.env.L373_GEOM ?? 'default'
const HEAVY_HZ = Number(process.env.L373_HEAVY_HZ ?? 30)
const WINDOW_MS = Number(process.env.L373_WINDOW_MS ?? 20000)
const ETX = '\u0003'
const OUT_NAME = process.env.L373_OUT ?? 'f-observer.json'

const 결과 = {
  at: new Date().toISOString(),
  세션: SESSION,
  M0,
  부하: { 종류: LOAD_KIND, hz: LOAD_KIND === 'heavy' ? HEAVY_HZ : LOAD_HZ, 창ms: WINDOW_MS, 기하: GEOM, heavy: LOAD_KIND === 'heavy' ? { every: HEAVY_EVERY, rich: HEAVY_RICH } : null },
}

/** `p-series.mjs` 와 **같은 부하**를 건다 — heavy 면 pane 격자 전체 리페인트(R27-b). */
const startLoad = (paneIds, grids) => {
  paneIds.forEach((paneId, index) => {
    const grid = grids?.get(paneId) ?? null
    const command =
      LOAD_KIND === 'heavy' && grid !== null
        ? `${process.execPath} ${path.join(APP_DIR, 'scripts/l373impl/load-heavy.mjs')} --cols ${grid.cols} --rows ${grid.rows}` +
          ` --hz ${HEAVY_HZ} --secs ${LOAD_SECS} --every ${HEAVY_EVERY}${HEAVY_RICH === '0' ? '' : ` --rich ${HEAVY_RICH}`} --tag p${index + 1}`
        : `bash ${path.join(APP_DIR, 'scripts/l373impl/load.sh')} ${LOAD_HZ} ${LOAD_SECS} p${index + 1}`
    execFileSync('herdr', ['--session', SESSION, 'pane', 'run', paneId, command])
  })
}
const grids = async (app) =>
  new Map(
    (
      (await app.send({ cmd: 'eval', code: '(() => window.corralPaneWrites ? window.corralPaneWrites() : null)()' })).result ?? []
    ).map((row) => [row.paneId, { cols: row.cols, rows: row.rows }]),
  )
const stopLoad = (paneIds) => {
  for (const paneId of paneIds) {
    try {
      execFileSync('herdr', ['--session', SESSION, 'pane', 'send-text', paneId, ETX])
    } catch {
      /* 이미 끝났으면 그만이다 */
    }
  }
}

/** 관측자 하나를 **프로세스로** 띄운다 — 둘이 같은 이벤트 루프를 쓰면 실험이 무너진다. */
const observe = (mode, paneId) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(APP_DIR, 'scripts/l373impl/observe-surfaces.mjs'), mode, paneId, String(WINDOW_MS)],
      { env: { ...process.env, L373_SESSION: SESSION }, maxBuffer: 1 << 24 },
      (error, stdout, stderr) => {
        if (error) return resolve({ mode, 오류: error.message, stderr: String(stderr).slice(-400) })
        try {
          resolve(JSON.parse(stdout.trim().split('\n').at(-1)))
        } catch (parseError) {
          resolve({ mode, 오류: String(parseError), stdout: stdout.slice(-400) })
        }
      },
    )
  })

결과.workspace = ensureWorkspace()
결과.초기화 = await resetPanes()
const app = await startApp({ name: 'f-observer', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
if (GEOM === 'judgment') {
  await app.send({ cmd: 'resize-window', width: 1950, height: 1080 })
  await sleep(1500)
} else if (LOAD_KIND === 'heavy') {
  await app.send({ cmd: 'resize-window', width: 2000, height: 1250 })
  await sleep(1200)
}
await sleep(800)
await quiesce(app)

if (GEOM === 'judgment') {
  // §14 판정점과 **같은 2×2** — 분할은 선택을 안 옮기므로 `⌘⌥←→` 로 옮긴다.
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
} else {
  // 4 pane — P 계열의 기본 케이스와 같은 모양으로 본다.
  await press(app, { key: 'd' })
  await sleep(2500)
  await press(app, { key: 'd', shift: true })
  await sleep(2500)
  await press(app, { key: 'd' })
  await sleep(2500)
  await quiesce(app)
}

const selected = (
  await app.send({ cmd: 'eval', code: `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()` })
).result
const tabId = paneList().find((p) => p.pane_id === selected)?.tab_id ?? null
const paneIds = paneList()
  .filter((p) => p.tab_id === tabId)
  .map((p) => p.pane_id)
결과.대상 = { tabId, paneIds, 선택: selected, 기하: GEOM }
결과.격자 = [...(await grids(app))].map(([paneId, g]) => ({ paneId, ...g }))
결과.격자가_판정점인가 =
  GEOM !== 'judgment'
    ? null
    : paneIds.length === 4 &&
      결과.격자.every((g) => Math.abs(g.cols - 100) <= 10 && Math.abs(g.rows - 30) <= 3)
console.log('# 격자', JSON.stringify({ 격자: 결과.격자, 판정점인가: 결과.격자가_판정점인가 }))
console.log('# 대상', JSON.stringify(결과.대상))

startLoad(paneIds, await grids(app))
await sleep(4000) // 부하가 실제로 흐를 때까지 (창 밖)

const before = (await app.send({ cmd: 'counters' })).counters
const t0 = Date.now()
const [cheap, heavy] = await Promise.all([observe('cheap', paneIds[0]), observe('heavy', paneIds[0])])
const t1 = Date.now()
const after = (await app.send({ cmd: 'counters' })).counters
/**
 * **부하가 화면에 걸렸는지는 끄기 전에 본다** (L12-b).
 *
 * 예전에는 `stopLoad()` 뒤에 읽어서, `^C` 로 프롬프트가 다시 그려지는 속도에 따라 같은 부하가
 * 어떤 회차는 4/4 · 어떤 회차는 2/4 로 찍혔다(원자료의 `맛보기` 에 `^C` 가 남아 있다).
 * 재는 것은 "부하가 돌았나"이지 "끈 뒤에도 글자가 남았나"가 아니다.
 */
결과.부하확인 = paneIds.map((paneId) => {
  const text = paneRead(paneId, 4)
  return { paneId, 걸렸나: LOAD_KIND === 'heavy' ? /[▏▎▍▌▋▊▉█░▒▓]/.test(text) : /[┌│└─]/.test(text), 맛보기: text.slice(0, 80) }
})
결과.부하걸렸나 = 결과.부하확인.every((row) => row.걸렸나)
stopLoad(paneIds)

const 초 = (t1 - t0) / 1000
const 합 = (rows, key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0)
결과.앱 = {
  전: before,
  뒤: after,
  창초: +초.toFixed(2),
  서피스: 합(after, 'surfaces') - 합(before, 'surfaces'),
  후보: 합(after, 'candidates') - 합(before, 'candidates'),
  건너뜀: 합(after, 'skipped') - 합(before, 'skipped'),
}
결과.앱.서피스초당 = +(결과.앱.서피스 / 초).toFixed(2)
결과.앱.쓴프레임초당 = +((결과.앱.후보 - 결과.앱.건너뜀) / 초).toFixed(2)
결과.앱.pane당쓴프레임초당 = +(결과.앱.쓴프레임초당 / paneIds.length).toFixed(2)
결과.앱.pane당쓰기_서피스대비 = 결과.앱.서피스초당 === 0 ? null : +(결과.앱.pane당쓴프레임초당 / 결과.앱.서피스초당).toFixed(4)
결과.cheap = cheap
결과.heavy = heavy
결과.P2c = {
  앱_pane당쓰기_서피스대비: 결과.앱.pane당쓰기_서피스대비 ?? null,
  관측자_프레임당바뀐pane비율: heavy.프레임당바뀐pane수 === null || heavy.프레임당바뀐pane수 === undefined ? null : +(heavy.프레임당바뀐pane수 / paneIds.length).toFixed(4),
}
결과.P2c.차 =
  결과.P2c.앱_pane당쓰기_서피스대비 === null || 결과.P2c.관측자_프레임당바뀐pane비율 === null
    ? null
    : +(결과.P2c.앱_pane당쓰기_서피스대비 - 결과.P2c.관측자_프레임당바뀐pane비율).toFixed(4)
/**
 * 판정 블록 — **이 회차가 무엇을 재는 회차인가에 맞춰 적는다** (L6).
 *
 * 예전에는 `부하hz` 에 `LOAD_HZ`(light 기본 60)를 그대로 싣고 `m1 이 적었던 F: 27.4`·§15 결론 문구를
 * 늘 붙였다. 그래서 P2-c 판정점 회차(heavy 15 Hz)의 원자료가 `부하: {hz 15}` 인데
 * `판정: {부하hz: 60}` 이었다 — §15-3 이 P2-c 근거로 인용하는 바로 그 파일이다.
 */
const 실제hz = LOAD_KIND === 'heavy' ? HEAVY_HZ : LOAD_HZ
결과.판정 = {
  'ⓐ 앱이 받은 서피스/s': 결과.앱.서피스초당,
  'ⓑ cheap 관측자/s': cheap.초당 ?? null,
  'ⓒ heavy 관측자/s (m1 과 같은 부담)': heavy.초당 ?? null,
  부하: { 종류: LOAD_KIND, 'pane당 hz': 실제hz, 기하: GEOM },
  ...(GEOM === 'judgment'
    ? { 재는것: 'P2-c 를 §14 판정점 기하에서 (R31-6)', 'P2-c 차': 결과.P2c.차, 통과선: '±0.02' }
    : {
        재는것: 'R27-1 — F 가 관측자 산물인가 (§15)',
        'm1 이 적었던 F': 27.4,
        결론:
          cheap.초당 !== undefined && heavy.초당 !== undefined && cheap.초당 > heavy.초당 * 1.4
            ? '관측자 부담으로 갈린다 — heavy 가 느려서 F 가 낮게 찍혔다'
            : '관측자 부담으로는 안 갈린다 — 두 관측자가 같은 수를 본다. 남은 변수는 **부하 자체**다',
      }),
}
console.log('\n판정', JSON.stringify(결과.판정, null, 1))

await app.stop()
await sleep(1500)
결과.M0_끝 = m0End()
writeRaw(OUT_NAME, 결과)
console.log('wrote raw/claude/' + OUT_NAME)
