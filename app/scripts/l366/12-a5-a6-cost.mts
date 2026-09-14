// A5(꼬리 읽기 정확성) · A6(비용) — **전문 판독을 오라클로 두고 대조한다.**
//
// 오라클은 이 스크립트가 따로 쓴다. `transcript-parse.ts` 를 그대로 불러다 쓰면 "같은 코드가
// 같은 답을 냈다" 밖에 안 나와서 대조가 성립하지 않는다 (LIFE-357 C4 git 오라클과 같은 규칙).
// 오라클은 **파일 전체**를 읽고 앞에서부터 훑는다 — 판독층은 꼬리만 읽고 뒤에서부터 훑는다.
// 방향·범위가 반대라서 같은 답이 나오면 그건 실질 대조다.
//
// 읽기 전용이다 (기준 E6). 원자료에는 **길이·해시·비용만** 싣고 대화 내용은 안 싣는다.
//
// 관문 ⑤ 반례: 일부러 **틀린 오라클**(마지막 어시스턴트가 아니라 **첫** 어시스턴트를 집는 것)로
// 같은 대조를 한 번 돌린다. 대조식이 아무거나 통과시키면 그것도 통과할 것이다.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearTranscriptCacheForTest, readSessionDigest } from '../../src/main/transcript.js'
import type { AgentSessionRef } from '../../src/shared/types.js'

const RAW_DIR = path.join(
  path.dirname(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))),
  'specs/LIFE-366-session-identity/raw/claude',
)

type OracleResult = { text: string | null; aiTitle: string | null; lastAt: number | null; lines: number }

/** 전문 오라클 — 파일을 통째로 읽고 **앞에서부터** 훑는다. 마지막 값이 이긴다. */
function fullFileOracle(file: string, sessionId: string, { firstInsteadOfLast = false } = {}): OracleResult {
  const content = fs.readFileSync(file, 'utf8')
  let text: string | null = null
  let aiTitle: string | null = null
  let lastAt: number | null = null
  let lines = 0
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue
    lines += 1
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const row: Record<string, unknown> = { ...record }
    const stamp = typeof row['timestamp'] === 'string' ? Date.parse(row['timestamp']) : NaN
    if (Number.isFinite(stamp) && (lastAt === null || stamp > lastAt)) lastAt = stamp
    if (row['type'] === 'ai-title' && row['sessionId'] === sessionId && typeof row['aiTitle'] === 'string') {
      aiTitle = row['aiTitle'].trim()
    }
    if (row['type'] !== 'assistant') continue
    const message = row['message']
    if (typeof message !== 'object' || message === null) continue
    const content2 = (message as Record<string, unknown>)['content']
    if (!Array.isArray(content2)) continue
    const joined = content2
      .filter((block): block is { type: string; text: string } => {
        if (typeof block !== 'object' || block === null) return false
        const item: Record<string, unknown> = { ...block }
        return item['type'] === 'text' && typeof item['text'] === 'string'
      })
      .map((block) => block.text)
      .join('\n')
    const folded = joined.replace(/\s+/g, ' ').trim()
    if (folded.length === 0) continue
    if (firstInsteadOfLast) {
      if (text === null) text = folded
    } else {
      text = folded
    }
  }
  return { text, aiTitle, lastAt, lines }
}

function claudeFiles(): Array<{ file: string; id: string; size: number }> {
  const projects = path.join(os.homedir(), '.claude', 'projects')
  const out: Array<{ file: string; id: string; size: number }> = []
  for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of fs.readdirSync(path.join(projects, entry.name))) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(projects, entry.name, name)
      out.push({ file, id: name.slice(0, -'.jsonl'.length), size: fs.statSync(file).size })
    }
  }
  return out.sort((a, b) => a.size - b.size)
}

const hash = (value: string | null): string | null =>
  value === null ? null : crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)

