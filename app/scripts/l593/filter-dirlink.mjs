// LIFE-593 수정 r2 R2-C-03 — 이름 필터 행 열기도 ⌘P 와 같은 폴더 링크 확인을 거치고, 어느 경로로 열든 거절 결과(not_file·폴더·outside_root)는 최근 기록에 넣지 않는다.
//   ① 필터에서 untracked 안 폴더 링크(`link-inside-dir` → src) 행을 누름 → 탭 없음·안내(토스트)
//   ② 필터에서 밖 폴더 링크(`link-outside-dir`) 행을 누름 → 거절 탭(`outside_root`)은 그대로 뜬다(코디 판정 ⓑ)
//   ③ 일반 트리에서 밖 파일 링크(`link-outside-file`)를 누름 → 거절 탭
//   ④ 1.5 s 뒤(저장 뭉침 밖) ui-prefs.json 최근 기록에 위 셋이 없다. 양성 대조로 보통 파일(README.md)을 트리에서 열어 기록되는지 함께 본다
// 리뷰 r2 `probes/r2c-filter-dirlink.mjs` 를 옮겨 넓힘. 사용(app/ 에서, iso.sh 안): node scripts/l593/filter-dirlink.mjs <ROOT> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: filter-dirlink.mjs /tmp/l593g-* OUT.json')
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const repo = path.join(root, 'repo')
const prefs = path.join(root, 'ud', 'ui-prefs.json')
const res = { at: new Date().toISOString() }
let exitCode = 1
const tabs = () => q(`[...document.querySelectorAll('[data-file-tab]')].map((t) => t.dataset.fileTab)`)
const noticeOf = (rel) => until(() => q(`(() => { const n = document.querySelector('.file-group[data-file-view="${rel}"] .file-view-notice')?.dataset.fileNotice ?? null; return n === null || n === 'loading' ? null : n })()`), { timeoutMs: 5_000, label: `보기 ${rel}` }).then((hit) => hit.value, () => null)
try {
  fs.symlinkSync('src', path.join(repo, 'link-inside-dir'))
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  await repoPane(root)
  await sleep(2500)
  const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '행' })
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: '[data-explorer-row="docs"]' })
    await sleep(200)
    return q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
  }, { timeoutMs: 6_000, label: '트리 포커스' })
  await giveBack()
  const filterTo = async (text) => {
    await key('F', ['meta', 'alt'])
    await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 5_000, label: '필터' })
    await key('A', ['meta'])
    await key('Backspace')
    await ctl(root, { cmd: 'type', text })
    await until(() => q(`!!document.querySelector('[data-explorer-row="${text}"]') ? true : null`), { timeoutMs: 8_000, label: `필터 행 ${text}` })
  }
  // ①
  await filterTo('link-inside-dir')
  await ctl(root, { cmd: 'click', selector: '[data-explorer-row="link-inside-dir"]' })
  const toast = await until(() => q(`document.body.innerText.includes('폴더(링크)') ? true : null`), { timeoutMs: 3_000, label: '토스트' }).then(() => true, () => false)
  await sleep(800)
  res.inside = { toast, tabs: await tabs() }
  // ②
  await filterTo('link-outside-dir')
  await ctl(root, { cmd: 'click', selector: '[data-explorer-row="link-outside-dir"]' })
  res.outsideDir = { notice: await noticeOf('link-outside-dir'), tabs: await tabs() }
  // ③ 필터를 닫고 일반 트리
  await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-close]' })
  await until(() => q(`!document.querySelector('[data-explorer-filter-input]') && !!document.querySelector('[data-explorer-row="link-outside-file"]')`), { timeoutMs: 5_000, label: '트리' })
  await ctl(root, { cmd: 'click', selector: '[data-explorer-row="link-outside-file"]' })
  res.outsideFile = { notice: await noticeOf('link-outside-file'), tabs: await tabs() }
  // 양성 대조 — 보통 파일은 기록된다
  await ctl(root, { cmd: 'click', selector: '[data-explorer-row="README.md"]' })
  await until(() => q(`document.querySelector('[data-file-tab="README.md"]')?.dataset.active === 'true' ? true : null`), { timeoutMs: 5_000, label: 'README 탭' })
  await sleep(1500)
  const realRepo = fs.realpathSync(repo)
  res.recent = JSON.parse(fs.readFileSync(prefs, 'utf8')).recentFiles?.[realRepo] ?? null
  const refused = ['link-inside-dir', 'link-outside-dir', 'link-outside-file']
  res.checks = {
    filterDirLink: res.inside.toast && !res.inside.tabs.includes('link-inside-dir'),
    outsideTabs: res.outsideDir.notice === 'outside_root' && res.outsideFile.notice === 'outside_root',
    recentNoRefused: Array.isArray(res.recent) && refused.every((rel) => !res.recent.includes(rel)),
    recentControl: Array.isArray(res.recent) && res.recent[0] === 'README.md',
  }
  exitCode = Object.values(res.checks).every(Boolean) ? 0 : 1
} catch (error) {
  res.error = String(error?.stack ?? error)
  console.error(res.error)
} finally {
  res.giveBack = giveBackLog
  res.exitCode = exitCode
  writeJson(path.resolve(out), res)
  console.log(JSON.stringify(res).slice(0, 1500))
}
process.exit(exitCode)
