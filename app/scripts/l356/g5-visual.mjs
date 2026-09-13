// G5 눈확인 (측정 아님) — 긴 경로 레포를 붙여 사이드바 조작 버튼이 잘리지 않는지 스샷 1장.
// 격리 세션 life356-claude. 긴 경로를 강제로 만들어(중첩 디렉터리) 결함 조건을 재현한다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, until, writeRaw } from './lib.mjs'

// 아주 긴 경로의 레포를 만든다 — 결함(버튼 밀림)이 나오는 조건.
function makeLongPathRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l356-g5-'))
  const deep = path.join(base, 'organization-workspace', 'very-long-monorepo-name-that-overflows-the-sidebar', 'packages', 'feature-service-implementation')
  fs.mkdirSync(deep, { recursive: true })
  execFileSync('git', ['init', '-b', 'feature/LIFE-356-a-deliberately-long-branch-name-to-test-overflow', deep])
  fs.writeFileSync(path.join(deep, 'README.md'), 'g5\n')
  execFileSync('git', ['-C', deep, 'add', 'README.md'])
  execFileSync('git', ['-C', deep, '-c', 'user.email=l356@test', '-c', 'user.name=l356', 'commit', '-m', 'init'])
  return fs.realpathSync(deep)
}

const app = await startApp({ name: 'g5-visual' })
const out = { at: new Date().toISOString(), ready: app.ready }
try {
  const root = makeLongPathRepo()
  out.repoRoot = root
  await app.addRepo(root)
  await until(async () => (await app.query(`[data-repo="${root}"]`)).found.length > 0, { what: 'repo row' })

  // 조작 버튼이 실제로 뷰포트 안에 있는지 DOM 으로 검증 (스샷과 별개의 객관 증거).
  const geom = await app.query(`[data-repo="${root}"]`)
  const createBtn = await app.query(`[data-create-worktree="${root}"]`)
  const removeBtn = await app.query(`[data-remove-repo="${root}"]`)
  const openBtn = await app.query(`[data-open-worktree="${root}"]`)
  const rects = { list: geom, create: createBtn, remove: removeBtn, open: openBtn }
  out.query = rects

  // 좌표 클릭으로 버튼 도달성 확인 — hit:true 면 화면 안에 보이고 눌린다(잘리지 않음).
  const createHit = await app.click(`[data-create-worktree="${root}"]`)
  out.createReachable = createHit.hit === true
  // 모달이 떴으면 닫는다(esc 대신 취소 버튼).
  await app.key('Escape').catch(() => {})

  const removeHit = await app.click(`[data-remove-repo="${root}"]`)
  out.removeReachable = removeHit.hit === true
  await app.key('Escape').catch(() => {})

  const shot = await app.shot('g5-sidebar')
  out.shot = shot.file

  out.verdict = out.createReachable && out.removeReachable ? 'PASS' : 'FAIL'
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}
writeRaw('g5-visual.json', out)
console.log('\nG5-visual:', out.verdict, JSON.stringify({ create: out.createReachable, remove: out.removeReachable, shot: out.shot }))
if (out.verdict !== 'PASS') process.exitCode = 1
