// LIFE-469 K8 — 폴더 파일 목록 + 해시(원복 대조용). 사용: node native-manifest.mjs <폴더> [--top]
// `--top` = 최상위 파일만(하위 폴더 제외). 소켓·파이프는 건너뛴다. 큰 파일도 전부 해시한다(원복은 바이트 대조).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [dir, flag] = process.argv.slice(2)
const top = flag === '--top'
const files = {}
const walk = (current) => {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) {
      if (!top) walk(full)
      continue
    }
    if (!entry.isFile()) continue
    const data = fs.readFileSync(full)
    files[path.relative(dir, full)] = { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
  }
}
walk(dir)
console.log(JSON.stringify({ dir, top, count: Object.keys(files).length, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }, null, 1))
