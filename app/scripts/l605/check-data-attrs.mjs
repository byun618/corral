#!/usr/bin/env node
// LIFE-605 C13·C1 문서 검사 — 이 작업이 켜는 `data-*` 계측이 렌더러 소스(시험 제외, 주석 밖)에 있는지.
// 쓰기: node scripts/l605/check-data-attrs.mjs [--extra <파일>] [--base <commit>]  (app/ 에서). 하나라도 없으면 exit 1.
// `--extra` = 양성 대조: 그 파일만 검사 대상으로 삼는다(계측이 빠진 사본이면 MISS 로 exit 1 이어야 한다).
// `--base` = 기준 commit 대조(R1-V): 이 작업이 **새로** 켠다고 적은 속성(NEW)은 기준 소스에 없어야 하고, 다시 쓴다고 적은 속성(REUSED)은 있어야 한다.
//   목록이 틀리면(이미 있던 속성을 새것으로 셈 — 존재 검사가 이 작업의 증거가 아니게 됨) BASE 행으로 exit 1.
// 렌더 확인은 단위·화면 시험(ConnectionsSection.test · TasksPage.jira.test) 몫이고, 여기서는 소스 문자열 존재만 본다.
// 출처 이름 분기는 `scripts/l600/renderer-source-branch.mjs`(AST) 가 따로 본다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const extraAt = process.argv.indexOf('--extra')
const extra = extraAt === -1 ? null : process.argv[extraAt + 1] ?? null
const baseAt = process.argv.indexOf('--base')
const base = baseAt === -1 ? null : process.argv[baseAt + 1] ?? null
const stripComments = (body) => body.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n')

const root = path.resolve(import.meta.dirname, '../../src/renderer/src')
const files = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(tsx|ts)$/.test(entry.name) && !/\.test\.|\.nodetest\./.test(entry.name)) files.push(full)
  }
}
if (extra === null) walk(root)
else files.push(path.resolve(extra))
const text = new Map(files.map((file) => [file, stripComments(fs.readFileSync(file, 'utf8'))]))
const ATTRS = [
  'data-connection-add', 'data-connection-form', 'data-connection-account', 'data-connection-account-locked', 'data-connection-account-hint',
  'data-connection-token', 'data-connection-token-hint', 'data-connection-card-account',
  'data-status-blocked', 'data-status-blocked-reason', 'data-issue-body-lock', 'data-search-note', 'data-search-hit', 'data-quick-create-unaccepted',
]
/** 기준에 이미 있던 속성 — 이 작업이 값·자리를 더해 다시 쓴다. 나머지는 이 작업이 새로 켠다. */
const REUSED = new Set(['data-connection-add', 'data-connection-form', 'data-connection-token', 'data-search-hit'])
let failed = 0
if (base !== null) {
  const appDir = path.resolve(import.meta.dirname, '../..')
  // 기준 commit 의 렌더러 소스(시험 제외)를 git 에서 읽는다 — 작업 트리와 무관.
  const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', base, '--', 'src/renderer/src'], { cwd: appDir, encoding: 'utf8' }).split('\n').filter((file) => /\.(tsx|ts)$/.test(file) && !/\.test\.|\.nodetest\./.test(file))
  const baseText = listed.map((file) => stripComments(execFileSync('git', ['show', `${base}:app/${file}`], { cwd: appDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })))
  for (const attr of ATTRS) {
    const pattern = new RegExp(`${attr}(?=[="'\\s>/])`)
    const atBase = baseText.some((body) => pattern.test(body))
    const ok = REUSED.has(attr) ? atBase : !atBase
    console.log(`${ok ? 'base' : 'BASE'} ${attr} — 기준(${base}) ${atBase ? '있음' : '없음'} · 목록 ${REUSED.has(attr) ? '다시 씀' : '새로 켬'}`)
    if (!ok) failed += 1
  }
  console.log(`base files=${baseText.length}`)
  if (baseText.length === 0) failed += 1
}
for (const attr of ATTRS) {
  // 이름 뒤에 = · 따옴표 · 공백 · 태그 끝(값 없는 속성 `data-x>`)이 와야 한다 — 접두사만 같은 이름을 세지 않는다(q1 회차: `>` 를 빠뜨려 값 없는 속성을 MISS 로 셌다).
  const pattern = new RegExp(`${attr}(?=[="'\\s>/])`)
  const hits = [...text].filter(([, body]) => pattern.test(body)).map(([file]) => path.relative(root, file))
  console.log(`${hits.length > 0 ? 'ok  ' : 'MISS'} ${attr} — ${hits.join(', ') || '없음'}`)
  if (hits.length === 0) failed += 1
}
console.log(`files=${files.length} miss=${failed}`)
process.exit(failed === 0 && files.length > 0 ? 0 : 1)
