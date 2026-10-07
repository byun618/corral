// LIFE-518 fix1 — 알려진 사각을 **측정한 꼴로만** 적으려고 돌리는 우회 꼴 조사(판정 묶음 PROBES 와 별개).
// 칸마다 기준·지금 검사기 결과를 낸다. 사용: node scripts/l518/bypass-scan.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, runProbes } from './boundary-probes.mjs'

const R = 'src/renderer/src/boundary-probe-scan-'
const SCAN = [
  { id: 's-const-no-method', source: "declare function send(m: unknown): void\nconst kind = 'tab.rename'\nsend({ method: kind })\n" },
  { id: 's-request-arg', source: "declare function request(s: unknown, m: string): void\nrequest(1, 'tab.rename')\n" },
  { id: 's-reassign-var', source: "declare const frame: { method: string }\nlet m = ''\nm = 'tab.rename'\nframe.method = m\n" },
  { id: 's-split-concat', source: "export const probe = { method: 'tab.' + 'rename' }\n" },
  { id: 's-computed-key', source: "const k = 'method'\nexport const probe = { [k]: 'tab.rename' }\n" },
  { id: 's-template-json', source: "export const probe = JSON.parse(`{\"method\":\"${'tab.rename'}\"}`)\n" },
  { id: 's-shorthand', source: "const method = 'tab.rename'\nexport const probe = { method }\n" },
  { id: 's-element-access', source: "declare const map: Record<string, string>\nexport const probe = { method: map['tab.rename'] }\n" },
  { id: 's-params-value', source: "export const probe = { method: 'x.y', params: { action: 'tab.rename' } }\n" },
  { id: 's-block-arrow', source: "export const probe = { method: (() => { return 'tab.rename' })() }\n" },
  { id: 's-case-other', source: "export const probe = (k: string): number => { switch (k) { case 'tab.rename': return 1 } return 0 }\n" },
  { id: 's-object-assign', source: "declare const frame: object\nObject.assign(frame, { method: 'tab.rename' })\n" },
  { id: 's-array-index', source: "export const probe = { method: ['tab.rename'][0] }\n" },
  { id: 's-map-lookup', source: "const M: Record<string, string> = { rename: 'tab.rename' }\nexport const probe = { method: M.rename }\n" },
  { id: 's-arrow-return', source: "export const probe = { method: (() => 'tab.rename')() }\n" },
  { id: 's-op-field', source: "export const probe = { op: 'tab.rename', id: 1 }\n" },
]
const base = execFileSync('git', ['show', 'e92e66da:app/scripts/check-boundary.mjs'], { cwd: APP_DIR, encoding: 'utf8' })
const head = fs.readFileSync(path.join(APP_DIR, 'scripts/check-boundary.mjs'), 'utf8')
const probes = SCAN.map((item) => ({ ...item, expect: 'R4-wire-leak', file: `${R}${item.id}.ts` }))
const before = runProbes({ checkerSource: base, probes })
const after = runProbes({ checkerSource: head, probes })
console.log('| 꼴 | 원문 | 기준 | 지금 |\n| --- | --- | --- | --- |')
probes.forEach((probe, index) => {
  const cell = (c) => (c.caught ? '잡음' : '안 잡음')
  console.log(`| ${probe.id} | \`${probe.source.trim().replace(/\n/g, ' ⏎ ').replace(/\|/g, '\\|')}\` | ${cell(before.cells[index])} | ${cell(after.cells[index])} |`)
})
