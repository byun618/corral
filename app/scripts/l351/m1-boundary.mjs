// M1 — N2(어댑터 경계). 검사를 돌리고, **검사가 실제로 잡는지**까지 같이 증명한다.
//
// 통과만 찍는 검사는 근거가 아니다: 아무것도 안 보는 검사도 통과한다. 그래서 음성 대조를
// 붙인다 — 경계를 **일부러 깨는** 파일을 잠깐 심어 검사가 미달을 내는지 보고 되돌린다.
// 심는 위반은 규칙 4종(R1·R2·R3·R4) 각각이다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, RAW_DIR, writeRaw } from './lib.mjs'

const CHECKER = path.join(APP_DIR, 'scripts/check-boundary.mjs')

function runCheck(outFile) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, ...(outFile ? [outFile] : [])], {
      cwd: APP_DIR,
      encoding: 'utf8',
    })
    return { exit: 0, stdout }
  } catch (error) {
    return { exit: error.status ?? -1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const baseline = runCheck(path.join(RAW_DIR, 'n2-boundary.json'))
const report = JSON.parse(fs.readFileSync(path.join(RAW_DIR, 'n2-boundary.json'), 'utf8'))

/** 음성 대조 — 각 규칙을 하나씩 깨고 검사가 미달을 내는지 본다. 다 끝나면 지운다. */
const PROBES = [
  {
    rule: 'R1-internal',
    file: 'src/main/boundary-probe.ts',
    source: "import { WorkspaceStore } from './adapter/internal/store.js'\nexport const probe = WorkspaceStore\n",
  },
  {
    rule: 'R2-adapter',
    file: 'src/renderer/src/boundary-probe.ts',
    source: "import { SessionLink } from '../../main/adapter/index.js'\nexport const probe = SessionLink\n",
  },
  {
    rule: 'R3-shared-pure',
    file: 'src/shared/boundary-probe.ts',
    source: "import { log } from '../main/log.js'\nexport const probe = log\n",
  },
  {
    rule: 'R4-wire-leak',
    file: 'src/renderer/src/wire-probe.ts',
    source: "export const probe = (row: Record<string, unknown>): unknown => row['open_workspace_id']\n",
  },
  // 수정 1회차 L2 — 1회차 지문은 **작은따옴표만** 봤다. prettier 가 작은따옴표로 맞춰 주는 덕에
  // 통과하고 있었던 것이라, 검사의 통과선이 포매터에 기대고 있었다. 따옴표 3종을 다 건다.
  {
    rule: 'R4-wire-leak',
    이름: 'R4 큰따옴표 메서드',
    file: 'src/renderer/src/wire-probe2.ts',
    source: 'export const probe = "pane.list"\n',
  },
  {
    rule: 'R4-wire-leak',
    이름: 'R4 템플릿 리터럴 ${} 안쪽',
    file: 'src/renderer/src/wire-probe3.ts',
    source: "const f = (x: Record<string, unknown>): unknown => x['a']\nexport const probe = `pane ${f({ pane_id: 1 })}`\n",
  },
]

const negative = []
for (const probe of PROBES) {
  const target = path.join(APP_DIR, probe.file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, probe.source)
  const result = runCheck()
  fs.rmSync(target, { force: true })
  negative.push({
    깬규칙: probe.이름 ?? probe.rule,
    규칙: probe.rule,
    심은파일: probe.file,
    exit: result.exit,
    잡았나: result.exit !== 0 && result.stdout.includes(probe.rule),
    출력: result.stdout.trim().split('\n').slice(0, 40).join('\n'),
  })
}

const after = runCheck()
const out = {
  at: new Date().toISOString(),
  질문: 'herdr 타입·와이어 모양이 어댑터 밖으로 새는가 — 그리고 그 검사가 실제로 잡는가',
  본검사: { exit: baseline.exit, 판정: report.판정, 파일수: report.범위.파일수, 위반: report.위반.length },
  '음성 대조': negative,
  '되돌린 뒤 재검사': { exit: after.exit, stdout: after.stdout.trim() },
  판정: {
    '경계 위반 0': report.위반.length === 0 && report.판정 === '통과',
    'IPC 타입이 shared 뿐': report['IPC 표면']['shared/types 만인가'],
    '검사가 4규칙 전부 잡는다': negative.every((item) => item.잡았나),
    '되돌린 뒤 다시 통과': after.exit === 0,
  },
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n2-boundary-negative.json', out)
