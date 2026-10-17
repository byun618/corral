// LIFE-590 E8ⓒ — 앱 시작 시간(격리 개발 Electron, /tmp/l590g-*). 회차마다 g-up → 탭바 첫 탭이 그려질 때까지 → g-down(term).
// 지표(회당):
//   · launchToTabMs  = g-up 이 앱을 띄우기 직전 시각(`<ROOT>/app.started`) → 렌더러에 `[data-main-tab]` 이 처음 보인 시각(제어 소켓 eval 폴링 25 ms)
//   · domContentLoadedMs · loadEventEndMs = 렌더러 navigation timing(문서 시작 기준) — 렌더러 번들 크기 영향이 여기서 보인다
//   · scriptsLoaded = 그 시점 문서에 로드된 script 자원 이름 — 편집기 코드가 첫 파일 탭 전에 로드되지 않는지(E8ⓒ 지연 로딩) 보는 자리
// herdr 이름 세션은 회차 사이 유지(레포 pane 하나), 끝에 g-down herdr 로 정리.
// 사용(app/ 에서): node scripts/l590/startup.mjs --root /tmp/l590g-s --fake /tmp/l590g-fs --out <json> [--runs 10]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { checkRoot, evalJs, pct, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string', default: '10' } } })
try { checkRoot(values.root) } catch (error) { console.error(String(error.message)); process.exit(2) }
if (values.out === undefined || values.fake === undefined) { console.error('--out · --fake 필요'); process.exit(2) }
const root = values.root
const sh = (args) => execFileSync('sh', args, { encoding: 'utf8' })

const runs = []
let failed = 0
for (let i = 0; i < Number(values.runs); i += 1) {
  const up = sh(['scripts/l577/g-up.sh', root, values.fake])
  try {
    if (i === 0) await repoPane(root)
    const started = Number(fs.readFileSync(`${root}/app.started`, 'utf8').trim())
    await until(() => evalJs(root, `!!document.querySelector('[data-main-tab]')`), { timeoutMs: 30_000, everyMs: 25, label: '첫 탭' })
    const seen = Date.now()
    const nav = await evalJs(root, `(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, scripts: performance.getEntriesByType('resource').filter((r) => r.initiatorType === 'script' || r.name.endsWith('.js')).map((r) => r.name.split('/').pop()) } })()`)
    runs.push({ i, launchToTabMs: seen - started, domContentLoadedMs: nav.dcl, loadEventEndMs: nav.load, scriptsLoaded: nav.scripts, pid: up.match(/app_pid=(\d+)/)?.[1] ?? null })
    console.log(`run ${i} launch→tab ${seen - started} ms · dcl ${Math.round(nav.dcl)} ms`)
  } catch (error) {
    failed += 1
    runs.push({ i, error: String(error.message) })
    console.log(`run ${i} 실패 ${error.message}`)
  }
  console.log(sh(['scripts/l577/g-down.sh', root, 'term']).trim())
  await sleep(500)
}
console.log(sh(['scripts/l577/g-down.sh', root, 'term', 'herdr']).trim())
const ok = runs.filter((run) => run.error === undefined)
const summary = (key) => ({ p50: pct(ok.map((run) => run[key]), 50), p95: pct(ok.map((run) => run[key]), 95), max: Math.max(...ok.map((run) => run[key])) })
writeJson(values.out, { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), runs, failed, launchToTab: summary('launchToTabMs'), domContentLoaded: summary('domContentLoadedMs') })
console.log(JSON.stringify({ failed, launchToTab: summary('launchToTabMs'), domContentLoaded: summary('domContentLoadedMs') }))
process.exit(failed === 0 && ok.length >= 10 ? 0 : 1)
