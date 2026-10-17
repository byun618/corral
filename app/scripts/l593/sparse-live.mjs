// LIFE-593 최종 관문 E7+ — sparse 대량 S(디스크에 없는 skip-worktree 10만 · /tmp/l593f-sparse100k) 실창 회차(R3-C-01 의 Electron 판).
//   ① ⌘P 열기 → 준비 → 질의(k1) 결과 · ② 이름 필터 열기 → 질의 결과 — 그동안 렌더러 긴 작업(>100 ms)·main 이벤트 루프 지연(계측 loop-delay — 구간 시작에 읽어 비우고 끝에 읽음)
//   ③ 실행 중 닫기: ⌘P 직후(목록 읽는 중) Esc → 1.5 s 뒤 앱의 git 자식(ls-files) 0
// 사용(app/ 에서, iso.sh 안): node scripts/l593/sparse-live.mjs <ROOT> <REPO=/tmp/l593f-sparse100k/repo> <OUT.json>
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, repo, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !/^\/tmp\/l593f-[^/]+\/repo$/.test(repo ?? '') || out === undefined) throw new Error('사용: sparse-live.mjs /tmp/l593g-* /tmp/l593f-*/repo OUT.json')
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const setValue = (selector, value) => q(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
const appPid = () => Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim())
const gitKids = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter(Boolean)
  return rows.filter((l) => { const [pid, ppid] = l.split(/\s+/); return Number(ppid) === appPid() && /\bgit\b.*ls-files/.test(l) && Number(pid) > 0 })
}
const res = { at: new Date().toISOString(), repo, phases: {} }
let exitCode = 1
try {
  res.sTags = execFileSync('sh', ['-c', `git -C '${repo}' ls-files -t | cut -c1 | sort | uniq -c`], { encoding: 'utf8' })
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const { paneId } = await repoPane(root, { repo })
  await sleep(1500)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  await sleep(1000)
  await q(`(() => { window.__lt?.disconnect(); window.__long = []; window.__lt = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }) }); window.__lt.observe({ type: 'longtask' }); return true })()`)
  // ① ⌘P
  await ctl(root, { cmd: 'loop-delay' })
  const t0 = Date.now()
  await key('Shift')
  await key('P', ['meta'])
  await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' && !document.querySelector('[data-quick-open]').hasAttribute('data-quick-open-loading') ? true : null`), { timeoutMs: 20_000, label: '⌘P 준비' })
  const readyMs = Date.now() - t0
  await setValue('[data-quick-open-input]', 'k1')
  await sleep(800)
  const rows = await q(`[...document.querySelectorAll('[data-quick-open-row]')].map((r) => r.dataset.quickOpenRow)`)
  const total = await q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? null`)
  const loopQuick = (await ctl(root, { cmd: 'loop-delay' })).loopDelay
  res.phases.quick = { readyMs, total, rows: rows.slice(0, 5), loop: loopQuick }
  await key('Escape')
  await sleep(500)
  // ② 이름 필터
  if ((await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { timeoutMs: 15_000, label: '탐색기 행' })
  await ctl(root, { cmd: 'loop-delay' })
  const f0 = Date.now()
  await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-toggle]' })).ok === true, { label: '필터 단추' })
  await until(() => q(`!!document.querySelector('[data-explorer-filter-input]')`), { timeoutMs: 5000, label: '필터' })
  await setValue('[data-explorer-filter-input]', 'k1')
  const status = await until(async () => { const t = await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? ''`); return /개|일치 없음/.test(t) ? t : null }, { timeoutMs: 20_000, label: '필터 결과' }).then((h) => h.value, () => null)
  const filterMs = Date.now() - f0
  const loopFilter = (await ctl(root, { cmd: 'loop-delay' })).loopDelay
  res.phases.filter = { filterMs, status, rows: (await q(`[...document.querySelectorAll('[data-explorer-row]')].map((r) => r.dataset.explorerRow)`)).slice(0, 6), loop: loopFilter }
  await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-close]' })
  await sleep(500)
  // ③ 실행 중 닫기 → git 자식 0 (5회 — 목록이 ~0.6 s 라 ⌘P 직후 Esc 가 읽는 중에 닿는다)
  const closes = []
  // (G58 — Esc 직전 git 자식을 한 번도 못 잡아 닫기가 읽는 중에 닿았는지 몰랐다. 닫을 때마다 main 로그 file.list 완료 줄이 새로 생겼는지(= 끝까지 읽음)도 본다.
  //  cancelled 는 로그를 남기지 않는다 — 완료 줄 0 이면 닫기가 읽는 중(git 또는 디스크 확인 단계)에 닿아 끝낸 것)
  const listDone = () => fs.readFileSync(path.join(root, 'ud', 'corral.ndjson'), 'utf8').split('\n').filter((l) => l.includes('"tag":"file.list"') && l.includes('"ok":true')).length
  for (let i = 0; i < 5; i += 1) {
    const doneBefore = listDone()
    await key('Shift')
    await key('P', ['meta'])
    await sleep(60 + i * 60)
    const during = gitKids().length
    await key('Escape')
    await sleep(1500)
    closes.push({ i, waitMs: 60 + i * 60, kidsDuringBeforeEsc: during, kidsAfter: gitKids(), listCompletedDuring: listDone() - doneBefore })
  }
  res.phases.closes = closes
  res.longtasks = await q(`window.__long ?? []`)
  const over = res.longtasks.filter((e) => e.ms > 100)
  res.checks = {
    quickRows: rows.length > 0,
    filterStatus: status !== null,
    longOver100: over.length === 0,
    mainLoopMaxUnder100: (loopQuick?.max ?? 9e9) < 100 && (loopFilter?.max ?? 9e9) < 100,
    closeKids0: closes.every((c) => c.kidsAfter.length === 0),
  }
  exitCode = Object.values(res.checks).every(Boolean) ? 0 : 1
} catch (e) {
  res.error = String(e?.stack ?? e)
  console.error(res.error)
} finally {
  res.giveBack = giveBackLog
  res.exitCode = exitCode
  writeJson(path.resolve(out), res)
  console.log(JSON.stringify({ checks: res.checks, quick: res.phases.quick, filter: res.phases.filter, closes: res.phases.closes?.map((c) => [c.waitMs, c.kidsDuringBeforeEsc, c.kidsAfter.length, c.listCompletedDuring]) }).slice(0, 1500))
}
process.exit(exitCode)
