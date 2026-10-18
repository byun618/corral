// LIFE-593 E9ⓒ — 패키지 앱이 고르는 git 경로. pkg-up.sh 로 띄운 격리 패키지 앱에 fixture 레포를 열고 renderer 에서 fileList 를 한 번 불러
// main 로그 `file.list_git`(index.ts — 고른 git 이 바뀔 때 적음)와 앱 프로세스 PATH 를 기록한다. 입력 없음(제어 소켓 add-repo·eval 만).
// 사용(app/ 에서): node scripts/l593/pkg-git.mjs <ROOT=/tmp/l593g-*> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, until, writeJson, repoPane, herdr, sleep } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: pkg-git.mjs /tmp/l593g-* OUT.json')
const repo = path.join(root, 'repo')
const result = { at: new Date().toISOString() }
let exitCode = 1
try {
  await until(() => evalJs(root, `!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  const pid = fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim()
  result.appPid = pid
  result.appExe = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim().split(' --')[0]
  result.appPath = (execFileSync('ps', ['eww', '-o', 'command=', '-p', pid], { encoding: 'utf8' }).match(/(?:^| )PATH=([^ ]*)/) ?? [])[1] ?? null
  // 그 레포를 활성 worktree 로(탐색기·목록 루트 = 지금 열린 worktree) — pane 을 만들고 그 탭을 누른다(quick-entry 와 같음).
  const { paneId } = await repoPane(root)
  await sleep(1500)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  const real = fs.realpathSync(repo)
  const call = () => evalJs(root, `window.corral.fileList({ root: ${JSON.stringify(real)}, includeIgnored: false, requestId: 'pkg-git-' + Date.now() }).then((r) => r.ok ? { ok: true, count: r.count } : { ok: false, code: r.code })`)
  const listed = await until(async () => { const r = await call(); return r?.ok === true ? r : null }, { timeoutMs: 15_000, everyMs: 500, label: 'fileList' })
  result.fileList = listed.value
  const logFile = path.join(root, 'ud', 'corral.ndjson')
  result.listGitLines = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('"file.list_git"'))
  result.picked = result.listGitLines.map((line) => JSON.parse(line).git ?? JSON.parse(line).data?.git ?? null)
  exitCode = result.fileList?.ok === true && result.picked.length > 0 ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  result.exitCode = exitCode
  writeJson(path.resolve(out), result)
  console.log(JSON.stringify(result, null, 1).slice(0, 1500))
}
process.exit(exitCode)
