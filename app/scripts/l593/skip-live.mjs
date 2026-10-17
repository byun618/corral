// LIFE-593 최종 관문 E7+ — skip-worktree(디스크에 있음/없음)가 ⌘P·이름 필터에 어떻게 나오나(실창). 리뷰 r3 `claude-r3-raw/probes/r3c-skip.mjs` 를 옮김.
//   바꾼 점: 질의를 ⌘A+Backspace 대신 DOM setter 로 비운다(⌘A 가 입력칸 전체 선택을 하지 않아 앞 질의 뒤에 이어 쳐져 「없음」 판정이 공허해질 수 있다 — G40c 진단).
//   양성 대조: 같은 질의 방식으로 보통 추적 파일(src/sub/.gitignore·docs/guide/…)이 보인다.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/skip-live.mjs <ROOT> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: skip-live.mjs /tmp/l593g-* OUT.json')
const repo = path.join(root, 'repo')
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const git = (...a) => execFileSync('git', ['-C', repo, ...a])
const setValue = (selector, value) => q(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
const res = { at: new Date().toISOString() }
let exitCode = 1
try {
  git('update-index', '--skip-worktree', 'src/app.ts', 'src/sub/kept.ts') // app.ts 는 디스크에 둔다 + 로컬 수정
  fs.writeFileSync(path.join(repo, 'src/app.ts'), 'local edit\n')
  fs.rmSync(path.join(repo, 'src/sub/kept.ts')) // sparse 처럼 디스크에 없음
  res.lsTags = execFileSync('git', ['-C', repo, 'ls-files', '-t', 'src/app.ts', 'src/sub/kept.ts'], { encoding: 'utf8' })
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  await repoPane(root)
  await sleep(2000)
  await key('Shift')
  await key('P', ['meta'])
  await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' ? true : null`), { timeoutMs: 10_000, label: '⌘P' })
  const rowsFor = async (text) => {
    await setValue('[data-quick-open-input]', text)
    await sleep(1200)
    return { value: await q(`document.querySelector('[data-quick-open-input]').value`), rows: await q(`[...document.querySelectorAll('[data-quick-open-row]')].map((r) => r.dataset.quickOpenRow)`) }
  }
  res.quickApp = await rowsFor('src app.ts')
  res.quickKept = await rowsFor('src sub kept')
  res.quickControl = await rowsFor('src sub gitignore')
  await key('Escape')
  await sleep(500)
  const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '행' })
  await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-toggle]' })).ok === true, { label: '필터 단추' })
  await until(() => q(`!!document.querySelector('[data-explorer-filter-input]')`), { timeoutMs: 5000, label: '필터' })
  const filterRows = async (text) => {
    await setValue('[data-explorer-filter-input]', text)
    await sleep(1500)
    return { value: await q(`document.querySelector('[data-explorer-filter-input]').value`), rows: await q(`[...document.querySelectorAll('[data-explorer-row]')].map((r) => r.dataset.explorerRow)`), status: await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? null`) }
  }
  res.filterApp = await filterRows('app.ts')
  res.filterKept = await filterRows('kept')
  res.filterControl = await filterRows('needle-guide')
  res.checks = {
    quickAppPresent: res.quickApp.rows.includes('src/app.ts'),
    quickKeptAbsent: res.quickKept.value === 'src sub kept' && !res.quickKept.rows.includes('src/sub/kept.ts'),
    quickControl: res.quickControl.rows.includes('src/sub/.gitignore'),
    filterAppPresent: res.filterApp.rows.includes('src/app.ts'),
    filterKeptAbsent: res.filterKept.value === 'kept' && !res.filterKept.rows.includes('src/sub/kept.ts'),
    filterControl: res.filterControl.rows.includes('docs/guide/l593-needle-guide.md'),
  }
  exitCode = Object.values(res.checks).every(Boolean) ? 0 : 1
} catch (e) {
  res.error = String(e?.stack ?? e)
  console.error(res.error)
} finally {
  res.giveBack = giveBackLog
  res.exitCode = exitCode
  writeJson(path.resolve(out), res)
  console.log(JSON.stringify(res.checks ?? res.error))
}
process.exit(exitCode)
