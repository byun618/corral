// LIFE-593 수정 r2 R2-C-01 — 목록을 읽는 중(느린 git shim, SIGTERM 무시) 앱을 끝내면(⌘Q = quit-entry quit · 창 닫힘 = quit-entry close) git 자식·손주가 남지 않아야 한다.
// 리뷰 r2 `claude-r2-raw/probes/r2c-quit.mjs` 를 옮김. 앱은 `L593_PATH=<git-shim>:/usr/bin:/bin L593_SHIM_PIDS=<파일>` 로 띄운다(iso.sh 의 ISO_ENV).
// 판정: 앱이 사라지고 3.5 s 뒤 shim 이 적은 pid 가 모두 죽었으면 0. 측정 뒤 남은 shim pid 는 이 스크립트가 SIGKILL 로 정리한다(정리 기록은 cleanup 칸).
// 사용(app/ 에서, iso.sh 안): node scripts/l593/quit-children.mjs <ROOT> <quit|close> <PIDS 파일> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack } from './lib.mjs'

const [root, via, pidsFile, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !['quit', 'close'].includes(via) || pidsFile === undefined || out === undefined) throw new Error('사용: quit-children.mjs /tmp/l593g-* <quit|close> PIDS OUT.json')
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const read = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), line: line.slice(0, 160) })) : [])
const q = (js) => evalJs(root, js)
const res = { at: new Date().toISOString(), via, pidsFile }
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  await repoPane(root)
  await sleep(1500)
  await ctl(root, { cmd: 'key', keyCode: 'Shift' })
  await ctl(root, { cmd: 'key', keyCode: 'P', modifiers: ['meta'] })
  await until(() => q(`!!document.querySelector('[data-quick-open]')`), { timeoutMs: 10_000, label: '⌘P 열림' })
  await until(() => read().filter((item) => item.line.includes('grandchild')).length >= 2, { timeoutMs: 10_000, label: 'shim git 기동' })
  res.pids = read()
  res.aliveBefore = res.pids.filter((item) => alive(item.pid)).length
  res.state = await q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState ?? null`)
  const appPid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8'))
  const t0 = Date.now()
  res.quitReply = await ctl(root, { cmd: 'quit-entry', via })
  while (alive(appPid) && Date.now() - t0 < 15_000) await sleep(50)
  res.appGoneMs = alive(appPid) ? null : Date.now() - t0
  await sleep(1500)
  res.aliveAfter1500 = read().filter((item) => alive(item.pid)).map((item) => item.line)
  await sleep(2000)
  res.aliveAfter3500 = read().filter((item) => alive(item.pid)).map((item) => item.line)
  exitCode = res.appGoneMs !== null && res.aliveBefore >= 4 && res.aliveAfter3500.length === 0 ? 0 : 1
} catch (error) {
  res.error = String(error?.stack ?? error)
  console.error(res.error)
} finally {
  res.cleanup = []
  for (const item of read()) {
    if (!alive(item.pid)) continue
    res.cleanup.push(item.line)
    try { process.kill(item.pid, 'SIGKILL') } catch { /* 이미 없음 */ }
  }
  res.exitCode = exitCode
  writeJson(path.resolve(out), res)
  console.log(JSON.stringify({ appGoneMs: res.appGoneMs, aliveBefore: res.aliveBefore, aliveAfter3500: res.aliveAfter3500, cleanup: res.cleanup }))
}
process.exit(exitCode)
