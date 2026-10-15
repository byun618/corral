// LIFE-593 최종 관문 E7ⓓ — 목록 상한(FILE_LIST_MAX 50만) 안내. 51만 파일 fixture(/tmp/l593f-cap510k/repo, untracked)를 열고
//   ⌘P: 준비 뒤 「목록이 상한에 걸려 일부만 찾습니다」(data-quick-open-truncated) · 이름 필터: 상태줄에 「목록 상한에 걸려 일부만 찾습니다」 · 긴 작업(>100 ms) 기록.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/cap-live.mjs <ROOT> <REPO=/tmp/l593f-cap510k/repo> <OUT.json>
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, repo, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !/^\/tmp\/l593f-[^/]+\/repo$/.test(repo ?? '') || out === undefined) throw new Error('사용: cap-live.mjs /tmp/l593g-* /tmp/l593f-*/repo OUT.json')
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const res = { at: new Date().toISOString(), repo }
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const { paneId } = await repoPane(root, { repo })
  await sleep(1500)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  await q(`(() => { window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }) }).observe({ type: 'longtask' }); return true })()`)
  const t0 = Date.now()
  await key('Shift')
  await key('P', ['meta'])
  await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' && !document.querySelector('[data-quick-open]').hasAttribute('data-quick-open-loading') ? true : null`), { timeoutMs: 60_000, label: '⌘P 준비' })
  res.quick = { readyMs: Date.now() - t0, truncated: await q(`document.querySelector('[data-quick-open-truncated]')?.textContent ?? null`), total: await q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? null`) }
  await key('Escape')
  await sleep(500)
  if ((await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { timeoutMs: 15_000, label: '탐색기 행' })
  await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-toggle]' })).ok === true, { label: '필터 단추' })
  const status = await until(async () => { const t = await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? ''`); return /상한/.test(t) ? t : null }, { timeoutMs: 60_000, label: '필터 상한 안내' }).then((h) => h.value, () => null)
  res.filter = { status }
  res.longtasks = await q(`window.__long`)
  res.checks = { quickTruncated: typeof res.quick.truncated === 'string' && res.quick.truncated.includes('상한'), filterNote: status !== null }
  exitCode = Object.values(res.checks).every(Boolean) ? 0 : 1
} catch (e) { res.error = String(e?.stack ?? e); console.error(res.error) }
finally { res.giveBack = giveBackLog; res.exitCode = exitCode; writeJson(path.resolve(out), res); console.log(JSON.stringify({ checks: res.checks, quick: res.quick, filter: res.filter, long: (res.longtasks ?? []).filter((e) => e.ms > 100) })) }
process.exit(exitCode)
