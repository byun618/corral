// M5 (미검증 주장으로 켠 회피) — 렌더러 minify 를 **한 번 켜서 실제로 밟는지 확인한다.**
//
// 분석 ⓖ9 가 기록한 주장: xterm.js #5800 — 6.0.0 ESM 은 이미 minify 된 채로 배포되는데
// Vite 가 한 번 더 minify 하면 **DECRQM 처리에서 `ReferenceError`** 가 난다. 회피는
// `minifyIdentifiers:false` 또는 minify 끄기.
//
// 분석은 이것을 **미검증**으로 분류했고 "구현이 밟으면 그때 확인한다"고 적었다. 그런데 구현은
// 확인 없이 회피부터 켰고(`minify: false` 가 출고 기본값), 3자 중 둘이 그것을 짚었다 (판정 M5).
//
// 그래서 잰다: `CORRAL_RENDERER_MINIFY=1` 로 빌드해서
//   ① 렌더러에서 예외가 나는가 (`renderer.error` 프로브 — main 로그로 흘린다)
//   ② DECRQM 을 직접 쏴 봐도 나는가 — 프레임이 쓰는 DEC 2026(BSU/ESU)을 질의한다
//   ③ 화면이 실제로 그려지는가 (붙기 프레임 · 픽스처 재생)
// 안 나면 **기본값을 되돌린다.** 안 밟은 함정을 피해 다니는 설정은 근거가 없다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { APP_DIR, playFixture, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

const exec = promisify(execFile)

// DECRQM — 모드 질의. #5800 이 터진다고 지목된 자리다. 2026 은 이 앱이 프레임마다 쓰는 모드다.
const DECRQM = ['\x1b[?2026$p', '\x1b[?7$p', '\x1b[?25$p']

async function measure({ minify }) {
  console.log('=== minify', minify, '빌드 ===')
  await exec('npm', ['run', 'build'], {
    cwd: APP_DIR,
    env: { ...process.env, ...(minify ? { CORRAL_RENDERER_MINIFY: '1' } : {}) },
    maxBuffer: 1 << 24,
  })

  const paneId = await tidySession()
  const app = await startApp({ name: `minify-${minify ? 'on' : 'off'}` })
  await sleep(1500)
  await app.selectPane(paneId)
  await sleep(3000)

  // 실제 화면 경로를 한 번 돌린다 — 붙기 + 픽스처 재생(SGR·알트·유니코드가 다 들어 있다).
  await playFixture(paneId, '01-log.sh', { settleMs: 2000 })
  await sleep(1500)
  for (const query of DECRQM) {
    await app.write(query)
    await sleep(300)
  }
  await sleep(1500)

  const entries = app.entries()
  const errors = entries.filter((entry) => entry.tag === 'renderer.error')
  const frames = entries.filter((entry) => entry.tag === 'term.frame')
  const dump = (await app.dump()).dump
  const inked = dump.grid.flat().filter((cell) => (cell?.ch ?? ' ').trim() !== '').length
  const result = {
    minify,
    rendererErrors: errors.length,
    errorSample: errors.slice(0, 5),
    referenceErrors: errors.filter((entry) => String(entry.message).includes('ReferenceError')).length,
    frames: frames.length,
    inkedCells: inked,
    screenDrawn: inked > 0,
    decrqmQueries: DECRQM.length,
    shot: (await app.termShot(`minify-${minify ? 'on' : 'off'}`)).file,
  }
  console.log('M5', JSON.stringify({ ...result, errorSample: undefined, shot: undefined }))
  await app.stop()
  return result
}

const off = await measure({ minify: false })
const on = await measure({ minify: true })

const reproduced = on.rendererErrors > off.rendererErrors || on.referenceErrors > 0 || !on.screenDrawn
console.log('M5 ⓖ9 재현', reproduced ? '됐다 — 회피를 유지한다' : '안 됐다 — 기본값을 되돌린다')

writeRaw('60-minify.json', {
  measuredAt: new Date().toISOString(),
  claim: '분석 ⓖ9 / xterm.js #5800 — 이미 minify 된 6.0.0 ESM 을 Vite 가 한 번 더 minify 하면 DECRQM 처리에서 ReferenceError',
  claimStatus: '분석이 미검증으로 분류했고 구현이 확인 없이 회피(minify:false)를 기본값으로 켰다 (판정 M5)',
  method: '두 팔 모두 실제 빌드 → 앱 실행 → 붙기 + 픽스처 재생 + DECRQM 3종 질의. 렌더러 예외는 renderer.error 프로브로 main 로그에 남는다',
  decrqmQueries: DECRQM,
  arms: { minifyOff: off, minifyOn: on },
  reproduced,
  decision: reproduced ? 'minify 기본 끄기를 유지한다 (근거가 생겼다)' : 'minify 기본값을 되돌린다 — 안 밟는 함정을 피하는 설정이었다',
})
process.exit(0)
