// LIFE-603 최종 관문 C8 — 사용자 repos.json **사본** 무손실 1회. 원본은 읽기만(복사 전후 sha 대조), 쓰기는 사본 폴더에서만.
//   app/ 에서: node_modules/.bin/tsx scripts/l603/repos-copy.mts <원본 repos.json> <사본 폴더=/tmp/l603g-*/...>
// 사본에 새 코드(`RepoRegistry` + `WorkLinks.saveExplicit`)로 링크 하나를 쓰고, 기존 키(repos · setups · worktrees 의 각 칸 · 그 밖 최상위 키)가
// 그대로인지 깊은 비교한다. 출력은 개수 · sha 앞 16자 · 다른 키 이름만(경로 원문을 남기지 않는다 — worktree 는 순번으로).
// exit 0 = 무손실 · 1 = 다른 키 있음 · 2 = 인자 · 원본 바뀜 · 읽기 실패.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { RepoRegistry } from '../../src/main/registry.js'
import { WorkLinks } from '../../src/main/work/links.js'

const [source, dest] = process.argv.slice(2)
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
if (!source || !dest?.startsWith('/tmp/l603g-')) { console.log(JSON.stringify({ ok: false, code: 'usage' })); process.exit(2) }
const sourceSha = sha(source)
fs.mkdirSync(dest, { recursive: true })
const copy = path.join(dest, 'repos.json')
fs.copyFileSync(source, copy)
delete process.env.CORRAL_REGISTRY
const before = JSON.parse(fs.readFileSync(copy, 'utf8'))
const paths = Object.keys(before.worktrees ?? {})
const target = paths[0]
if (target === undefined) { console.log(JSON.stringify({ ok: false, code: 'no_worktrees' })); process.exit(2) }
const link = { sourceId: 'mock-jira', connectionId: 'gate-c8', key: 'GATE-1', itemId: 'gate-item', linkedAt: 1 }
const links = new WorkLinks({ registry: () => new RepoRegistry(dest), work: () => null, log: () => {} })
const saved = links.saveExplicit({ path: target, link })
const after = JSON.parse(fs.readFileSync(copy, 'utf8'))
const differ: string[] = []
for (const key of Object.keys(before)) if (key !== 'worktrees' && !isDeepStrictEqual(before[key], after[key])) differ.push(key)
paths.forEach((entry, index) => {
  const was = before.worktrees[entry]
  const now = after.worktrees?.[entry]
  for (const field of Object.keys(was)) if (!isDeepStrictEqual(was[field], now?.[field])) differ.push(`worktrees[${index}].${field}`)
})
const added = Object.keys(after.worktrees?.[target] ?? {}).filter((field) => !(field in before.worktrees[target]))
const sourceAfter = sha(source)
console.log(JSON.stringify({
  ok: differ.length === 0 && sourceAfter === sourceSha && saved === true,
  saved, version: before.version ?? null, topKeys: Object.keys(before), repos: Array.isArray(before.repos) ? before.repos.length : null, worktrees: paths.length,
  differ, addedOnTarget: added, linkOnTarget: isDeepStrictEqual(after.worktrees?.[target]?.workLink, link),
  sourceSha, sourceShaAfter: sourceAfter, copyShaBefore: createHash('sha256').update(JSON.stringify(before)).digest('hex').slice(0, 16), copyShaAfter: sha(copy),
}))
process.exit(sourceAfter !== sourceSha ? 2 : differ.length === 0 ? 0 : 1)
