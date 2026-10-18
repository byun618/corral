// 수집기 시험용 deps 대역 (LIFE-636 E3~E6) — 모든 바깥 접근을 `calls` 에 기록한다. 대역에는 읽기 연산만 있다(계약 그대로).
import fs from 'node:fs'
import type { CollectorDeps, HttpResponse } from './collector.js'

export const TEST_TOKEN = 'tok-SECRET-l636-0123456789'
export const NOW = Date.parse('2026-10-18T12:30:00Z')

export type Call =
  | { kind: 'file'; file: string }
  | { kind: 'keychain'; service: string; account: string }
  | { kind: 'http'; url: string; headers: Record<string, string> }

export function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

export function response(input: { status: number; body?: unknown; headers?: Record<string, string> }): HttpResponse {
  const text = typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {})
  const headers = new Map(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  return { status: input.status, header: (name) => headers.get(name.toLowerCase()) ?? null, text: async () => text }
}

export function fakeDeps(input: {
  files?: Record<string, string | 'error'>
  keychain?: Record<string, string> | 'error'
  http?: (request: { url: string; headers: Record<string, string>; signal: AbortSignal }) => HttpResponse | Promise<HttpResponse>
  env?: Record<string, string | undefined>
  platform?: string
  signal?: AbortSignal
}): { deps: CollectorDeps; calls: Call[] } {
  const calls: Call[] = []
  const deps: CollectorDeps = {
    readFile: async (file) => {
      calls.push({ kind: 'file', file })
      const content = input.files?.[file]
      if (content === undefined) return { kind: 'missing' }
      return content === 'error' ? { kind: 'error' } : { kind: 'found', text: content }
    },
    readKeychain: async ({ service, account }) => {
      calls.push({ kind: 'keychain', service, account })
      if (input.keychain === 'error') return { kind: 'error' }
      const secret = input.keychain?.[service]
      return secret === undefined ? { kind: 'missing' } : { kind: 'found', secret }
    },
    httpGet: async (request) => {
      calls.push({ kind: 'http', url: request.url, headers: request.headers })
      if (input.http === undefined) throw new Error('no http in this test')
      return input.http(request)
    },
    env: input.env ?? { USER: 'tester' },
    homedir: '/home/tester',
    platform: input.platform ?? 'darwin',
    now: () => NOW,
    userAgent: 'corral/test',
    signal: input.signal ?? new AbortController().signal,
  }
  return { deps, calls }
}
