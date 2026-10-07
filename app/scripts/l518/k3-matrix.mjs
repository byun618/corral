// LIFE-518 K3ⓕ — 같은 대조 묶음을 **기준 검사기와 지금 검사기로 모두** 돌려 칸별 전후 행렬을 낸다.
// 사용: node scripts/l518/k3-matrix.mjs <out.md> [기준 commit]   (app/ 에서. 기준 기본값 = 게이트 ⓪ 기준 commit)
// 판정: 기준에서 잡히고 지금 안 잡히는 칸이 전부 flip(K3ⓔ ①·②) 표시 칸이고, 그 밖의 칸은 둘 다 기대대로여야 한다.
// 실제 src/ 는 건드리지 않는다(boundary-probes.mjs 머리) — 그래도 G6 근거로 전후 `git status --porcelain` 을 싣는다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, PROBES, runProbes } from './boundary-probes.mjs'

const [outFile, base = 'e92e66da5887b5e09fcf18232309881263f0adee'] = process.argv.slice(2)
if (!outFile) {
  console.error('사용: node scripts/l518/k3-matrix.mjs <out.md> [기준 commit]')
  process.exit(2)
}
const git = (...args) => execFileSync('git', args, { cwd: APP_DIR, encoding: 'utf8' })

const statusBefore = git('status', '--porcelain')
const baseChecker = git('show', `${base}:app/scripts/check-boundary.mjs`)
const headChecker = fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8')
const before = runProbes(baseChecker)
const after = runProbes(headChecker)
const statusAfter = git('status', '--porcelain')

const rows = PROBES.map((probe, index) => {
  const b = before.cells[index]
  const a = after.cells[index]
  // 기대: 양성 대조는 지금 검사기가 잡는다. 음성(expect null)은 지금 검사기가 안 잡는다.
  const headOk = probe.expect === null ? !a.caught : a.caught
  const flipped = b.caught && !a.caught
  const flipAllowed = !flipped || probe.flip !== undefined
  return { probe, b, a, headOk, flipped, flipAllowed }
})
const bad = rows.filter((row) => !row.headOk || !row.flipAllowed)
const show = (cell) => `${cell.caught ? '잡음' : '안 잡음'} (exit ${cell.exit}${cell.rules.length ? ` · ${cell.rules.join(',')}` : ''})`

const lines = [
  `# LIFE-518 K3 전후 검출 행렬`,
  '',
  `- HEAD ${git('rev-parse', 'HEAD').trim()} · node ${process.version} · TMPDIR ${process.env.TMPDIR ?? '(없음)'}`,
  `- 기준 검사기 = \`git show ${base}:app/scripts/check-boundary.mjs\` · 지금 검사기 = 작업 트리 \`scripts/check-boundary.mjs\``,
  `- 깨끗한 src 복사본: 기준 exit ${before.clean.exit} · 위반 ${before.clean.위반} · 파일 ${before.clean.파일수} / 지금 exit ${after.clean.exit} · 위반 ${after.clean.위반} · 파일 ${after.clean.파일수}`,
  `- 대조 ${PROBES.length}칸 · 지금 검사기 기대 불일치 ${rows.filter((row) => !row.headOk).length} · 허용 밖 뒤집힘 ${rows.filter((row) => !row.flipAllowed).length} · 허용된 뒤집힘(ⓔ) ${rows.filter((row) => row.flipped && row.flipAllowed).length}`,
  '',
  '| 칸 | 소항목 | 대조 파일 | 기대(지금) | 기준 검사기 | 지금 검사기 | 뒤집힘 | 판정 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(({ probe, b, a, headOk, flipped, flipAllowed }) =>
    `| ${probe.id} | ${probe.group} | \`${probe.file}\` | ${probe.expect ?? '위반 0'} | ${show(b)} | ${show(a)} | ${flipped ? `예 — ${probe.flip ?? '허용 밖'}` : '아니오'} | ${headOk && flipAllowed ? '통과' : '미달'} |`),
  '',
  '## 대조 원문·토큰',
  '',
  ...rows.flatMap(({ probe, b, a }) => [
    `### ${probe.id}`,
    '```ts',
    probe.source.trimEnd(),
    '```',
    `- 기준 토큰: ${JSON.stringify(b.tokens)} · 지금 토큰: ${JSON.stringify(a.tokens)}`,
    '',
  ]),
  '## G6 — 실행 전후 git status --porcelain',
  '',
  `- 전 (${statusBefore.split('\n').filter(Boolean).length}줄):`,
  '```',
  statusBefore.trimEnd(),
  '```',
  `- 후 (${statusAfter.split('\n').filter(Boolean).length}줄):`,
  '```',
  statusAfter.trimEnd(),
  '```',
  `- 같은가: ${statusBefore === statusAfter}`,
  '',
  `판정: ${bad.length === 0 && statusBefore === statusAfter ? '통과' : '미달'}`,
]
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
fs.writeFileSync(outFile, lines.join('\n') + '\n')
console.log(`wrote ${outFile} — 미달 칸 ${bad.length}${bad.length ? `: ${bad.map((row) => row.probe.id).join(', ')}` : ''} · G6 ${statusBefore === statusAfter ? '같음' : '다름'}`)
process.exit(bad.length === 0 && statusBefore === statusAfter ? 0 : 1)
