// LIFE-834 — 음성 받아쓰기 도우미(`helper/corral-dictation.swift`)를 `build/helper/corral-dictation` 으로 빌드한다. `build-footprint.mjs` 전례.
// `npm run build:dictation`·`npm run package:mac`(electron-builder 직전 — 빌드 실패·확인 실패면 거기서 멈춘다)이 부른다. 빌드 산출물은 커밋하지 않는다(.gitignore `app/build/helper/`).
//
// `--check` = 빌드하지 않고 이미 있는 산출물만 확인한다. 빌드한 뒤에도 같은 확인을 한다. 실패하면 종료코드 1.
// 확인 = 실행 비트 + `--check` 한 번 실행(마이크를 열지 않는다 — 권한 창도 없다)의 첫 줄이 `{"type":"check",…}` 모양 — 「있지만 못 도는」 도우미를 싣지 않는다.
// ad-hoc 서명(`codesign -s -`): arm64 는 서명 없는 실행 파일을 띄우지 않는다. 설치본은 electron-builder 가 다시 서명한다.
// SpeechAnalyzer 는 macOS 26 API 라 최소 버전 26 으로 빌드한다 — 그 아래 OS 는 main 이 띄우기 전에 거른다(`dictationSupport`).
//
// `npm run dev`·`npm run build` 는 이 스크립트를 부르지 않는다(predev 는 footprint 만) — swiftc·macOS 26 SDK 가 없는 기계에서도 dev 가 그대로 뜨고,
// 받아쓰기만 「도우미 없음」 알림으로 막힌다. 받아쓰기를 dev 에서 쓰려면 `npm run build:dictation` 을 한 번 돌린다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const source = path.join(app, 'helper/corral-dictation.swift')
const out = path.join(app, 'build/helper/corral-dictation')
const fail = (message) => {
  console.error(`build-dictation: ${message}`)
  process.exit(1)
}
const check = process.argv.includes('--check')
if (!check) {
  if (!fs.existsSync(source)) fail(`소스가 없다 (${source})`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.rmSync(out, { force: true })
  try {
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macos26.0', '-o', out, source], { stdio: 'inherit' })
    execFileSync('codesign', ['-s', '-', '-f', out], { stdio: 'inherit' })
  } catch (error) {
    fail(`빌드 실패 — ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (!fs.existsSync(out)) fail(`도우미가 없다 (${out}) — npm run build:dictation 으로 빌드한다`)
if ((fs.statSync(out).mode & 0o111) === 0) fail(`실행 비트가 없다 (${out})`)
let first = ''
try {
  first = execFileSync(out, ['--check'], { encoding: 'utf8', timeout: 15000 }).split('\n')[0] ?? ''
} catch (error) {
  fail(`--check 실행에 실패했다 — ${error instanceof Error ? error.message : String(error)}`)
}
let parsed = null
try {
  parsed = JSON.parse(first)
} catch {
  parsed = null
}
if (parsed === null || typeof parsed !== 'object' || parsed.type !== 'check') fail(`--check 출력 모양이 다르다: ${JSON.stringify(first)}`)
console.log(`build-dictation${check ? ' --check' : ''}: ${path.relative(app, out)} ${createHash('sha256').update(fs.readFileSync(out)).digest('hex')} ${first}`)
