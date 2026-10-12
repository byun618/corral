/* global window, document */
// LIFE-589 E10·E9 — Orca(소스 `~/repos/etc/orca` 개발 모드, 격리 userData·HOME)를 gui-diff 하네스(`launchOrca`)로 띄워 탐색기를 찍는다.
// 설치본 Orca 는 쓰지 않는다 — 격리로 띄우면 자동 업데이터가 새 버전을 찾고(1.4.224) 종료 때 설치본을 바꿀 수 있다(실측 로그 — first-screen/README).
// 사용: node scripts/l589/orca-shot.mjs --work /tmp/l589-orcadev --repo <worktree> --out <png> --expand app,app/src,app/src/main --select app/src/main/canonical-path.ts [--keep]
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launchOrca, seedOrcaRepo, setWindowBounds } from '../gui-diff/lib/orca.mjs'
import { until } from '../gui-diff/lib/cdp.mjs'

const { values } = parseArgs({ options: { work: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, expand: { type: 'string', default: '' }, select: { type: 'string' }, port: { type: 'string', default: '9391' }, keep: { type: 'boolean', default: false }, json: { type: 'string' } } })
if (!/^\/tmp\/l589-orcadev[^/]*$/.test(values.work ?? '')) throw new Error('--work 는 /tmp/l589-orcadev*')
fs.mkdirSync(values.work, { recursive: true })
const ORCA = path.join(process.env.HOME ?? '', 'repos/etc/orca')
const handle = await launchOrca({ repoRoot: ORCA, workDir: values.work, port: Number(values.port), logPath: path.join(values.work, 'orca.log'), onSpawn: (info) => { if (info.pid !== undefined) fs.writeFileSync(path.join(values.work, 'runner.pid'), String(info.pid)) } })
const result = { orcaVersion: JSON.parse(fs.readFileSync(path.join(ORCA, 'package.json'), 'utf8')).version, repo: values.repo }
try {
  await setWindowBounds(handle, { width: 1440, height: 900 }).catch(() => null)
  await seedOrcaRepo(handle, values.repo, { expectedWorktrees: 1 })
  // 이 worktree 를 활성으로 · 오른쪽 사이드바 explorer 탭을 연다.
  result.active = await handle.cdp.evaluate((repo) => {
    const state = window.__store.getState()
    const all = Object.values(state.worktreesByRepo).flat()
    const target = all.find((worktree) => worktree.path === repo) ?? all[0]
    state.setActiveWorktree(target.id)
    state.setRightSidebarOpen(true)
    state.setRightSidebarTab('explorer')
    return { id: target.id, path: target.path, count: all.length }
  }, values.repo)
  const rowSelector = (rel) => `[data-file-explorer-row-path$="${rel}"], [data-path$="/${rel}"]`
  await new Promise((resolve) => setTimeout(resolve, 1500))
  result.rowAttrs = await handle.cdp.evaluate(() => {
    const row = document.querySelector('[role="treeitem"]')
    return row === null ? null : [...row.attributes].map((attr) => `${attr.name}=${attr.value.slice(0, 80)}`)
  })
  for (const rel of values.expand.split(',').filter((item) => item.length > 0)) {
    const box = await until(() => handle.cdp.evaluate((name) => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')]
      const row = rows.find((el) => el.textContent.trim() === name)
      if (!row) return null
      const r = row.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, path.basename(rel)), `orca row ${rel}`, 15_000)
    await handle.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  void rowSelector
  if (values.select !== undefined) {
    const box = await until(() => handle.cdp.evaluate((name) => {
      const row = [...document.querySelectorAll('[role="treeitem"]')].find((el) => el.textContent.trim() === name)
      if (!row) return null
      const r = row.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, path.basename(values.select)), 'orca select row', 15_000)
    await handle.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  }
  await new Promise((resolve) => setTimeout(resolve, 800))
  const shot = await handle.cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(path.dirname(values.out), { recursive: true })
  fs.writeFileSync(values.out, Buffer.from(shot.data, 'base64'))
  result.out = values.out
  result.rows = await handle.cdp.evaluate(() => [...document.querySelectorAll('[role="treeitem"]')].slice(0, 40).map((el) => el.textContent.trim()))
} finally {
  if (values.json !== undefined) fs.writeFileSync(values.json, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result).slice(0, 2000))
  if (!values.keep) {
    try { process.kill(-handle.child.pid, 'SIGTERM') } catch (error) { console.log('kill', String(error)) }
  }
}
process.exit(0)
