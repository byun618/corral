// LIFE-518 K3 — check:boundary 양성·음성 대조 묶음과 실행기.
//
// 대조 파일은 **실제 src/ 에 심지 않는다.** `src/` 를 임시 폴더로 통째 복사하고(전체 — fixture 가 아니다)
// 검사기를 그 옆 `scripts/` 에 두어 돌린다. 검사기는 자기 위치에서 APP_DIR 을 정하므로 복사본만 본다.
// 그래서 대조가 중간에 죽어도 저장소에는 남는 파일이 없다(G6). 임시 폴더는 finally 에서 지운다.
//
// 칸 하나 = 대조 파일 하나를 심고 검사기를 한 번 돌린 결과. 「잡았다」 = 그 파일이 기대 규칙으로 위반에 실렸다.
// 기준 검사기는 깨끗한 src 에서도 exit 1(오탐 7파일)이라 exit 로는 못 가른다 — 파일별 위반으로 본다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

const R = 'src/renderer/src/boundary-probe-'
const S = 'src/shared/boundary-probe-'
const M = 'src/main/boundary-probe-'
const P = 'src/preload/boundary-probe-'

const send = (method) => `declare const socket: { write(line: string): void }\nexport const probe = (): void => socket.write(JSON.stringify({ id: 1, method: ${method}, params: { tabId: 'x', title: 'y' } }) + '\\n')\n`
const jsonFrame = (frame) => `export const frame = ${frame}\n`

/**
 * group: K3 소항목. expect: 기대 규칙(null = 위반 0 이어야 하는 음성 대조).
 * flip: 기준 검사기에서 잡히고 고친 검사기에서 안 잡히는 것이 **허용된** 칸 — 01-criteria K3ⓔ 정의 ①·② 뿐.
 */
