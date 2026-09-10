// 원자료 기록기. 프로브가 본 줄을 시각과 함께 그대로 남긴다 (01-criteria.md 규약 3).

import fs from 'node:fs'
import path from 'node:path'
import { RAW_DIR } from './herdr.mjs'

export class Raw {
  constructor(name) {
    this.dir = RAW_DIR
    fs.mkdirSync(this.dir, { recursive: true })
    this.logPath = path.join(this.dir, `${name}.ndjson`)
    this.fd = fs.openSync(this.logPath, 'w')
    this.t0 = Date.now()
    this.log('probe.start', { name, startedAt: new Date().toISOString() })
  }

  /**
   * 한 줄 = 한 사건. ms 는 프로브 시작 기준 상대 시각.
   * kind 를 마지막에 둔다 — data 에 kind 라는 필드가 있어도 사건 종류가 먹히지 않도록.
   */
  log(kind, data) {
    fs.writeSync(this.fd, JSON.stringify({ ms: Date.now() - this.t0, ...data, kind }) + '\n')
  }

  /** 소켓에서 온 원문 줄을 가공 없이 남긴다. */
  wire(dir, line, extra = {}) {
    this.log('wire', { dir, line, ...extra })
  }

  close(summary) {
    this.log('probe.end', { endedAt: new Date().toISOString() })
    fs.closeSync(this.fd)
    if (summary) {
      const p = path.join(this.dir, path.basename(this.logPath, '.ndjson') + '-summary.json')
      fs.writeFileSync(p, JSON.stringify(summary, null, 2))
      console.log('summary →', p)
    }
    console.log('raw →', this.logPath)
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** p50/p95 등. 표본이 없으면 null. */
export function pct(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)
  return s[Math.max(0, i)]
}
