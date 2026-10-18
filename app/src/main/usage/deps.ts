// 실제 deps (LIFE-636) — 수집기 계약(`collector.ts`)의 읽기 연산을 실제 세계에 잇는다. Electron 을 모른다(창 없는 node 진입점도 쓴다).
//
// 키체인: `/usr/bin/security find-generic-password -s <service> -a <account> -w` 를 **인자 배열** `execFile` 로(셸 없음 — 주입 불가, E6ⓓ)·5초 타임아웃.
// exit 44 = 항목 없음. stderr·예외 메시지는 옮기지 않는다. 쓰기 명령(add/delete-generic-password)은 이 파일에 없다.
// HTTP: Node `fetch`(새 의존성 없음). 파일: `fs.promises.readFile` 만.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import type { CollectorDeps, FileReadResult, HttpGet, KeychainReadResult } from './collector.js'

const SECURITY_BIN = '/usr/bin/security'
const KEYCHAIN_TIMEOUT_MS = 5000
const KEYCHAIN_NOT_FOUND = 44

export const httpGet: HttpGet = async ({ url, headers, signal }) => {
  const response = await fetch(url, { method: 'GET', headers, signal, redirect: 'error' })
  return { status: response.status, header: (name) => response.headers.get(name), text: () => response.text() }
}

export async function readFileText(file: string): Promise<FileReadResult> {
  try {
    return { kind: 'found', text: await fs.promises.readFile(file, 'utf8') }
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' }
  }
}

export function readKeychain({ service, account }: { service: string; account: string }): Promise<KeychainReadResult> {
  return new Promise((resolve) => {
    execFile(SECURITY_BIN, ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error === null) {
        const secret = stdout.trim()
        resolve(secret === '' ? { kind: 'missing' } : { kind: 'found', secret })
        return
      }
      resolve('code' in error && error.code === KEYCHAIN_NOT_FOUND ? { kind: 'missing' } : { kind: 'error' })
    })
  })
}

export function realCollectorDeps({ signal, userAgent }: { signal: AbortSignal; userAgent: string }): CollectorDeps {
  return { httpGet, readFile: readFileText, readKeychain, env: process.env, homedir: os.homedir(), platform: process.platform, now: Date.now, userAgent, signal }
}
