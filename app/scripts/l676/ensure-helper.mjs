// LIFE-676 최종 관문 하네스 공통 — 시작할 때 도우미가 있는지 보고, 없으면 빌드한다(r2 C2-6③: 637 하네스처럼 predev 를 건너뛰면
// 도우미가 없어 전부 `측정 불가` 로 조용히 나온다). 경로·sha256 을 돌려줘 각 하네스가 원자료에 찍는다.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const HELPER = path.join(APP, 'build', 'helper', 'corral-footprint')

export function ensureHelper() {
  const check = spawnSync(process.execPath, [path.join(APP, 'scripts', 'build-footprint.mjs'), '--check'], { encoding: 'utf8' })
  let built = false
  if (check.status !== 0) {
    execFileSync(process.execPath, [path.join(APP, 'scripts', 'build-footprint.mjs')], { stdio: 'inherit' })
    built = true
  }
  return { path: HELPER, sha256: createHash('sha256').update(fs.readFileSync(HELPER)).digest('hex'), built, check: (check.stdout + check.stderr).trim() }
}

/** 제품 TS 모듈을 esbuild 로 메모리에서 번들해 불러온다(electron 은 하네스 스텁). 하네스가 제품 코드 그 자체를 돌린다. */
export async function loadProduct(entry) {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [path.join(APP, entry)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    alias: { electron: path.join(APP, 'scripts', 'l676', 'electron-stub.mjs') },
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
