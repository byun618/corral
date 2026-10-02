// LIFE-478 빌드 신원 (리뷰 r1 C-01ⓑ·C-05) — 격리 회차가 **어느 소스·어느 번들**로 돌았는지 result.json 에 남긴다.
// HEAD · 작업 트리 변경 여부(app/src·app/scripts) · `app/out` 번들 해시(파일 경로+내용, 정렬) · 가장 새 소스/번들 mtime.
// 번들이 소스보다 오래됐으면(`stale`) 그 회차는 마지막 소스를 잰 것이 아니다.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])) : [])

export function buildIdentity(appRoot) {
  const git = (...args) => execFileSync('git', args, { cwd: appRoot, encoding: 'utf8' }).trim()
  const outFiles = walk(path.join(appRoot, 'out')).sort()
  const hash = crypto.createHash('sha256')
  for (const file of outFiles) hash.update(path.relative(appRoot, file)).update('\0').update(fs.readFileSync(file)).update('\0')
  const newest = (files) => files.reduce((max, file) => Math.max(max, fs.statSync(file).mtimeMs), 0)
  const srcNewest = newest(walk(path.join(appRoot, 'src')))
  const outNewest = newest(outFiles)
  return {
    head: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', 'src', 'scripts') !== '',
    outFiles: outFiles.length,
    outSha256: hash.digest('hex'),
    srcNewestMtime: new Date(srcNewest).toISOString(),
    outNewestMtime: outFiles.length === 0 ? null : new Date(outNewest).toISOString(),
    stale: outFiles.length === 0 || outNewest < srcNewest,
  }
}

// 단독 실행: node build-identity.mjs <app 루트> → 표준 출력에 JSON
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) console.log(JSON.stringify(buildIdentity(path.resolve(process.argv[2] ?? '.')), null, 2))
