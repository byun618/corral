// 3차 스파이크 공용 — 2차 하네스(spike2/lib.mjs)를 그대로 쓰되 원자료 경로만 raw/spike3 로 돌린다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export * from '../spike2/lib.mjs'
import { APP_DIR, REPO_DIR } from '../spike2/lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RAW3 = path.join(REPO_DIR, 'specs/LIFE-373-mru-pane-split/raw/spike3')

export function writeRaw3(file, content) {
  const target = path.join(RAW3, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  console.log('wrote', path.relative(REPO_DIR, target))
  return target
}

/** 벤더 endpoint 클라이언트 + 입력 분류기를 한 번에 묶어 import (본체와 같은 코드 경로). */
export async function loadVendor() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l373s3-')), 'vendor.mjs')
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    path.join(HERE, 'vendor-entry.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${out}`,
  ])
  return await import(out)
}