function main(): void {
  const files = claudeFiles()
  if (files.length === 0) throw new Error('claude 트랜스크립트가 없다')
  const sizes = files.map((item) => item.size)
  // 소·중·대 + **가장 큰 것**. A6 통과선이 29MB급이라 최대값은 반드시 넣는다.
  const picks = [
    files[Math.floor(files.length * 0.1)],
    files[Math.floor(files.length * 0.5)],
    files[Math.floor(files.length * 0.9)],
    files[files.length - 1],
  ].filter((item, index, list) => list.findIndex((other) => other.file === item.file) === index)

  const rows = []
  for (const pick of picks) {
    const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: pick.id }
    clearTranscriptCacheForTest()
    const coldAt = process.hrtime.bigint()
    const cold = readSessionDigest(ref)
    const coldMs = Number(process.hrtime.bigint() - coldAt) / 1e6
    const warmAt = process.hrtime.bigint()
    const warm = readSessionDigest(ref)
    const warmMs = Number(process.hrtime.bigint() - warmAt) / 1e6

    const oracleAt = process.hrtime.bigint()
    const oracle = fullFileOracle(pick.file, pick.id)
    const oracleMs = Number(process.hrtime.bigint() - oracleAt) / 1e6
    const wrongOracle = fullFileOracle(pick.file, pick.id, { firstInsteadOfLast: true })

    const tailText = cold.digest.activity.state === 'text' ? cold.digest.activity.text : null
    rows.push({
      파일: path.basename(pick.file),
      바이트: pick.size,
      'MB': Math.round((pick.size / 1024 / 1024) * 100) / 100,
      전체줄수: oracle.lines,
      // --- A5 정확성 ---
      꼬리_상태: cold.digest.activity.state,
      꼬리_텍스트_해시: hash(tailText),
      전문_텍스트_해시: hash(oracle.text),
      텍스트_일치: hash(tailText) === hash(oracle.text),
      텍스트_길이: tailText?.length ?? null,
      providerTitle_일치: (cold.digest.providerTitle ?? null) === (oracle.aiTitle ?? null),
      lastActivityAt_일치: cold.digest.lastActivityAt === oracle.lastAt,
      // 관문 ⑤ 반례 — 틀린 오라클(**첫** 어시스턴트를 집는다)과는 안 맞아야 한다.
      // 어시스턴트 텍스트가 하나뿐인 파일에서는 첫=마지막이라 **반례가 성립하지 않는다** —
      // 그런 파일을 "반례도 통과했다" 로 세면 판별력 점검이 거짓 경보를 낸다.
      반례_성립: hash(wrongOracle.text) !== hash(oracle.text),
      반례_틀린오라클과_일치: hash(tailText) === hash(wrongOracle.text),
      // --- A6 비용 ---
      '꼬리 읽은 바이트': cold.bytes,
      '꼬리 ms': Math.round(coldMs * 100) / 100,
      '두 번째 호출 바이트': warm.bytes,
      '두 번째 호출 statOnly': warm.statOnly,
      '두 번째 호출 ms': Math.round(warmMs * 100) / 100,
      '전문 판독 ms(오라클)': Math.round(oracleMs * 100) / 100,
      '읽은 비율': Math.round((cold.bytes / pick.size) * 10000) / 100,
    })
  }

  const out = {
    at: new Date().toISOString(),
    note: '사용자 트랜스크립트는 읽기 전용(E6). 대화 내용은 안 싣고 해시·길이·비용만 싣는다.',
    '파일 분포': {
      개수: files.length,
      최소: sizes[0],
      중앙값: sizes[Math.floor(sizes.length / 2)],
      최대: sizes[sizes.length - 1],
      '최대 MB': Math.round((sizes[sizes.length - 1] / 1024 / 1024) * 100) / 100,
    },
    표: rows,
    'A5 판정': {
      대조_파일수: rows.length,
      전부_일치: rows.every((row) => row.텍스트_일치 && row.providerTitle_일치 && row.lastActivityAt_일치),
      반례_성립_파일수: rows.filter((row) => row.반례_성립).length,
      반례가_통과하나: rows.some((row) => row.반례_성립 && row.반례_틀린오라클과_일치),
    },
    'A6 판정': {
      '통과선': '갱신 1회 ≤ 2MB · ≤ 50ms',
      최대_읽은_바이트: Math.max(...rows.map((row) => row['꼬리 읽은 바이트'])),
      최대_ms: Math.max(...rows.map((row) => row['꼬리 ms'])),
      '2MB 이하': rows.every((row) => row['꼬리 읽은 바이트'] <= 2 * 1024 * 1024),
      '50ms 이하': rows.every((row) => row['꼬리 ms'] <= 50),
      '파일 크기에 비례하지 않나': '표의 "읽은 비율" 칸 — 파일이 커질수록 비율이 작아진다',
    },
  }
  fs.mkdirSync(RAW_DIR, { recursive: true })
  fs.writeFileSync(path.join(RAW_DIR, 'a5-a6-cost.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 1))
}

main()
