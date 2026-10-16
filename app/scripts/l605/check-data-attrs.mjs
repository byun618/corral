#!/usr/bin/env node
// LIFE-605 C13·C1 문서 검사 — 이 작업이 켜는 `data-*` 계측이 렌더러 소스(시험 제외, 주석 밖)에 있는지.
// 쓰기: node scripts/l605/check-data-attrs.mjs [--extra <파일>]  (app/ 에서). 하나라도 없으면 exit 1.
// `--extra` = 양성 대조: 그 파일만 검사 대상으로 삼는다(계측이 빠진 사본이면 MISS 로 exit 1 이어야 한다).
// 렌더 확인은 단위·화면 시험(ConnectionsSection.test · TasksPage.jira.test) 몫이고, 여기서는 소스 문자열 존재만 본다.
// 출처 이름 분기는 `scripts/l600/renderer-source-branch.mjs`(AST) 가 따로 본다.
import fs from 'node:fs'
import path from 'node:path'

const extraAt = process.argv.indexOf('--extra')
const extra = extraAt === -1 ? null : process.argv[extraAt + 1] ?? null
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
let failed = 0
for (const attr of ATTRS) {
  const pattern = new RegExp(`${attr}(?=[="'\\s])`)
  const hits = [...text].filter(([, body]) => pattern.test(body)).map(([file]) => path.relative(root, file))
  console.log(`${hits.length > 0 ? 'ok  ' : 'MISS'} ${attr} — ${hits.join(', ') || '없음'}`)
  if (hits.length === 0) failed += 1
}
console.log(`files=${files.length} miss=${failed}`)
process.exit(failed === 0 && files.length > 0 ? 0 : 1)
