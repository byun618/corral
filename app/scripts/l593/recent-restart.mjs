// LIFE-593 수정 r1 R1-C-09 — 앱 재시작 때 복원된 활성 파일 탭은 최근 기록에 넣지 않는다.
//   open     : ⌘P 로 `src/deep/a/b/l593-target.ts` 를 연다(활성 파일 탭) → 뭉침 시간 뒤 ui-prefs.json 에 그 파일이 맨 앞으로 적혔는지 본다.
//   seed     : (앱 내린 뒤) ui-prefs.json 의 그 worktree 최근 기록을 ['README.md', 'src/app.ts'] 로 바꿔 둔다 — 복원될 활성 탭(target)이 맨 앞이 아니게.
//   restored : 다시 띄운 앱에서 target 탭이 복원·활성이 된 뒤 3 s 기다려 최근 기록이 그대로인지(target 이 앞으로 오지 않았는지) 본다.
// 사용(app/ 에서): node scripts/l593/recent-restart.mjs <open|seed|restored> <ROOT> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [mode, root, out] = process.argv.slice(2)
if (!['open', 'seed', 'restored'].includes(mode) || !/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: recent-restart.mjs <open|seed|restored> /tmp/l593g-* OUT.json')
const TARGET = 'src/deep/a/b/l593-target.ts'
const SEED = ['README.md', 'src/app.ts']
const prefsFile = path.join(root, 'ud', 'ui-prefs.json')
const repoReal = fs.realpathSync(path.join(root, 'repo'))
const recentOf = () => JSON.parse(fs.readFileSync(prefsFile, 'utf8')).recentFiles?.[repoReal] ?? null
const q = (js) => evalJs(root, js)
const result = { at: new Date().toISOString(), mode, steps: [] }
let exitCode = 1
try {
  if (mode === 'seed') {
    const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
    result.before = prefs.recentFiles?.[repoReal] ?? null
    prefs.recentFiles = { ...(prefs.recentFiles ?? {}), [repoReal]: SEED }
    fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2))
    result.after = recentOf()
    exitCode = JSON.stringify(result.after) === JSON.stringify(SEED) ? 0 : 1
  } else {
    await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
    await giveBack()
    if (mode === 'open') {
      const { paneId } = await repoPane(root)
      await sleep(1500)
      const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
      await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
      await sleep(1500) // 복원 보류(1 s) 밖으로
      await ctl(root, { cmd: 'key', keyCode: 'Shift' })
      await ctl(root, { cmd: 'key', keyCode: 'P', modifiers: ['meta'] })
      await until(() => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState === 'ready' ? true : null`), { timeoutMs: 10_000, label: '⌘P' })
      await ctl(root, { cmd: 'type', text: 'l593 target' })
      await until(() => q(`document.querySelector('[data-quick-open-row]')?.dataset.quickOpenRow === '${TARGET}' ? true : null`), { timeoutMs: 5_000, label: '결과' })
      await ctl(root, { cmd: 'key', keyCode: 'Return' })
      await until(() => q(`document.querySelector('[data-file-tab="${TARGET}"]')?.dataset.active === 'true' ? true : null`), { timeoutMs: 8_000, label: '활성 파일 탭' })
      const at100 = recentOf()
      await sleep(1500)
      const at1600 = recentOf()
      result.steps.push({ name: 'open', recentRightAfter: at100, recentAfter1500ms: at1600 })
      console.log('# open', JSON.stringify(result.steps.at(-1)))
      exitCode = at1600?.[0] === TARGET ? 0 : 1
    } else {
      const restored = await until(() => q(`document.querySelector('[data-file-tab="${TARGET}"]')?.dataset.active === 'true' ? true : null`), { timeoutMs: 20_000, label: '복원된 활성 탭' }).then(() => true, () => false)
      const at0 = recentOf()
      await sleep(3000)
      const at3000 = recentOf()
      result.steps.push({ name: 'restored', restoredActive: restored, recentAtRestore: at0, recentAfter3s: at3000 })
      console.log('# restored', JSON.stringify(result.steps.at(-1)))
      exitCode = restored && JSON.stringify(at3000) === JSON.stringify(SEED) ? 0 : 1
    }
  }
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  result.giveBack = giveBackLog
  result.exitCode = exitCode
  writeJson(path.resolve(out), result)
}
process.exit(exitCode)
