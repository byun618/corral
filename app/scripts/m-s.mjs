// S2 · S3 · S4 — 프로덕션 빌드 · 렌더러 격리 · 타입체크/린트.
//
// S3 는 **설정 파일만 보여 주는 것으로는 통과가 아니다.** 렌더러 컨텍스트에서 실제로 접근을
// 시도한 결과를 로그로 남긴다 (app/src/renderer/src/SecurityProbe.tsx 가 마운트 때 실행).

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { APP_DIR, startApp, tidySession, writeRaw } from './lib.mjs'

const run = promisify(execFile)
const exec = (cmd) => run('/bin/sh', ['-c', cmd], { cwd: APP_DIR, maxBuffer: 8 * 1024 * 1024 })

async function capture(label, cmd) {
  const started = Date.now()
  try {
    const { stdout, stderr } = await exec(cmd)
    return { label, cmd, exitCode: 0, ms: Date.now() - started, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    return {
      label,
      cmd,
      exitCode: error.code ?? 1,
      ms: Date.now() - started,
      stdout: (error.stdout ?? '').trim(),
      stderr: (error.stderr ?? '').trim(),
    }
  }
}

// --- S2 프로덕션 빌드 -----------------------------------------------------
await exec('rm -rf out')
const build = await capture('npm run build', 'npm run build 2>&1')
const listing = await capture('build artifacts', 'ls -la out out/main out/preload out/renderer 2>&1')
const artifacts = ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map((file) => ({
  file,
  exists: fs.existsSync(path.join(APP_DIR, file)),
  bytes: fs.existsSync(path.join(APP_DIR, file)) ? fs.statSync(path.join(APP_DIR, file)).size : null,
}))

// --- S4 타입체크 · 린트 ---------------------------------------------------
const typecheck = await capture('npm run typecheck', 'npm run typecheck 2>&1')
const lint = await capture('npm run lint', 'npm run lint 2>&1; echo "exit=$?"')

// --- S3 렌더러 격리 (실행 중 확인) ---------------------------------------
await tidySession()
const app = await startApp({ name: 's3' })
const probe = app.entries().find((entry) => entry.tag === 'renderer.probe') ?? null
await app.shot('s3-renderer-probes')
await app.stop()

const source = fs.readFileSync(path.join(APP_DIR, 'src/main/index.ts'), 'utf8')
const webPreferences = source.slice(source.indexOf('webPreferences'), source.indexOf('})\n\n  window.on'))

const result = {
  measuredAt: new Date().toISOString(),
  s2: { build, listing, artifacts, allArtifactsExist: artifacts.every((item) => item.exists) },
  s4: { typecheck, lint, lintConfigured: fs.existsSync(path.join(APP_DIR, 'eslint.config.mjs')) },
  s3: {
    webPreferencesSource: webPreferences.trim(),
    rendererRuntimeProbe: probe,
    // process 가 아예 undefined 라 process.binding 에는 닿을 수도 없다 — require 는 직접 시도했다.
    interpretation: {
      requireBlocked: probe?.require !== undefined && String(probe.require).startsWith('undefined'),
      processUndefined: probe?.process === 'undefined',
      moduleUndefined: probe?.module === 'undefined',
      bufferUndefined: probe?.Buffer === 'undefined',
      ipcRendererNotExposed: probe?.ipcRenderer === 'undefined',
      bridgeObjectPresent: probe?.['window.corral'] === 'object',
      preloadSandboxed: probe?.['preload.sandboxed'] === 'true',
      preloadContextIsolated: probe?.['preload.contextIsolated'] === 'true',
      exposedMethods: (probe?.exposed ?? '').split(','),
    },
  },
}

writeRaw('11-s2s3s4-app-shell.json', result)
writeRaw(
  '11-s2-build.txt',
  `# S2 — 프로덕션 빌드 (cwd: app/)\n\n$ npm run build\n${build.stdout}\n(exit ${build.exitCode})\n\n$ ls -la out …\n${listing.stdout}\n`,
)
writeRaw(
  '11-s4-typecheck-lint.txt',
  `# S4 — 타입체크 · 린트 (cwd: app/)\n\n$ npm run typecheck\n${typecheck.stdout}\n(exit ${typecheck.exitCode})\n\n$ npm run lint\n${lint.stdout}\n`,
)
console.log(
  JSON.stringify(
    {
      buildExit: build.exitCode,
      artifacts: result.s2.allArtifactsExist,
      typecheckExit: typecheck.exitCode,
      lintOut: lint.stdout.split('\n').slice(-1)[0],
      s3: result.s3.interpretation,
    },
    null,
    2,
  ),
)
