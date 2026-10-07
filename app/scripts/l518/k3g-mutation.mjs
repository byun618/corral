// LIFE-518 K3ⓖ 양성 대조 — check-boundary.nodetest.mjs 의 판정식이 **약해진 검사기를 실제로 떨어뜨리는지** 본다.
// 검사기 원문을 메모리에서 바꿔 runProbes 에 넣는다(작업 트리 무변경). 각 변이마다 nodetest 와 같은 판정식으로 틀린 칸을 센다.
// 사용: node scripts/l518/k3g-mutation.mjs — 모든 변이가 1칸 이상 틀려야 exit 0.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, PROBES, runProbes } from './boundary-probes.mjs'

const head = fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8')
const replaceOnce = (source, from, to) => {
  if (!source.includes(from)) throw new Error(`변이 지점 없음: ${from}`)
  return source.replace(from, to)
}
const MUTANTS = [
  { 이름: '기준 검사기(e92e66da) — 오탐 7파일·IPC 오탐', source: execFileSync('git', ['show', 'e92e66da:app/scripts/check-boundary.mjs'], { cwd: APP_DIR, encoding: 'utf8' }) },
  { 이름: '액션 id 면제를 envelope 자리에서도 적용', source: replaceOnce(head, "if (ACTION_IDS.has(name) && !ENVELOPE_BEFORE.test(before)) return 'action-id'", "if (ACTION_IDS.has(name)) return 'action-id'") },
  { 이름: '로그 태그 면제를 실제 herdr 메서드에도 적용', source: replaceOnce(head, '&& !HERDR_METHODS.has(name) &&', '&&') },
  { 이름: '메서드 지문 면제 전부(모든 메서드 토큰 통과)', source: replaceOnce(head, 'function methodExemption({ source, index, name, zone, importsMainLog }) {', "function methodExemption({ source, index, name, zone, importsMainLog }) {\n  return 'action-id'") },
  { 이름: 'IPC 검사를 늘 참으로', source: replaceOnce(head, 'const ipcTypesFromShared = ipcTypeImports.every(', 'const ipcTypesFromShared = true || ipcTypeImports.every(') },
  { 이름: '닫는 따옴표 앞 역슬래시 허용 제거', source: replaceOnce(head, "layout\\.\\w+)\\\\?['\"`]/g", "layout\\.\\w+)['\"`]/g") },
]

let allFailed = true
for (const mutant of MUTANTS) {
  const { clean, cells } = runProbes(mutant.source)
  const wrong = PROBES.flatMap((probe, index) => {
    const cell = cells[index]
    const ok = probe.expect === null ? !cell.caught && cell.exit === 0 : cell.caught && cell.exit === 1
    return ok ? [] : [probe.id]
  })
  const cleanWrong = !(clean.exit === 0 && clean.위반 === 0 && clean.ipc === true)
  const failed = cleanWrong || wrong.length > 0
  allFailed &&= failed
  console.log(`${failed ? '떨어짐' : '통과(!)'} — ${mutant.이름} · 깨끗한 src exit ${clean.exit} 위반 ${clean.위반} IPC ${clean.ipc} · 틀린 칸 ${wrong.length}: ${wrong.join(', ')}`)
}
console.log(`판정: ${allFailed ? '모든 변이가 nodetest 판정식에서 떨어진다' : '떨어지지 않은 변이가 있다'}`)
process.exit(allFailed ? 0 : 1)
