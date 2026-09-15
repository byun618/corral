// LIFE-373 스파이크 2차 공용 — 격리 가드 · 제3 오라클(control CLI) · ps 샘플러 · 원자료 쓰기.
//
// 관문 ②: herdr 상태는 **corral 연결(endpoint)이 아니라 별도 커넥션**으로 읽는다.
// 여기서는 `herdr --session <s> …` CLI 를 쓴다 — 매 호출이 herdr.sock 에 새 커넥션을 연다.
// endpoint 연결(herdr-client.sock)과 소켓 자체가 다르다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_DIR = path.dirname(path.dirname(path.dirname(HERE)))
export const REPO_DIR = path.dirname(APP_DIR)
export const RAW = path.join(REPO_DIR, 'specs/LIFE-373-mru-pane-split/raw/spike2')

export const SESSION = process.env.L373_SESSION ?? 'life373-claude'
/** 사용자 default 세션을 코드 레벨에서 막는다 (관문 ③). */
if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)

export const sessionDir = path.join(os.homedir(), '.config', 'herdr', 'sessions', SESSION)
export const clientSocketPath = path.join(sessionDir, 'herdr-client.sock')
export const controlSocketPath = path.join(sessionDir, 'herdr.sock')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 제3 오라클 — control CLI. 판별에 쓰는 herdr 상태는 전부 여기서만 읽는다. */
export function ctl(...args) {
  const out = execFileSync('herdr', ['--session', SESSION, ...args], { encoding: 'utf8' })
  // 일부 명령(pane run 등)은 본문 없이 성공한다 — 그 경우 null 을 돌려준다.
  if (out.trim().length === 0) return null
  return JSON.parse(out).result
}

export const paneList = () => ctl('pane', 'list').panes
export const tabList = () => ctl('tab', 'list').tabs
export const layout = () => ctl('pane', 'layout').layout

/** life373 세션의 herdr 서버 PID — lsof 로 소켓 소유자를 찾는다 (앱 바깥 오라클). */
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

/** `MM:SS.ss` / `H:MM:SS.ss` → 초 */
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

/** 관문 ⑤ — CPU 는 순간 %cpu 가 아니라 cputime 델타 ÷ 구간. */
export async function measureCpu(pid, ms, { everyMs = 500 } = {}) {
  const samples = []
  const first = psSample(pid)
  samples.push(first)
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await sleep(everyMs)
    const s = psSample(pid)
    if (s !== null) samples.push(s)
  }
  const last = samples[samples.length - 1]
  const spanSec = (last.at - first.at) / 1000
  return {
    pid,
    spanSec: +spanSec.toFixed(2),
    cpuSec: +(last.cpuSec - first.cpuSec).toFixed(2),
    cpuPct: +(((last.cpuSec - first.cpuSec) / spanSec) * 100).toFixed(1),
    rssKbStart: first.rssKb,
    rssKbEnd: last.rssKb,
    rssKbMax: Math.max(...samples.map((s) => s.rssKb)),
    samples,
  }
}

export function writeRaw(file, content) {
  const target = path.join(RAW, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  console.log('wrote', path.relative(REPO_DIR, target))
  return target
}

/** 벤더 endpoint 클라이언트를 esbuild 로 묶어 그대로 import (재작성 금지 — 본체와 같은 코드). */
export async function loadEndpointClient() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l373s2-')), 'endpoint-client.mjs')
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    path.join(APP_DIR, 'src/main/adapter/internal/vendor/endpoint-client.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${out}`,
  ])
  return (await import(out)).EndpointClient
}

/** FrameData 셀 격자를 텍스트 줄로 편다 (S4 판별용 — ANSI 인코딩을 거치지 않는다). */
export function frameToText(frame) {
  const lines = []
  for (let y = 0; y < frame.height; y++) {
    let row = ''
    for (let x = 0; x < frame.width; x++) row += frame.cells[y * frame.width + x]?.symbol ?? ' '
    lines.push(row.replace(/\s+$/, ''))
  }
  return lines
}

/** 프레임에서 rect 구역만 잘라 텍스트로 (pane 별 내용 확인). */
export function cropText(frame, rect) {
  const lines = []
  for (let y = rect.y; y < rect.y + rect.height && y < frame.height; y++) {
    let row = ''
    for (let x = rect.x; x < rect.x + rect.width && x < frame.width; x++) {
      row += frame.cells[y * frame.width + x]?.symbol ?? ' '
    }
    lines.push(row.replace(/\s+$/, ''))
  }
  return lines
}
