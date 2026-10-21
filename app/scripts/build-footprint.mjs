// LIFE-676 — Resource Manager 메모리 도우미(`helper/corral-footprint.c`)를 `build/helper/corral-footprint` 로 빌드한다.
// `npm run dev`(predev)·`npm run package:mac` 이 부른다. 빌드 산출물은 커밋하지 않는다(.gitignore `app/build/helper/`).
//
// `--check` = 빌드하지 않고 이미 있는 산출물만 확인한다 — package:mac 이 electron-builder 직전에 부른다.
// 실패하면 종료코드 1 — package:mac 은 electron-builder 전에 멈춘다(bundle-herdr 와 같은 규칙, R8ⓐ).
// 빌드 뒤 실행 비트·한 번 실행(첫 줄이 `pid 바이트` 모양)까지 확인한다 — 「있지만 못 도는」 도우미를 싣지 않는다.
// ad-hoc 서명(`codesign -s -`): arm64 는 서명 없는 실행 파일을 띄우지 않는다. 설치본은 electron-builder 가 다시 서명한다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const source = path.join(app, 'helper/corral-footprint.c')
const out = path.join(app, 'build/helper/corral-footprint')
const fail = (message) => {
  console.error(`build-footprint: ${message}`)
  process.exit(1)
}
const check = process.argv.includes('--check')
if (!check) {
  if (!fs.existsSync(source)) fail(`소스가 없다 (${source})`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.rmSync(out, { force: true })
  try {
    execFileSync('clang', ['-O2', '-Wall', '-Werror', '-arch', 'arm64', '-mmacosx-version-min=12.0', '-o', out, source], { stdio: 'inherit' })
    execFileSync('codesign', ['-s', '-', '-f', out], { stdio: 'inherit' })
  } catch (error) {
    fail(`빌드 실패 — ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (!fs.existsSync(out)) fail(`도우미가 없다 (${out}) — npm run build:footprint 로 빌드한다`)
if ((fs.statSync(out).mode & 0o111) === 0) fail(`실행 비트가 없다 (${out})`)
let first = ''
try {
  first = execFileSync(out, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).split('\n')[0] ?? ''
} catch (error) {
  fail(`한 번 실행에 실패했다 — ${error instanceof Error ? error.message : String(error)}`)
}
if (!/^\d+ (\d+|ERR \d+)$/.test(first)) fail(`출력 모양이 다르다: ${JSON.stringify(first)}`)
console.log(`build-footprint${check ? ' --check' : ''}: ${path.relative(app, out)} ${createHash('sha256').update(fs.readFileSync(out)).digest('hex')}`)
