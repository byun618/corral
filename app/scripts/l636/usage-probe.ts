// LIFE-636 창 없는 사용량 진입점 — 실제 자격 증명으로 수집기를 provider 마다 1회 부른다(E11 판정 회차·개발 중 형태 확인).
// 실행: `npx tsx scripts/l636/usage-probe.ts [claude,codex,grok] > out.json` (app/ 에서). 토큰·계정 값은 출력하지 않는다.
//
// 계측(E6ⓔ): ① 수집기 deps 를 감싸 읽기 호출(파일 경로·키체인 service/account·HTTP URL·헤더 **이름**)을 기록
// ② 같은 프로세스의 `fs` 쓰기 계열·`child_process` 실행을 감싸 자격 증명 경로·키체인 쓰기 명령이 있었는지 센다.
// 한계: ② 는 `fs`·`fs.promises`·`child_process` 기본 export 객체의 속성을 바꾸고 `syncBuiltinESMExports` 로 named import 에 반영한다 —
// 그 밖의 경로(네이티브 모듈 등)는 보지 못한다. 수집기 코드는 동적 import 라 패치 뒤에 읽힌다.
import fs from 'node:fs'
import childProcess from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import type { CollectorDeps } from '../../src/main/usage/collector.js'

const only = (process.argv[2] ?? '').split(',').filter((id) => id !== '')
const home = os.homedir()
// 수집기와 같은 환경변수를 따른다(r2 R2-4) — 기본 경로도 함께 센다(환경변수로 옮겨도 기본 경로 쓰기는 여전히 위반).
const envDir = (name: string): string[] => { const value = process.env[name]; return value !== undefined && value !== '' ? [value] : [] }
const credentialPaths = [path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.grok'), ...envDir('CLAUDE_CONFIG_DIR'), ...envDir('CODEX_HOME'), ...envDir('GROK_HOME')]
const writes: { api: string; target: string }[] = []
const spawns: { api: string; file: string; args: string[] }[] = []

function touchesCredentials(target: unknown): boolean {
  return typeof target === 'string' && credentialPaths.some((dir) => target.startsWith(dir))
}
function wrap(holder: object, name: string, label: string, isWrite: (args: unknown[]) => boolean): void {
  const original: unknown = Reflect.get(holder, name)
  if (typeof original !== 'function') return
  Reflect.set(holder, name, (...args: unknown[]) => {
    if (isWrite(args)) writes.push({ api: label, target: String(args[0]) })
    return Reflect.apply(original, holder, args)
  })
}
const always = (): boolean => true
const writeFlag = (args: unknown[]): boolean => typeof args[1] === 'string' && /[wa+]/.test(args[1])
for (const name of ['writeFile', 'appendFile', 'rename', 'rm', 'unlink', 'copyFile', 'mkdir', 'chmod', 'truncate']) {
  wrap(fs.promises, name, `fs.promises.${name}`, always)
  wrap(fs, `${name}Sync`, `fs.${name}Sync`, always)
  wrap(fs, name, `fs.${name}`, always)
}
wrap(fs.promises, 'open', 'fs.promises.open', writeFlag)
wrap(fs, 'openSync', 'fs.openSync', writeFlag)
wrap(fs, 'createWriteStream', 'fs.createWriteStream', always)
for (const name of ['execFile', 'spawn', 'exec', 'execFileSync', 'spawnSync', 'execSync']) {
  const original: unknown = Reflect.get(childProcess, name)
  if (typeof original !== 'function') continue
  Reflect.set(childProcess, name, (...args: unknown[]) => {
    spawns.push({ api: name, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map((arg) => (String(arg) === os.userInfo().username ? '$USER' : String(arg))) : [] })
    return Reflect.apply(original, childProcess, args)
  })
}

// named import(`import { execFile } from 'node:child_process'`)도 감싼 함수를 보게 한다.
syncBuiltinESMExports()

type Call = { kind: 'file' | 'keychain' | 'http'; detail: Record<string, unknown> }

async function main(): Promise<void> {
  const { USAGE_COLLECTORS } = await import('../../src/main/usage/registry.js')
  const { realCollectorDeps } = await import('../../src/main/usage/deps.js')
  const results = []
  for (const collector of USAGE_COLLECTORS) {
    if (only.length > 0 && !only.includes(collector.id)) continue
    const calls: Call[] = []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const real = realCollectorDeps({ signal: controller.signal, userAgent: 'corral/usage-probe (LIFE-636)' })
    const deps: CollectorDeps = {
      ...real,
      readFile: async (file) => {
        const result = await real.readFile(file)
        calls.push({ kind: 'file', detail: { file: file.replace(home, '~'), result: result.kind } })
        return result
      },
      readKeychain: async (query) => {
        const result = await real.readKeychain(query)
        calls.push({ kind: 'keychain', detail: { service: query.service, account: query.account === os.userInfo().username ? '$USER' : '(other)', result: result.kind } })
        return result
      },
      httpGet: async (request) => {
        const startedAt = new Date().toISOString()
        const response = await real.httpGet(request)
        calls.push({ kind: 'http', detail: { url: request.url, headerNames: Object.keys(request.headers).sort(), userAgent: request.headers['User-Agent'], status: response.status, startedAt } })
        return response
      },
    }
    const startedAt = new Date().toISOString()
    const outcome = await collector.fetch(deps)
    clearTimeout(timer)
    results.push({ provider: collector.id, startedAt, finishedAt: new Date().toISOString(), outcome, calls })
  }
  const credentialWrites = writes.filter((write) => touchesCredentials(write.target))
  const keychainWrites = spawns.filter((spawn) => spawn.args.some((arg) => /^(add|delete|set)-generic-password$/.test(arg) || arg === 'set-generic-password-partition-list'))
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), results, instrumentation: { credentialPaths, writes, credentialWrites: credentialWrites.length, spawns, keychainWrites: keychainWrites.length } }, null, 2) + '\n')
}

void main()