export const PROBES = [
  // ⓐ 액션 id 와 겹치는 실제 herdr 메서드 `tab.rename` 을 요청 envelope 위치에 — 네 구역 × 두 꼴
  { id: 'a-renderer-obj', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-obj.ts`, source: send("'tab.rename'") },
  { id: 'a-renderer-json', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-json.ts`, source: jsonFrame(`'{"id":1,"method":"tab.rename","params":{}}'`) },
  { id: 'a-shared-obj', group: 'ⓐ', expect: 'R4-wire-leak', file: `${S}a-obj.ts`, source: send("'tab.rename'") },
  { id: 'a-shared-json', group: 'ⓐ', expect: 'R4-wire-leak', file: `${S}a-json.ts`, source: jsonFrame(`'{"id":1,"method":"tab.rename","params":{}}'`) },
  { id: 'a-main-obj', group: 'ⓐ', expect: 'R4-wire-leak', file: `${M}a-obj.ts`, source: send("'tab.rename'") },
  { id: 'a-main-json', group: 'ⓐ', expect: 'R4-wire-leak', file: `${M}a-json.ts`, source: jsonFrame(`'{"id":1,"method":"tab.rename","params":{}}'`) },
  { id: 'a-preload-obj', group: 'ⓐ', expect: 'R4-wire-leak', file: `${P}a-obj.ts`, source: send("'tab.rename'") },
  { id: 'a-preload-json', group: 'ⓐ', expect: 'R4-wire-leak', file: `${P}a-json.ts`, source: jsonFrame(`'{"id":1,"method":"tab.rename","params":{}}'`) },
  // ⓐ envelope 꼴 변형
  { id: 'a-quoted-key', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-quoted-key.ts`, source: 'export const frame = { "id": 1, "method": "tab.rename", "params": {} }\n' },
  { id: 'a-json-spaced', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-json-spaced.ts`, source: jsonFrame(`'{ "id": 1, "method": "tab.rename" }'`) },
  { id: 'a-json-escaped', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-json-escaped.ts`, source: jsonFrame('"{\\"id\\":1,\\"method\\":\\"tab.rename\\"}"') },
  { id: 'a-assign', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-assign.ts`, source: "const msg: { method?: string } = {}\nmsg.method = 'tab.rename'\nexport const probe = msg\n" },
  { id: 'a-compare', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-compare.ts`, source: "export const probe = (frame: { method: string }): boolean => frame.method === 'tab.rename'\n" },
  { id: 'a-const-name', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-const-name.ts`, source: "export const RENAME_METHOD = 'tab.rename'\n" },
  { id: 'a-action-not-herdr', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a-action-not-herdr.ts`, source: send("'tab.cycle'") },
  { id: 'a-workspace-rename', group: 'ⓐ', expect: 'R4-wire-leak', file: `${M}a-workspace-rename.ts`, source: send("'workspace.rename'") },

  // ⓐ fix1 (R1-claude-01) — envelope 값이 리터럴 바로가 아니라 같은 식 안에서 method 와 묶인 꼴. 기준은 토큰만 봐서 잡던 꼴이다
  { id: 'a1-nullish', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-nullish.ts`, source: "declare const x: string | undefined\nexport const probe = { method: x ?? 'tab.rename' }\n" },
  { id: 'a1-paren', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-paren.ts`, source: "export const probe = { method: ('tab.rename') }\n" },
  { id: 'a1-template', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-template.ts`, source: "export const probe = { method: `${'tab.rename'}` }\n" },
  { id: 'a1-helper', group: 'ⓐ', expect: 'R4-wire-leak', file: `${S}a1-helper.ts`, source: "declare function pick(m: string): string\nexport const probe = { method: pick('workspace.rename') }\n" },
  { id: 'a1-ternary', group: 'ⓐ', expect: 'R4-wire-leak', file: `${M}a1-ternary.ts`, source: "declare const c: boolean\nexport const probe = { method: c ? 'tab.cycle' : 'tab.rename' }\n" },
  { id: 'a1-ternary-multiline', group: 'ⓐ', expect: 'R4-wire-leak', file: `${P}a1-ternary-ml.ts`, source: "declare const c: boolean\nexport const probe = {\n  id: 1,\n  method: c\n    ? 'tab.cycle'\n    : 'workspace.rename',\n}\n" },
  { id: 'a1-concat', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-concat.ts`, source: "export const probe = { method: '' + 'tab.rename' }\n" },
  { id: 'a1-yoda', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-yoda.ts`, source: "export const probe = (frame: { method: string }): boolean => 'tab.rename' === frame.method\n" },
  { id: 'a1-includes', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-includes.ts`, source: "export const probe = (msg: { method: string }): boolean => ['tab.rename', 'tab.cycle'].includes(msg.method)\n" },
  { id: 'a1-switch-case', group: 'ⓐ', expect: 'R4-wire-leak', file: `${M}a1-switch.ts`, source: "export const probe = (frame: { method: string }): number => {\n  switch (frame.method) {\n    case 'tab.rename':\n      return 1\n    default:\n      return 0\n  }\n}\n" },
  // fix1 조사(bypass-scan)에서 찾아 고친 두 꼴 — 템플릿 안 JSON 보간 · 식 몸체 화살표
  { id: 'a1-template-json', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-template-json.ts`, source: "export const probe = JSON.parse(`{\"method\":\"${'tab.rename'}\"}`)\n" },
  { id: 'a1-arrow-block', group: 'ⓐ', expect: 'R4-wire-leak', file: `${M}a1-arrow-block.ts`, source: "export const probe = { method: (() => {\n  return 'tab.rename'\n})() }\n" },
  { id: 'a1-arrow-expr', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-arrow-expr.ts`, source: "export const probe = { method: (() => 'tab.rename')() }\n" },
  // R1-claude-04 — envelope 글자 창(80자) 축소 변이를 죽인다: 문자열 안 JSON 은 AST 로 못 보고 글자로만 본다
  { id: 'a1-json-wide', group: 'ⓐ', expect: 'R4-wire-leak', file: `${R}a1-json-wide.ts`, source: jsonFrame(`'{"id":1,"method":${' '.repeat(40)}"tab.rename"}'`) },

  // ⓑ 액션 id 가 아닌 메서드 꼴 문자열 — 아무 위치에나
  { id: 'b-pane-split-const', group: 'ⓑ', expect: 'R4-wire-leak', file: `${R}b-pane-split.ts`, source: "export const probe = 'pane.split'\n" },
  { id: 'b-workspace-list-arg', group: 'ⓑ', expect: 'R4-wire-leak', file: `${S}b-workspace-list.ts`, source: "declare function request(sock: unknown, method: string): void\nexport const probe = (sock: unknown): void => request(sock, 'workspace.list')\n" },
  { id: 'b-session-snapshot-key', group: 'ⓑ', expect: 'R4-wire-leak', file: `${P}b-session-snapshot.ts`, source: "export const probe = { 'session.snapshot': 1 }\n" },
  { id: 'b-ping-compare', group: 'ⓑ', expect: 'R4-wire-leak', file: `${M}b-ping.ts`, source: "export const probe = (m: string): boolean => m === 'ping'\n" },
  { id: 'b-focus-direction', group: 'ⓑ', expect: 'R4-wire-leak', file: `${R}b-focus-direction.ts`, source: "export const probe = { kind: 'pane.focus_direction' }\n" },
  { id: 'b-log-real-method', group: 'ⓑ', expect: 'R4-wire-leak', file: `${M}b-log-real.ts`, source: "import { log } from './log.js'\nlog('worktree.list', {})\nlog('pane.split', {})\n" },
  { id: 'b-local-log', group: 'ⓑ', expect: 'R4-wire-leak', file: `${M}b-local-log.ts`, source: "const log = (tag: string): string => tag\nexport const probe = log('worktree.changed')\n" },
  { id: 'b-log-second-arg', group: 'ⓑ', expect: 'R4-wire-leak', file: `${M}b-log-second.ts`, source: "import { log } from './log.js'\nlog('probe.tag', { method: 'tab.create' })\n" },
  { id: 'b-renderer-log', group: 'ⓑ', expect: 'R4-wire-leak', file: `${R}b-renderer-log.ts`, source: "declare function log(tag: string): void\nlog('worktree.changed')\n" },
  // R1-claude-04 — 로그 면제의 zone 조건·lookbehind 를 각각 죽인다
  { id: 'b-renderer-main-log', group: 'ⓑ', expect: 'R4-wire-leak', file: `${R}b-renderer-main-log.ts`, source: "import { log } from '../../main/log.js'\nlog('worktree.changed', {})\n" },
  { id: 'b-console-log', group: 'ⓑ', expect: 'R4-wire-leak', file: `${M}b-console-log.ts`, source: "import { log } from './log.js'\nlog('probe.tag', {})\nconsole.log('worktree.changed')\n" },
  // R1-claude-05 — ACTIONS 안 **주석** 의 `id:` 는 어휘가 아니다. 주석에 `pane.split` 을 심고, 다른 파일의 envelope 밖 `pane.split` 이 그대로 잡히는지
  { id: 'b-vocab-comment', group: 'ⓑ', expect: 'R4-wire-leak', file: `${R}b-vocab-comment.ts`, source: "export const probe = { kind: 'pane.split' }\n", patch: { file: 'src/shared/keybindings.ts', find: 'export const ACTIONS = [\n', replace: "export const ACTIONS = [\n  // { id: 'pane.split', group: '전역', title: 'x', defaultBinding: [], bindingVariants: [], variants: [] },\n" } },

  // ⓒ 따옴표 3종 · 템플릿 `${…}`
  { id: 'c-double', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-double.ts`, source: 'export const probe = "pane.list"\n' },
  { id: 'c-backtick', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-backtick.ts`, source: 'export const probe = `pane.list`\n' },
  { id: 'c-template-inner', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-template.ts`, source: "const f = (m: string): string => m\nexport const probe = `x ${f('workspace.list')} y`\n" },
  { id: 'c-template-envelope', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-template-env.ts`, source: "export const probe = `${JSON.stringify({ method: `tab.rename` })}\\n`\n" },
  // R1-claude-03 — 닫는 따옴표 앞 `\\` 허용이 이스케이프 따옴표 속 이름을 새로 잡는다(엄격 방향 — 기준은 못 잡음)
  { id: 'c-escaped-quote', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-escaped-quote.ts`, source: "export const probe = 'say \\'pane.list\\' now'\n" },
  { id: 'c-backtick-envelope', group: 'ⓒ', expect: 'R4-wire-leak', file: `${P}c-backtick-env.ts`, source: 'export const probe = { method: `tab.rename` }\n' },

  // ⓓ 필드·이벤트·envelope 지문, R1·R2·R3 (l351/m1-boundary.mjs 와 같은 깊이)
  { id: 'd-field', group: 'ⓓ', expect: 'R4-wire-leak', file: `${R}d-field.ts`, source: "export const probe = (row: Record<string, unknown>): unknown => row['open_workspace_id']\n" },
  { id: 'd-field-template', group: 'ⓓ', expect: 'R4-wire-leak', file: `${R}d-field-template.ts`, source: "const f = (x: Record<string, unknown>): unknown => x['a']\nexport const probe = `pane ${f({ pane_id: 1 })}`\n" },
  { id: 'd-event', group: 'ⓓ', expect: 'R4-wire-leak', file: `${R}d-event.ts`, source: "export const probe = (frame: { event: string }): boolean => frame.event === 'tab_moved'\n" },
  { id: 'd-envelope', group: 'ⓓ', expect: 'R4-wire-leak', file: `${M}d-envelope.ts`, source: "export const probe = { method: 'x', subscriptions: [] as string[], kind: 'events.subscribe' }\n" },
  { id: 'd-r1', group: 'ⓓ', expect: 'R1-internal', file: `${M}d-r1.ts`, source: "import { WorkspaceStore } from './adapter/internal/store.js'\nexport const probe = WorkspaceStore\n" },
  { id: 'd-r2', group: 'ⓓ', expect: 'R2-adapter', file: `${R}d-r2.ts`, source: "import { SessionLink } from '../../main/adapter/index.js'\nexport const probe = SessionLink\n" },
  { id: 'd-r3', group: 'ⓓ', expect: 'R3-shared-pure', file: `${S}d-r3.ts`, source: "import { log } from '../main/log.js'\nexport const probe = log\n" },

  // IPC 표면 (01-criteria 기준 정정 Q1) — preload/index.ts 에 import 한 줄을 **덧붙인다**(mode append, 끝나면 원문 복원).
  // R1~R3 는 preload → main 비어댑터·renderer import 를 안 본다 — 이 조건이 유일한 가드다.
  { id: 'i-preload-main', group: 'IPC', expect: 'IPC', mode: 'append', file: 'src/preload/index.ts', source: "\nimport { log as boundaryProbeLog } from '../main/log.js'\nexport const boundaryProbe = boundaryProbeLog\n" },
  { id: 'i-preload-renderer', group: 'IPC', expect: 'IPC', mode: 'append', file: 'src/preload/index.ts', source: "\nimport App from '../renderer/src/App.js'\nexport const boundaryProbe = App\n" },
  { id: 'i-preload-shared-sibling', group: 'IPC', expect: 'IPC', mode: 'append', file: 'src/preload/index.ts', source: "\nimport type { X as BoundaryProbeX } from '../shared-x/types.js'\nexport type BoundaryProbe = BoundaryProbeX\n" },
  { id: 'i-preload-fake-shared-types', group: 'IPC', expect: 'IPC', mode: 'append', file: 'src/preload/index.ts', source: "\nimport type { X as BoundaryProbeX } from '../main/shared/types.js'\nexport type BoundaryProbe = BoundaryProbeX\n" },

  // ⓔ 음성 대조 — 원래 7파일의 꼴. 기준은 잡고 고친 쪽은 위반 0 이어야 한다
  { id: 'e-action-table', expectComment: [], group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${S}e-action-table.ts`, source: "export const TABLE = [\n  { id: 'tab.rename', title: 'a' },\n  { id: 'workspace.delete', title: 'b' },\n  { id: 'tab.selectByIndex', title: 'c' },\n] as const\n" },
  { id: 'e-binding-label', expectComment: [], group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${R}e-binding-label.tsx`, source: "declare function bindingLabel(id: string): string\nexport const Item = (): string => `이름 바꾸기 ${bindingLabel('tab.rename')}`\n" },
  { id: 'e-keyed-object', expectComment: [], group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${R}e-keyed-object.ts`, source: "export const handlers: Record<string, () => void> = {\n  'workspace.rename': () => {},\n  'tab.reopenClosed': () => {},\n  'tab.cycle': () => {},\n}\n" },
  { id: 'e-test-expect', expectComment: [], group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${M}e-test-expect.ts`, source: "declare const expect: (v: unknown) => { toBe(x: unknown): void }\nexport const probe = (v: string): void => expect(v).toBe(\"tab.selectByIndex\")\n" },
  { id: 'e-log-tag', expectComment: [], group: 'ⓔ', expect: null, flip: 'ⓔ②', file: `${M}e-log-tag.ts`, source: "import { log } from './log.js'\nlog('worktree.changed', { roots: 1 })\nexport const probe = (count: number): void => log('worktree.poll_roots', { count })\n" },

  // fix1 — 함수 식 너머로 올라가는 판정이 테스트 이름 같은 **문장 꼴 문자열**을 method 로 읽지 않는다
  { id: 'e-test-name-method', expectComment: [], group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${M}e-test-name.ts`, source: "declare function it(name: string, fn: () => void): void\ndeclare const expect: (v: unknown) => { toBe(x: unknown): void }\nit('method 를 보여 준다', () => {\n  expect('x').toBe('tab.rename')\n})\n" },
  // R1-claude-04 — 주석언급 칸: 주석에만 있는 토큰은 주석언급에 실리고(위반 아님), 면제된 코드 토큰(위 ⓔ 칸 expectComment [])은 실리지 않는다
  { id: 'e-comment-only', expectComment: ["'pane.split'"], group: 'ⓔ', expect: null, file: `${R}e-comment-only.ts`, source: "// 'pane.split' 은 주석에만 있다\nexport const probe = 1\n" },

  // ⓕ 행렬에 넣으라고 지정한 envelope 밖 호출 인자 — ⓔ① 에 드는 알려진 사각
  { id: 'f-request-outside', expectComment: [], group: 'ⓕ', expect: null, flip: 'ⓔ①', file: `${R}f-request-outside.ts`, source: "declare function request(sock: unknown, method: string): void\nexport const probe = (sock: unknown): void => request(sock, 'tab.rename')\n" },
  // ⓔ② 에 드는 사각 — main 로그 태그가 herdr 메서드 목록에 없는 메서드 꼴
  { id: 'f-log-unknown-method', expectComment: [], group: 'ⓕ', expect: null, flip: 'ⓔ②', file: `${M}f-log-unknown.ts`, source: "import { log } from './log.js'\nlog('pane.focus_direction', {})\n" },
]

/** 검사기 원문을 받아 `<tmp>/scripts/check-boundary.mjs` + `<tmp>/src`(전체 복사) + `<tmp>/node_modules`(링크 — 검사기가 typescript 를 쓴다) 를 만든다. */
function makeSandbox(checkerSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l518-probe-'))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts/check-boundary.mjs'), checkerSource)
  fs.cpSync(path.join(APP_DIR, 'src'), path.join(root, 'src'), { recursive: true })
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  return root
}

/** 칸이 기대대로인가 — nodetest·행렬·변이가 같은 판정식을 쓴다. */
export function cellOk({ probe, cell }) {
  const rules = probe.expect === null ? !cell.caught && cell.exit === 0 : cell.caught && cell.exit === 1
  const comments = probe.expectComment === undefined || JSON.stringify([...cell.commentTokens].sort()) === JSON.stringify([...probe.expectComment].sort())
  return rules && comments
}

function runChecker(root) {
  const outFile = path.join(root, 'out.json')
  fs.rmSync(outFile, { force: true })
  let exit = 0
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts/check-boundary.mjs'), outFile], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    exit = error.status ?? -1
  }
  const report = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null
  return { exit, report }
}

/**
 * 검사기 하나로 대조 묶음 전체를 돌린다. 반환: { clean, cells: [{ id, exit, rules, tokens, caught }] }.
 * caught = 그 대조 파일이 기대 규칙으로 실렸다(음성 대조는 그 파일의 위반이 하나라도 있으면 true).
 */
export function runProbes({ checkerSource, probes = PROBES }) {
  const root = makeSandbox(checkerSource)
  try {
    const clean = runChecker(root)
    const cells = probes.map((probe) => {
      const target = path.join(root, probe.file)
      const original = probe.mode === 'append' ? fs.readFileSync(target, 'utf8') : null
      const patchTarget = probe.patch ? path.join(root, probe.patch.file) : null
      const patchOriginal = patchTarget ? fs.readFileSync(patchTarget, 'utf8') : null
      try {
        if (patchTarget) {
          if (!patchOriginal.includes(probe.patch.find)) throw new Error(`${probe.id}: 덧댈 자리 없음 — ${probe.patch.find}`)
          fs.writeFileSync(patchTarget, patchOriginal.replace(probe.patch.find, probe.patch.replace))
        }
        fs.writeFileSync(target, (original ?? '') + probe.source)
        const { exit, report } = runChecker(root)
        const mine = (report?.위반 ?? []).filter((item) => item.file === probe.file)
        // IPC 칸 키는 기준판 `shared/types 만인가` → 지금판 `src/shared 만인가` (Q1 정정).
        const surface = report?.['IPC 표면'] ?? {}
        const ipcOk = surface['src/shared 만인가'] ?? surface['shared/types 만인가']
        const rules = [...new Set(mine.map((item) => item.rule)), ...(ipcOk === false ? ['IPC'] : [])]
        return {
          id: probe.id,
          exit,
          rules,
          tokens: mine.flatMap((item) => item.tokens ?? [item.specifier]),
          commentTokens: (report?.주석언급?.항목 ?? []).filter((item) => item.file === probe.file).flatMap((item) => item.tokens),
          caught: probe.expect === null ? mine.length > 0 : rules.includes(probe.expect),
        }
      } finally {
        if (original === null) fs.rmSync(target, { force: true })
        else fs.writeFileSync(target, original)
        if (patchTarget) fs.writeFileSync(patchTarget, patchOriginal)
      }
    })
    const surface = clean.report?.['IPC 표면'] ?? {}
    return {
      clean: { exit: clean.exit, 위반: clean.report?.위반.length ?? null, 파일수: clean.report?.범위.파일수 ?? null, ipc: surface['src/shared 만인가'] ?? surface['shared/types 만인가'] ?? null },
      cells,
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
