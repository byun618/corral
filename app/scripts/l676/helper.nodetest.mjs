// LIFE-676 리뷰 r3 C3-2 — C 도우미(`helper/corral-footprint.c`) 자동 회귀.
//   ① clang 이 있으면 `-DINITIAL_CAPACITY=2` 시험 빌드(임시 경로) → pid 목록이 4번 모두 버퍼를 채워 exit 2 · stdout 0줄(잘린 표를 내지 않는다, C2-2)
//   ② 제품 빌드 도우미(`build/helper/corral-footprint`)의 실제 출력 1회 → 제품 파서 `parseFootprintTable` 이 `ok`
// clang·도우미가 없으면 skip(사유 출력). 파서는 TS 소스를 esbuild 로 메모리에서 번들해 쓴다(앱 의존성의 esbuild). 임시 산출은 지운다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = path.join(app, 'helper', 'corral-footprint.c')
const product = path.join(app, 'build', 'helper', 'corral-footprint')
const hasClang = spawnSync('clang', ['--version'], { encoding: 'utf8' }).status === 0

test('C2-2 절단 경로 — INITIAL_CAPACITY=2 시험 빌드는 exit 2 · stdout 0줄', { skip: hasClang ? false : 'clang 이 없다 — 시험 빌드를 못 한다' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l676-helper-'))
  try {
    const out = path.join(dir, 'fp-cap2')
    const build = spawnSync('clang', ['-O2', '-Wall', '-Werror', '-arch', 'arm64', '-DINITIAL_CAPACITY=2', '-o', out, source], { encoding: 'utf8' })
    assert.equal(build.status, 0, build.stderr)
    const run = spawnSync(out, { encoding: 'utf8', timeout: 10_000 })
    assert.equal(run.status, 2, `stdout=${run.stdout.slice(0, 200)} stderr=${run.stderr}`)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /잘린 표를 내지 않는다/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('제품 빌드 도우미 실제 출력 1회 → parseFootprintTable ok', { skip: fs.existsSync(product) ? false : `도우미가 없다 (${product}) — npm run build:footprint 뒤에 돈다` }, async () => {
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [path.join(app, 'src', 'main', 'resource-collector.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const code = bundle.outputFiles[0]?.text ?? ''
  const { parseFootprintTable } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const run = spawnSync(product, { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(run.status, 0, run.stderr)
  const table = parseFootprintTable(run.stdout)
  assert.equal(table.kind, 'ok', JSON.stringify(table).slice(0, 200))
  // 이 시험 프로세스 자신(같은 사용자)은 읽혀야 한다.
  assert.ok(table.bytes.has(process.pid), `pid ${process.pid} 가 성공 표에 없다`)
})
