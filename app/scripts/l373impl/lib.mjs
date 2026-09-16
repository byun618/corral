// LIFE-373 구현 게이트 계측 공용 — 격리 가드 · 제3 오라클(control CLI) · ps 샘플러 · 원자료 쓰기.
//
// 스파이크 하네스(scripts/l373/)는 throwaway 라 끌어다 쓰지 않는다 (02-kickoff 규칙).
// 다만 **오라클은 같은 것을 쓴다**: herdr 상태는 endpoint 연결이 아니라 control 소켓 별도
// 커넥션(`herdr --session … ` CLI, 호출마다 herdr.sock 새 커넥션)에서만 읽는다 (관문 ④).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_DIR = path.dirname(path.dirname(HERE))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW = path.join(REPO_DIR, 'specs/LIFE-373-mru-pane-split/raw/claude')

export const SESSION = process.env.L373_SESSION ?? 'life373-impl'
/** 관문 ⑤ 격리 — 사용자 default 세션·다른 세션을 코드 레벨에서 막는다. */
if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)

export const sessionDir = path.join(os.homedir(), '.config', 'herdr', 'sessions', SESSION)
export const clientSocketPath = path.join(sessionDir, 'herdr-client.sock')
export const controlSocketPath = path.join(sessionDir, 'herdr.sock')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 제3 오라클 — control CLI. 판별에 쓰는 herdr 상태는 전부 여기서만 읽는다. */
export function ctl(...args) {
  const out = execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' })
  if (out.trim().length === 0) return null
  return JSON.parse(out).result
}

export const paneList = () => ctl('pane', 'list').panes
export const tabList = () => ctl('tab', 'list').tabs
export const layout = () => ctl('pane', 'layout').layout

export function serverPid() {
  const pids = execFileSync('pgrep', ['-f', 'herdr server'], { encoding: 'utf8' }).trim().split('\n')
  for (const pid of pids) {
    try {
      const out = execFileSync('lsof', ['-p', pid.trim()], { encoding: 'utf8' })
      if (out.includes(controlSocketPath)) return Number(pid.trim())
    } catch {
      /* 권한 없는 프로세스는 건너뛴다 */
    }
  }
  return null
}

function parseCpuTime(text) {
  const parts = text.trim().split(':').map(Number)
  if (parts.some(Number.isNaN)) return null
  return parts.reduce((acc, v) => acc * 60 + v, 0)
}

export function psSample(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'cputime=,rss=,%cpu=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    if (out.length === 0) return null
    const m = out.split(/\s+/)
    return { at: Date.now(), cpuSec: parseCpuTime(m[0]), rssKb: Number(m[1]), psCpuPct: Number(m[2]) }
  } catch {
    return null
  }
}

export function writeRaw(file, content) {
  const target = path.join(RAW, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  console.log('wrote', path.relative(REPO_DIR, target))
  return target
}

/** 벤더 endpoint 클라이언트를 esbuild 로 묶어 **그대로** import (재작성 금지 — 본체와 같은 코드). */
export async function loadEndpointClient() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l373i-')), 'endpoint-client.mjs')
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    path.join(APP_DIR, 'src/main/adapter/internal/vendor/endpoint-client.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${out}`,
  ])
  return (await import(out)).EndpointClient
}

/** 백분위 (정렬 없는 배열 받아 복사해서 정렬). */
export function pct(values, p) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2)
}

/**
 * 앞 회차에서 살아남은 앱을 먼저 죽인다 (사고 2 재발 방지).
 *
 * `startApp` 의 `stop()` 이 SIGTERM→SIGKILL 을 쓰지만 스크립트가 중간에 터지면 그 길을 안 지난다.
 * 남은 앱은 **커밋된 로그 파일에 계속 덧붙인다** — `park()` 가 옮겨 놓은 `_discarded/` 안의
 * 파일까지 자란다(실제로 한 번 일어났다: 426줄 증가, `git checkout` 으로 회수). 재는 것과도
 * 상관없다 — 유령 창이 herdr 연결을 붙들고 있으면 연결 수가 곧 영역 수라는 전제가 깨진다.
 */
export function killStrayApps() {
  const pattern = path.join(APP_DIR, 'node_modules')
  const pids = (() => {
    try {
      return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  })()
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      /* 이미 죽었다 */
    }
  }
  if (pids.length > 0) console.log(`[l373] 남은 앱 ${pids.length}개를 먼저 죽였다`)
  return pids.length
}
