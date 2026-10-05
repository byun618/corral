// LIFE-512 K3ⓑ — 내장 테마 30개 기계 대조. Orca 198 원본 파일을 **직접 읽어** corral 이식본과 이름·칸·값을 비교한다(차이 0 이 통과).
// 두 가지를 본다: ① 모듈을 실제로 불러 만든 카탈로그 값(이름 30·테마마다 22칸 값 동일) ② 파일 본문(머리 주석 3줄·import `.js` 꼬리를 뺀 나머지 바이트 동일).
// 사용: npx tsx scripts/l512/theme-parity.mjs --orca /tmp/l443/orca-198 --out <raw 폴더> [--ledger <runs.md>]
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const orcaRoot = path.resolve(args.orca ?? '/tmp/l443/orca-198')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const command = `npx tsx app/scripts/l512/theme-parity.mjs ${process.argv.slice(2).join(' ')}`
const criterion = 'K3ⓑ 테마 30개 기계 대조'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const rawRel = ledger ? path.relative(path.resolve(ledger, '../../../../..'), out) : out
const runId = ledger ? beginRun(ledger, { criterion, command, expectedExit: 0, raw: rawRel }) : null

const here = path.dirname(new URL(import.meta.url).pathname)
const oursDir = path.resolve(here, '../../src/shared/terminal-themes')
const orcaDir = path.join(orcaRoot, 'src/renderer/src/lib/terminal-themes')
const FILES = ['types', 'shared', 'index', 'defaults', 'popular-dark', 'popular-dark-core', 'popular-dark-extended', 'popular-light', 'classic']

const result = { orcaRoot, orcaHead: null, oursDir, startedAt: new Date().toISOString(), files: [], names: {}, valueDiffs: [], exitCode: 0 }
let exitCode = 0
try {
  try { result.orcaHead = fs.readFileSync(path.join(orcaRoot, '.git/HEAD'), 'utf8').trim() } catch { result.orcaHead = '(.git/HEAD 없음)' }
  // ② 파일 본문 — 머리 주석 3줄을 빼고 import 꼬리 `.js` 를 지운 뒤 원본과 바이트 비교.
  for (const name of FILES) {
    const orca = fs.readFileSync(path.join(orcaDir, `${name}.ts`), 'utf8')
    const oursRaw = fs.readFileSync(path.join(oursDir, `${name}.ts`), 'utf8')
    const ours = oursRaw.split('\n').slice(3).join('\n').replace(/from '(\.\/[a-z-]+)\.js'/g, "from '$1'")
    result.files.push({ file: `${name}.ts`, identical: ours === orca, orcaBytes: orca.length, oursBytes: oursRaw.length })
  }
  // ① 카탈로그 값.
  const orcaCatalog = (await import(pathToFileURL(path.join(orcaDir, 'index.ts')).href)).TERMINAL_THEME_CATALOG
  const oursCatalog = (await import(pathToFileURL(path.join(oursDir, 'index.ts')).href)).TERMINAL_THEME_CATALOG
  const orcaNames = Object.keys(orcaCatalog)
  const oursNames = Object.keys(oursCatalog)
  result.names = { orcaCount: orcaNames.length, oursCount: oursNames.length, sameOrder: JSON.stringify(orcaNames) === JSON.stringify(oursNames), missing: orcaNames.filter((n) => !oursNames.includes(n)), extra: oursNames.filter((n) => !orcaNames.includes(n)), list: oursNames }
  let fieldCount = 0
  for (const name of orcaNames) {
    const a = orcaCatalog[name]
    const b = oursCatalog[name] ?? {}
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      fieldCount += 1
      if (a[key] !== b[key]) result.valueDiffs.push({ theme: name, key, orca: a[key] ?? null, ours: b[key] ?? null })
    }
  }
  result.fieldCount = fieldCount
  result.fieldsPerTheme = Object.fromEntries(oursNames.map((n) => [n, Object.keys(oursCatalog[n]).length]))
  const pass = result.names.orcaCount === 30 && result.names.oursCount === 30 && result.names.missing.length === 0 && result.names.extra.length === 0 && result.valueDiffs.length === 0 && result.files.every((f) => f.identical) && Object.values(result.fieldsPerTheme).every((n) => n === 22)
  exitCode = pass ? 0 : 1
  console.log(`[parity] 이름 ${result.names.oursCount}/${result.names.orcaCount} · 칸 ${fieldCount} · 값 차이 ${result.valueDiffs.length} · 파일 동일 ${result.files.filter((f) => f.identical).length}/${FILES.length} → ${pass ? '통과' : '실패'}`)
} catch (error) {
  exitCode = 2
  result.error = String(error?.stack ?? error)
  console.log('[parity] 오류', result.error)
}
result.exitCode = exitCode
result.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(out, 'theme-parity.json'), `${JSON.stringify(result, null, 1)}\n`)
if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: exitCode, raw: rawRel, result: exitCode === 0 ? '통과' : '실패' })
process.exit(exitCode)
