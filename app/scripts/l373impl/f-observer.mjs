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
import { APP_DIR, ensureWorkspace, m0End, m0Start, paneList, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-fobs-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const LOAD_HZ = Number(process.env.L373_LOAD_HZ ?? 60)
const LOAD_SECS = 120
const WINDOW_MS = Number(process.env.L373_WINDOW_MS ?? 20000)
const ETX = '\u0003'
const OUT_NAME = process.env.L373_OUT ?? 'f-observer.json'

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 부하: { hz: LOAD_HZ, 창ms: WINDOW_MS } }

const startLoad = (paneIds) => {
  paneIds.forEach((paneId, index) => {
    execFileSync('herdr', [
      '--session',
      SESSION,
      'pane',
      'run',
      paneId,
      `bash ${path.join(APP_DIR, 'scripts/l373impl/load.sh')} ${LOAD_HZ} ${LOAD_SECS} p${index + 1}`,
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
await sleep(800)
await quiesce(app)

// 4 pane — P 계열의 기본 케이스와 같은 모양으로 본다.
await press(app, { key: 'd' })
await sleep(2500)
await press(app, { key: 'd', shift: true })
await sleep(2500)
await press(app, { key: 'd' })
await sleep(2500)
await quiesce(app)

const selected = (
  await app.send({ cmd: 'eval', code: `(() => document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null)()` })
).result
const tabId = paneList().find((p) => p.pane_id === selected)?.tab_id ?? null
const paneIds = paneList()
  .filter((p) => p.tab_id === tabId)
  .map((p) => p.pane_id)
결과.대상 = { tabId, paneIds, 선택: selected }
console.log('# 대상', JSON.stringify(결과.대상))

startLoad(paneIds)
await sleep(4000) // 부하가 실제로 흐를 때까지 (창 밖)

const before = (await app.send({ cmd: 'counters' })).counters
const t0 = Date.now()
const [cheap, heavy] = await Promise.all([observe('cheap', paneIds[0]), observe('heavy', paneIds[0])])
const t1 = Date.now()
const after = (await app.send({ cmd: 'counters' })).counters
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
결과.cheap = cheap
결과.heavy = heavy
결과.판정 = {
  'ⓐ 앱이 받은 서피스/s': 결과.앱.서피스초당,
  'ⓑ cheap 관측자/s': cheap.초당 ?? null,
  'ⓒ heavy 관측자/s (m1 과 같은 부담)': heavy.초당 ?? null,
  'm1 이 적었던 F': 27.4,
  부하hz: LOAD_HZ,
  결론:
    cheap.초당 !== undefined && heavy.초당 !== undefined && cheap.초당 > heavy.초당 * 1.4
      ? '관측자 부담으로 갈린다 — heavy 가 느려서 F 가 낮게 찍혔다'
      : '관측자 부담으로는 안 갈린다 — 두 관측자가 같은 수를 본다. 남은 변수는 **부하 자체**다',
}
console.log('\n판정', JSON.stringify(결과.판정, null, 1))

await app.stop()
await sleep(1500)
결과.M0_끝 = m0End()
writeRaw(OUT_NAME, 결과)
console.log('wrote raw/claude/' + OUT_NAME)
