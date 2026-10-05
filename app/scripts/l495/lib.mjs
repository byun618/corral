// LIFE-497 드라이버 공용 — fixture 이미지·OS 입력 도우미·바이트 싱크 읽기.
// OS 입력(CGEvent 키·드래그)은 **보호를 거친 뒤에만** 보낸다: 키 = 맨 앞 앱 pid 가 대상이어야(keypost 가 거절),
// 드래그 = 출발점·도착점의 맨 위 창이 기대 pid 여야. 어긋나면 보내지 않고 그 사실을 기록한다.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync, spawn } from 'node:child_process'

export const BIN = '/tmp/l495b'
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 작은 단색 PNG (w×h, RGB). 클립보드·드롭 fixture 용 — 실제 디코드 가능한 PNG 여야 Codex 가 첨부로 받는다. */
export function solidPng({ width = 24, height = 16, rgb = [220, 60, 40] }) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => rgb[i % 3])])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export const run = (bin, args) => {
  try {
    return { code: 0, out: execFileSync(path.join(BIN, bin), args.map(String), { encoding: 'utf8' }).trim() }
  } catch (error) {
    return { code: error.status ?? -1, out: String(error.stdout ?? '').trim(), err: String(error.stderr ?? '').trim() }
  }
}
export const clip = (...args) => run('clip', args)
export const frontmost = () => JSON.parse(run('frontmost', []).out)
export const windowAt = (points) => JSON.parse(run('window-at', points.flat()).out)
/** ⌘V = keycode 9 + cmd. Ctrl+V = 9 + ctrl. 맨 앞 앱이 `pid` 가 아니면 keypost 가 거절(exit 4)한다. */
export const keypost = ({ pid, keycode, mods }) => {
  const result = run('keypost', [pid, keycode, ...mods])
  return { ...result, parsed: (() => { try { return JSON.parse(result.out) } catch { return null } })() }
}

/**
 * OS 드래그 한 번. 출발 창(drag-source)을 띄우고 READY 를 기다린 뒤, 출발점·도착점의 맨 위 창을 확인하고
 * cliclick dd → dm×n → du 로 끈다. 보호 실패면 끌지 않는다(`sent:false`).
 */
export async function osDrag({ files, source, target, expectTargetPid }) {
  const proc = spawn(path.join(BIN, 'drag-source'), [source.x, source.y, ...files].map(String), { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  proc.stdout.on('data', (chunk) => { output += chunk })
  const started = Date.now()
  while (!output.includes('READY') && Date.now() - started < 10_000) await pause(100)
  await pause(300)
  const grip = { x: source.x + 80, y: source.y + 50 }
  const hits = windowAt([[grip.x, grip.y], [target.x, target.y]])
  const record = { files, source: grip, target, hits, sourcePid: proc.pid, expectTargetPid, sent: false, dragSourceLog: '' }
  if (hits[0]?.pid !== proc.pid || hits[1]?.pid !== expectTargetPid) {
    record.refused = `보호: 출발 ${hits[0]?.pid}≠${proc.pid} 또는 도착 ${hits[1]?.pid}≠${expectTargetPid}`
  } else {
    const steps = 6
    const moves = Array.from({ length: steps }, (_, i) => {
      const t = (i + 1) / steps
      return `dm:${Math.round(grip.x + (target.x - grip.x) * t)},${Math.round(grip.y + (target.y - grip.y) * t)}`
    })
    try {
      execFileSync('/opt/homebrew/bin/cliclick', ['-w', '60', `dd:${grip.x},${grip.y}`, `dm:${grip.x + 5},${grip.y + 5}`, ...moves, `dm:${target.x},${target.y}`, `du:${target.x},${target.y}`])
      record.sent = true
    } catch (error) {
      record.error = String(error.message ?? error)
    }
  }
  const waitEnd = Date.now()
  while (record.sent && !output.includes('END') && Date.now() - waitEnd < 5_000) await pause(100)
  record.dragSourceLog = output.trim()
  proc.kill('SIGTERM')
  return record
}

/** 바이트 싱크 파일의 `from` 줄 이후 data 행들. */
export function sinkRows(file, from = 0) {
  if (!fs.existsSync(file)) return { rows: [], next: from }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  return { rows: lines.slice(from).map((line) => JSON.parse(line)), next: lines.length }
}

/**
 * 필수 조건 장부 (R1-05) — 관문이 기대한 조건이 false·시간초과·보호 거절이면 **종료코드로** 드러나게 한다.
 * r1 은 관측 결과를 기록만 하고 종료코드는 0 이라, 실패가 실행 목록에 통과로 들어갈 수 있었다.
 * `L495_FAKE_FAIL=<정규식>` 이면 이름이 맞는 조건을 강제로 실패시킨다 — 실패가 종료코드까지 닿는지 자기 검사용.
 */
export function requirements(onRecord = () => {}) {
  const fake = process.env.L495_FAKE_FAIL ? new RegExp(process.env.L495_FAKE_FAIL) : null
  const results = []
  return {
    results,
    require(name, ok, detail = {}) {
      const faked = fake !== null && fake.test(name)
      const pass = ok === true && !faked
      const row = { name, pass, ...(faked ? { faked: true } : {}), ...detail }
      results.push(row)
      onRecord(row)
      return pass
    },
    failed: () => results.filter((row) => !row.pass),
    /** 필수 조건이 하나라도 실패면 1. 다른 사유의 종료코드(예외 2·막는 화면 5)는 그대로 둔다. */
    exitCode: (base = 0) => (base !== 0 ? base : results.some((row) => !row.pass) ? 1 : 0),
  }
}
