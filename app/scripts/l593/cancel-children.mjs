// LIFE-593 최종 관문 E7ⓓ — 목록을 읽는 중(느린 git shim — SIGTERM 무시 + TERM 무시 손주) 그 요청을 끝내는 동작마다 git 자식·손주가 남지 않는지.
//   esc    : ⌘P → shim 이 뜬 뒤 Esc(대화상자 닫기)
//   switch : 탐색기 이름 필터 열기(목록 요청) → shim 이 뜬 뒤 사이드바에서 다른 worktree 카드로 전환
//   tick   : ⌘P 와 Esc 를 기다림 없이 잇달아(같은 틱에 가까운 취소 — 같은 틱 자체는 단위 시험 R1-C-03)
// 판정: 동작 뒤 3 s 안에 shim 이 적은 pid 가 모두 죽음. 남은 pid 는 측정 뒤 SIGKILL 로 정리(cleanup 칸). 앱은 L593_PATH=<git-shim>:… L593_SHIM_PIDS=<ROOT>/shim-pids.txt 로 띄운다.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/cancel-children.mjs <ROOT> <esc|switch|tick> <OUT.json>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog, herdr } from './lib.mjs'

const [root, mode, out] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || !['esc', 'switch', 'tick'].includes(mode) || out === undefined) throw new Error('사용: cancel-children.mjs /tmp/l593g-* <esc|switch|tick> OUT.json')
const pidsFile = path.join(root, 'shim-pids.txt')
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const read = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), line: line.slice(0, 160) })) : [])
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const res = { at: new Date().toISOString(), mode, pidsFile }
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  const repo = path.join(root, 'repo')
  const { paneId } = await repoPane(root)
  await sleep(1500)
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await ctl(root, { cmd: 'click', selector: `[data-main-tab="${tabId}"]` })).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '탭 클릭' })
  let actAt = null
  if (mode === 'esc' || mode === 'tick') {
    await key('Shift')
    await key('P', ['meta'])
    if (mode === 'tick') {
      await key('Escape')
      actAt = Date.now()
      await sleep(1500)
    } else {
      await until(() => Promise.resolve(read().length >= 2 ? true : null), { timeoutMs: 10_000, label: 'shim 뜸' })
      await sleep(300)
      res.before = read().map((x) => ({ ...x, alive: alive(x.pid) }))
      await key('Escape')
      actAt = Date.now()
    }
    res.dialogClosed = await until(() => q(`!document.querySelector('[data-quick-open]')`), { timeoutMs: 3000, label: '닫힘' }).then(() => true, () => false)
  } else {
    const repo2 = path.join(root, 'repo2')
    fs.mkdirSync(repo2, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo2])
    execFileSync('git', ['-C', repo2, '-c', 'user.name=l593', '-c', 'user.email=l593@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'])
    await repoPane(root, { repo: repo2 })
    await sleep(1500)
    const card = (p) => `[data-worktree="${fs.realpathSync(p)}"]`
    const activeCard = (p) => q(`!!document.querySelector('${card(p)} [data-worktree-card-active="primary"]')`)
    await until(async () => { await ctl(root, { cmd: 'click', selector: card(repo) }); await sleep(300); return activeCard(repo) }, { timeoutMs: 15_000, everyMs: 300, label: 'repo 카드' })
    if ((await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
    await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { timeoutMs: 15_000, label: '탐색기 행' })
    await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-filter-toggle]' })).ok === true, { label: '필터 단추' })
    await until(() => Promise.resolve(read().length >= 2 ? true : null), { timeoutMs: 10_000, label: 'shim 뜸' })
    await sleep(300)
    res.before = read().map((x) => ({ ...x, alive: alive(x.pid) }))
    await ctl(root, { cmd: 'click', selector: card(repo2) })
    actAt = Date.now()
    res.switched = await until(() => activeCard(repo2), { timeoutMs: 5000, label: 'repo2 카드' }).then(() => true, () => false)
  }
  const deadline = actAt + 3000
  let left = read().filter((x) => alive(x.pid))
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(100)
    left = read().filter((x) => alive(x.pid))
  }
  res.spawned = read()
  res.leftAfter3s = left
  res.allDeadMs = left.length === 0 ? Date.now() - actAt : null
  res.cleanup = left.map((x) => { try { process.kill(x.pid, 'SIGKILL'); return { pid: x.pid, killed: true } } catch { return { pid: x.pid, killed: false } } })
  const spawnedOk = mode === 'tick' ? true : res.spawned.length >= 2
  exitCode = spawnedOk && left.length === 0 && (res.dialogClosed ?? res.switched) === true ? 0 : 1
  console.log(`# ${mode} spawned=${res.spawned.length} left=${left.length} allDeadMs=${res.allDeadMs}`)
} catch (error) {
  res.error = String(error?.stack ?? error)
  console.error(res.error)
  for (const x of read()) { try { process.kill(x.pid, 'SIGKILL') } catch { /* 끝남 */ } }
} finally {
  res.giveBack = giveBackLog
  res.exitCode = exitCode
  writeJson(path.resolve(out), res)
}
process.exit(exitCode)
