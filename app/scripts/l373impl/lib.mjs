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
/**
 * 관문 ⑤ 격리 — **두 축의 AND** 다 (코디네이터 재정 2026-09-16).
 *   ⓐ `life373-` 접두다  ⓑ herdr 가 default 로 표시한 세션도, 사용자의 `CORRAL_SESSION` 도 아니다
 * ⓐ만 두면 접두가 늘 때 거부가 같이 안 는다 — 막으려는 것은 접두가 아니라 사용자 세션이다.
 */
if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
{
  const denied = new Set(process.env.CORRAL_SESSION ? [process.env.CORRAL_SESSION] : [])
  try {
    const listed = JSON.parse(execFileSync('herdr', ['session', 'list', '--json'], { encoding: 'utf8' }))
    for (const row of listed.sessions ?? []) if (row.default === true) denied.add(row.name)
  } catch {
    denied.add('default')
  }
  if (denied.has(SESSION)) throw new Error(`거부: 사용자·default 세션이다 (${SESSION}) — 접두가 맞아도 붙지 않는다`)
}

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
export function strayAppPids() {
  const pattern = path.join(APP_DIR, 'node_modules')
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function killStrayApps() {
  const pids = strayAppPids()
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

/**
 * **M0** — 측정 런의 시작 상태를 원자료에 남긴다 (코디네이터 신설 통과선, 2026-09-16).
 *
 * 사고 2가 가리킨 진짜 위험은 오염된 로그가 아니라 **유령 렌더러가 CPU·rAF 를 오염시키는 것**이다.
 * P2~P5 는 렌더러 CPU 와 rAF 를 직접 보는 통과선이라 떠도는 앱 하나면 그 숫자가 통째로 무효다.
 * 그래서 "죽였다"로 끝내지 않고 **죽이기 전에 몇 개였는지를 적는다** — 0 이 아니면 그 런은 무효다.
 */
export function m0Start() {
  const before = strayAppPids().length
  killStrayApps()
  const after = strayAppPids().length
  return { 시작전잔여: before, 죽인뒤잔여: after, 유효: before === 0 && after === 0 }
}

/**
 * 붙어 있는 탭을 **pane 하나로** 되돌린다.
 *
 * herdr 는 pane 을 영속한다 — 앞 회차가 남긴 분할 위에서 또 나누면 회차마다 다른 트리에서
 * 출발해 비교가 성립하지 않는다. F1(영역)도 마찬가지다: pane 이 둘이면 장식이 생겨 격자가
 * 달라지므로 F1 의 숫자가 회차마다 흔들린다.
 */
export async function resetPanes() {
  const before = layout()
  const keep = before.focused_pane_id
  for (const pane of before.panes) if (pane.pane_id !== keep) ctl('pane', 'close', pane.pane_id)
  await sleep(900)
  const after = layout()
  if (after.panes.length !== 1) throw new Error(`pane 하나로 못 돌렸다 (${after.panes.length}개) — 손으로 정리하고 다시 돌려라`)
  return { 닫은수: before.panes.length - after.panes.length, 남은수: after.panes.length }
}

/** **M0-b** — 런이 끝난 뒤에도 0 인가. 남았으면 그 런의 CPU·rAF 계열은 보류다. */
export function m0End() {
  const left = strayAppPids().length
  return { 종료후잔여: left, 유효: left === 0 }
}
