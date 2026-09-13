// G6 눈확인 (측정 아님) — worktree 만들기 모달 path 프리필/동기화/수동 우선. 격리 life356-claude.
//   ① 모달 열면 path 가 <repoRoot>/.claude/worktrees/ 로 프리필
//   ② branch 타이핑하면 path 꼬리가 따라 바뀜 (feature/foo → .../worktrees/feature-foo)
//   ③ path 를 직접 수정한 순간부터 branch 를 더 쳐도 path 동기화 멈춤 (수동 우선)
// data-* 불변 — 기존 셀렉터로 좌표 클릭/타이핑.

import { makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'g6-visual' })
const out = { at: new Date().toISOString(), ready: app.ready, steps: [] }
const pathValue = async () => (await app.query('[data-worktree-path-input]')).found[0]
const record = (label, v) => { out.steps.push({ label, ...v }); console.log(`[${label}]`, JSON.stringify(v)) }

try {
  const repo = makeScratchRepo('g6')
  const root = repo.root
  out.repoRoot = root
  const worktreesDir = `${root}/.claude/worktrees`

  await app.addRepo(root)
  await until(async () => (await app.query(`[data-repo="${root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-create-worktree="${root}"]`)
  await until(async () => (await app.query('[data-create-worktree-modal]')).found.length > 0, { what: 'modal open' })

  // ① 프리필
  await sleep(150)
  const prefill = await pathValue()
  record('prefill', { path: prefill, expected: `${worktreesDir}/`, ok: prefill === `${worktreesDir}/` })

  // ② 동기화 — branch 타이핑
  await app.click('[data-worktree-branch-input]')
  await app.type('feature/foo')
  await sleep(150)
  const synced = await pathValue()
  record('sync', { path: synced, expected: `${worktreesDir}/feature-foo`, ok: synced === `${worktreesDir}/feature-foo` })

  // ③ 수동 우선 — path 직접 수정 후 branch 를 더 쳐도 path 불변
  await app.click('[data-worktree-path-input]')
  await app.type('-manual') // path 끝(포커스 위치)에 삽입 → pathEdited=true
  await sleep(150)
  const edited = await pathValue()
  await app.click('[data-worktree-branch-input]')
  await app.type('-bar') // branch=feature/foo-bar → 동기화라면 path 가 바뀔 것
  await sleep(150)
  const afterBranch = await pathValue()
  const derivedIfSynced = `${worktreesDir}/feature-foo-bar`
  record('manual-priority', {
    editedPath: edited,
    afterMoreBranch: afterBranch,
    unchanged: afterBranch === edited,
    didNotResync: afterBranch !== derivedIfSynced,
    ok: afterBranch === edited && afterBranch !== derivedIfSynced,
  })

  const shot = await app.shot('g6-modal', '[data-create-worktree-modal]')
  out.shot = shot.file

  // 실제로 만들지 않고 취소 (앱 정리)
  await app.click('[data-create-worktree-cancel]').catch(() => {})

  out.verdict = out.steps.every((s) => s.ok) ? 'PASS' : 'FAIL'
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}
writeRaw('g6-visual.json', out)
console.log('\nG6-visual:', out.verdict)
if (out.verdict !== 'PASS') process.exitCode = 1
