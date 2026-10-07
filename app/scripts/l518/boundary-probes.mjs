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

  // ⓒ 따옴표 3종 · 템플릿 `${…}`
  { id: 'c-double', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-double.ts`, source: 'export const probe = "pane.list"\n' },
  { id: 'c-backtick', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-backtick.ts`, source: 'export const probe = `pane.list`\n' },
  { id: 'c-template-inner', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-template.ts`, source: "const f = (m: string): string => m\nexport const probe = `x ${f('workspace.list')} y`\n" },
  { id: 'c-template-envelope', group: 'ⓒ', expect: 'R4-wire-leak', file: `${R}c-template-env.ts`, source: "export const probe = `${JSON.stringify({ method: `tab.rename` })}\\n`\n" },
  { id: 'c-backtick-envelope', group: 'ⓒ', expect: 'R4-wire-leak', file: `${P}c-backtick-env.ts`, source: 'export const probe = { method: `tab.rename` }\n' },

  // ⓓ 필드·이벤트·envelope 지문, R1·R2·R3 (l351/m1-boundary.mjs 와 같은 깊이)
  { id: 'd-field', group: 'ⓓ', expect: 'R4-wire-leak', file: `${R}d-field.ts`, source: "export const probe = (row: Record<string, unknown>): unknown => row['open_workspace_id']\n" },
  { id: 'd-field-template', group: 'ⓓ', expect: 'R4-wire-leak', file: `${R}d-field-template.ts`, source: "const f = (x: Record<string, unknown>): unknown => x['a']\nexport const probe = `pane ${f({ pane_id: 1 })}`\n" },
  { id: 'd-event', group: 'ⓓ', expect: 'R4-wire-leak', file: `${R}d-event.ts`, source: "export const probe = (frame: { event: string }): boolean => frame.event === 'tab_moved'\n" },
  { id: 'd-envelope', group: 'ⓓ', expect: 'R4-wire-leak', file: `${M}d-envelope.ts`, source: "export const probe = { method: 'x', subscriptions: [] as string[], kind: 'events.subscribe' }\n" },
  { id: 'd-r1', group: 'ⓓ', expect: 'R1-internal', file: `${M}d-r1.ts`, source: "import { WorkspaceStore } from './adapter/internal/store.js'\nexport const probe = WorkspaceStore\n" },
  { id: 'd-r2', group: 'ⓓ', expect: 'R2-adapter', file: `${R}d-r2.ts`, source: "import { SessionLink } from '../../main/adapter/index.js'\nexport const probe = SessionLink\n" },
  { id: 'd-r3', group: 'ⓓ', expect: 'R3-shared-pure', file: `${S}d-r3.ts`, source: "import { log } from '../main/log.js'\nexport const probe = log\n" },

  // ⓔ 음성 대조 — 원래 7파일의 꼴. 기준은 잡고 고친 쪽은 위반 0 이어야 한다
  { id: 'e-action-table', group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${S}e-action-table.ts`, source: "export const TABLE = [\n  { id: 'tab.rename', title: 'a' },\n  { id: 'workspace.delete', title: 'b' },\n  { id: 'tab.selectByIndex', title: 'c' },\n] as const\n" },
  { id: 'e-binding-label', group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${R}e-binding-label.tsx`, source: "declare function bindingLabel(id: string): string\nexport const Item = (): string => `이름 바꾸기 ${bindingLabel('tab.rename')}`\n" },
  { id: 'e-keyed-object', group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${R}e-keyed-object.ts`, source: "export const handlers: Record<string, () => void> = {\n  'workspace.rename': () => {},\n  'tab.reopenClosed': () => {},\n  'tab.cycle': () => {},\n}\n" },
  { id: 'e-test-expect', group: 'ⓔ', expect: null, flip: 'ⓔ①', file: `${M}e-test-expect.ts`, source: "declare const expect: (v: unknown) => { toBe(x: unknown): void }\nexport const probe = (v: string): void => expect(v).toBe(\"tab.selectByIndex\")\n" },
  { id: 'e-log-tag', group: 'ⓔ', expect: null, flip: 'ⓔ②', file: `${M}e-log-tag.ts`, source: "import { log } from './log.js'\nlog('worktree.changed', { roots: 1 })\nexport const probe = (count: number): void => log('worktree.poll_roots', { count })\n" },

  // ⓕ 행렬에 넣으라고 지정한 envelope 밖 호출 인자 — ⓔ① 에 드는 알려진 사각
  { id: 'f-request-outside', group: 'ⓕ', expect: null, flip: 'ⓔ①', file: `${R}f-request-outside.ts`, source: "declare function request(sock: unknown, method: string): void\nexport const probe = (sock: unknown): void => request(sock, 'tab.rename')\n" },
  // ⓔ② 에 드는 사각 — main 로그 태그가 herdr 메서드 목록에 없는 메서드 꼴
  { id: 'f-log-unknown-method', group: 'ⓕ', expect: null, flip: 'ⓔ②', file: `${M}f-log-unknown.ts`, source: "import { log } from './log.js'\nlog('pane.focus_direction', {})\n" },
]

/** 검사기 원문을 받아 `<tmp>/scripts/check-boundary.mjs` + `<tmp>/src`(전체 복사) 를 만든다. */
function makeSandbox(checkerSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'l518-probe-'))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts/check-boundary.mjs'), checkerSource)
  fs.cpSync(path.join(APP_DIR, 'src'), path.join(root, 'src'), { recursive: true })
  return root
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
export function runProbes(checkerSource, probes = PROBES) {
  const root = makeSandbox(checkerSource)
  try {
    const clean = runChecker(root)
    const cells = probes.map((probe) => {
      const target = path.join(root, probe.file)
      fs.writeFileSync(target, probe.source)
      try {
        const { exit, report } = runChecker(root)
        const mine = (report?.위반 ?? []).filter((item) => item.file === probe.file)
        const rules = [...new Set(mine.map((item) => item.rule))]
        return {
          id: probe.id,
          exit,
          rules,
          tokens: mine.flatMap((item) => item.tokens ?? [item.specifier]),
          caught: probe.expect === null ? mine.length > 0 : rules.includes(probe.expect),
        }
      } finally {
        fs.rmSync(target, { force: true })
      }
    })
    return { clean: { exit: clean.exit, 위반: clean.report?.위반.length ?? null, 파일수: clean.report?.범위.파일수 ?? null }, cells }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
