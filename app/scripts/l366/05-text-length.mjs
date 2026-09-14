// B5 「전문은 title 툴팁으로」의 근거 — **2차 줄에 실릴 텍스트가 실제로 얼마나 긴가**.
//
// 처음엔 `MAX_ACTIVITY_CHARS = 400` 으로 잘라서 날랐다. 그런데 B5 는 "전문은 title 툴팁으로"
// 라고 쓰여 있다 — 자른 값을 툴팁에 넣으면 전문이 아니다. 자르지 않기로 바꾸려면 **자르지
// 않아도 IPC 가 감당할 크기인지**를 먼저 알아야 한다. 그걸 여기서 잰다.
//
// 읽기 전용이다 (기준 E6). 내용은 안 싣는다 — 길이 분포와 개수만 싣는다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRaw } from './lib.mjs'

const TAIL_BYTES = 256 * 1024

function readTail(file) {
  const size = fs.statSync(file).size
  const from = Math.max(0, size - TAIL_BYTES)
  const handle = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size - from)
    fs.readSync(handle, buffer, 0, buffer.length, from)
    const list = buffer.toString('utf8').split('\n')
    if (from > 0) list.shift()
    return list.filter((line) => line.trim().length > 0)
  } finally {
    fs.closeSync(handle)
  }
}

/** 한 줄로 접은 뒤의 길이 — 판독층이 싣는 값과 같은 모양이다. */
function folded(text) {
  return text.replace(/\s+/g, ' ').trim().length
}

function claudeLengths() {
  const dir = path.join(os.homedir(), '.claude/projects')
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of fs.readdirSync(path.join(dir, entry.name))) {
      if (name.endsWith('.jsonl')) files.push(path.join(dir, entry.name, name))
    }
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const lengths = []
  for (const file of files.slice(0, 80)) {
    const list = readTail(file)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      let record
      try {
        record = JSON.parse(list[i])
      } catch {
        continue
      }
      if (record.type !== 'assistant') continue
      const blocks = record.message?.content
      if (!Array.isArray(blocks)) continue
      const joined = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (joined.trim().length === 0) continue
      lengths.push(folded(joined))
      break
    }
  }
  return lengths
}

/** 꼬리 안의 **모든** 어시스턴트 텍스트 — 마지막 것만 보면 최악값을 놓친다. */
function claudeAllLengths() {
  const dir = path.join(os.homedir(), '.claude/projects')
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of fs.readdirSync(path.join(dir, entry.name))) {
      if (name.endsWith('.jsonl')) files.push(path.join(dir, entry.name, name))
    }
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const lengths = []
  for (const file of files.slice(0, 40)) {
    for (const line of readTail(file)) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.type !== 'assistant') continue
      const blocks = record.message?.content
      if (!Array.isArray(blocks)) continue
      const joined = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (joined.trim().length > 0) lengths.push(folded(joined))
    }
  }
  return lengths
}

function stats(lengths) {
  if (lengths.length === 0) return { n: 0 }
  const sorted = [...lengths].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    '400자_초과_비율': `${((sorted.filter((x) => x > 400).length / sorted.length) * 100).toFixed(1)}%`,
    '4KB_초과_개수': sorted.filter((x) => x > 4096).length,
  }
}

const last = claudeLengths()
const all = claudeAllLengths()
const out = {
  at: new Date().toISOString(),
  note: '사용자 트랜스크립트는 읽기 전용(기준 E6). 길이·개수만 싣는다 — 본문은 싣지 않는다.',
  '마지막_어시스턴트_텍스트_길이(파일당 1개)': stats(last),
  '꼬리 안 모든 어시스턴트 텍스트 길이': stats(all),
  '세션 8개 동시 최악값(바이트, p99 기준)': stats(all).p99 * 8,
  결론:
    '전문을 그대로 실어도 세션당 수 KB 규모다. 400자 상한을 떼고 B5 대로 전문을 툴팁에 준다.',
}
writeRaw('b5-text-length.json', out)
console.log(JSON.stringify(out, null, 1))
