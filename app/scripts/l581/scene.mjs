// LIFE-581 최종 관문 — 에뮬레이터 캡처용 격리 장면(합성 기록뿐 — 사용자 대화 없음, G5). 격리 개발 Electron(HOME=<ROOT>/home)에 상태별 대화 채널을 만든다.
//   node scripts/l581/scene.mjs build --root /tmp/l581g-x --fake /tmp/l581g-fx --out <scene.json>
//   node scripts/l581/scene.mjs add --root … --scene <scene.json> --name <채널> --kind <reply|tool|tool_result|prompt|question|…> [--marker M] [--opts JSON]
//   node scripts/l581/scene.mjs close --root … --scene <scene.json> --name <채널>   — herdr 에서 pane 을 직접 닫는다(보존 행 C19)
// 채널(각각 레포 하나 — 목록에서 이름으로 찾는다):
//   c01-working  claude 작업 중 — 지시 · 답 · 도구 묶음(Read ok · Bash 진행 중)            C1
//   c02-tools    claude 한가 — 도구 5개 묶음(성공·실패 섞음) · 답                          C2 · 실패 색
//   c08-stopped  claude 중단 표지로 끝남                                                    C8
//   c09-failed   claude API 오류로 끝남                                                     C9
//   c10-watch    claude 백그라운드 셸(backgroundTaskId) 뒤 한가 = 지켜보는 중               C10
//   c11-idle     codex 한가 — 지시 · 답 · 도구 · 질문(미답) · 답한 질문 = 말풍선 4종       C11 · 4종
//   c13-markdown grok 한가 — 코드(긴 줄) · 표(5열) · 30줄 답(24줄 접기) · 목록             C13
//   c15-nodetail grok 이름 없는 도구 묶음(title 없음) = `도구 실행 N회`                     C15
//   c16-long     claude 지시·답 70쌍(140 말풍선) — 과거 페이지 3장                          C16 · 위치 유지
//   c19-closed   claude done 뒤 herdr 에서 닫음 = 보존 행(지난 기록)                        C19 · Y7
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { checkRoots, herdr, setMobile } from './lib.mjs'
import { Conversation, agentPane } from './rec.mjs'

const { positionals, values: args } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, fake: { type: 'string' }, out: { type: 'string' }, scene: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, marker: { type: 'string' }, opts: { type: 'string' } } })
const cmd = positionals[0]
const ROOT = args.root
if (!/^\/tmp\/l581g-[^/]+$/.test(ROOT ?? '')) {
  console.error('--root /tmp/l581g-* 필요')
  process.exit(2)
}

const longReply = Array.from({ length: 30 }, (_, i) => `${i + 1}. 합성 줄 ${i + 1} — 접기 확인용 문장입니다.`).join('\n')
const markdown = [
  '코드와 표를 같이 보입니다.',
  '',
  '```ts',
  'export function syntheticVeryLongFunctionName(parameterOne: string, parameterTwo: number): string { return `${parameterOne}-${parameterTwo}-이 줄은 화면보다 길어 가로로 밀어야 합니다` }',
  'const short = 1',
  '```',
  '',
  '| 열1 | 열2 | 열3 | 열4 | 열5 |',
  '| --- | --- | --- | --- | --- |',
  '| 가 | 나 | 다 | 라 | 마 |',
  '| 바 | 사 | 아 | 자 | 차 |',
  '',
  '- 목록 하나 `inline`',
  '- 목록 둘 **굵게**',
].join('\n')

async function build() {
  checkRoots({ root: ROOT, fake: args.fake })
  await setMobile(ROOT, args.fake, true).catch(() => {})
  const tag = Date.now().toString(36)
  const scene = {}
  const make = async (name, agent, state, write, extra = {}) => {
    const id = `l581-scene-${name}-${tag}`
    const conv = new Conversation({ root: ROOT, agent, id })
    write(conv)
    const { paneId } = await agentPane({ root: ROOT, name, agent, id, state, ...extra })
    scene[name] = { paneId, agent, id, file: conv.file, n: conv.n, last: conv.last }
    console.log(JSON.stringify({ name, paneId, agent }))
  }
  await make('c01-working', 'claude', 'working', (c) => {
    c.write('prompt', 'C1 테스트 실행해 줘')
    c.write('reply', 'C1', { text: '먼저 파일을 읽고 테스트를 돌립니다.' })
    c.write('tool', 'C1-read', { name: 'Read', callId: 'r1', messageId: 'mt1', input: { file_path: 'src/a.ts' } })
    c.write('tool_result', 'x', { callId: 'r1' })
    c.write('tool', 'C1-run', { name: 'Bash', callId: 'b1', messageId: 'mt1', input: { command: 'npm test', description: 'test' } })
  })
  await make('c02-tools', 'claude', 'idle', (c) => {
    c.write('prompt', 'C2 고쳐 줘')
    c.write('tool', 'C2-a', { name: 'Read', callId: 't1', messageId: 'mt', input: { file_path: 'src/a.ts' } })
    c.write('tool', 'C2-b', { name: 'Edit', callId: 't2', messageId: 'mt', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } })
    c.write('tool', 'C2-c', { name: 'Bash', callId: 't3', messageId: 'mt', input: { command: 'npm run typecheck', description: 'typecheck' } })
    c.write('tool', 'C2-d', { name: 'Grep', callId: 't4', messageId: 'mt', input: { pattern: 'TODO' } })
    c.write('tool', 'C2-e', { name: 'Bash', callId: 't5', messageId: 'mt', input: { command: 'npm test', description: 'test' } })
    for (const [id, error] of [['t1', false], ['t2', false], ['t3', true], ['t4', false], ['t5', false]]) c.write('tool_result', 'x', { callId: id, error })
    c.write('reply', 'C2', { text: '타입 오류 하나를 고쳤고 시험은 통과합니다.' })
  })
  await make('c08-stopped', 'claude', 'idle', (c) => {
    c.write('prompt', 'C8 오래 걸리는 일')
    c.write('tool', 'C8', { name: 'Bash', callId: 's1', input: { command: 'sleep 600', description: 'wait' } })
    c.write('interrupt', 'x')
  })
  await make('c09-failed', 'claude', 'idle', (c) => {
    c.write('prompt', 'C9 요약해 줘')
    c.write('api_error', 'overloaded — 잠시 뒤 다시 시도')
  })
  await make('c10-watch', 'claude', 'idle', (c) => {
    c.write('prompt', 'C10 서버를 띄워 둬')
    c.write('tool', 'C10', { name: 'Bash', callId: 'bg1', input: { command: 'npm run dev', description: 'dev server', run_in_background: true } })
    c.write('tool_result', 'x', { callId: 'bg1', toolUseResult: { backgroundTaskId: 'task-bg-1' } })
    c.write('reply', 'C10', { text: '개발 서버를 백그라운드로 띄웠습니다. 지켜보는 중입니다.' })
  })
  await make('c11-idle', 'codex', 'idle', (c) => {
    c.write('prompt', 'C11 상태 정리')
    c.write('reply', 'C11', { text: '정리했습니다. 확인할 것이 하나 있습니다.' })
    c.write('tool', 'C11-ls', { callId: 'x1' })
    c.write('tool_result', 'x', { callId: 'x1' })
    c.write('question', 'C11 배포할까요')
  })
  await make('c13-markdown', 'grok', 'idle', (c) => {
    c.write('prompt', 'C13 코드와 표로 보여 줘')
    c.write('reply', 'C13', { text: markdown })
    c.write('turn_end', 'x')
    c.write('prompt', 'C13 길게 설명해 줘')
    c.write('reply', 'C13-long', { text: longReply })
    c.write('turn_end', 'x')
  })
  await make('c15-nodetail', 'grok', 'idle', (c) => {
    c.write('prompt', 'C15 정리해 줘')
    c.write('tool', 'C15-a', { name: null, callId: 'n1' })
    c.write('tool', 'C15-b', { name: null, callId: 'n2' })
    c.write('tool', 'C15-c', { name: null, callId: 'n3' })
    c.write('tool_result', 'x', { callId: 'n1' })
    c.write('tool_result', 'x', { callId: 'n2' })
    c.write('tool_result', 'x', { callId: 'n3' })
    c.write('reply', 'C15', { text: '정리를 마쳤습니다.' })
    c.write('turn_end', 'x')
  })
  await make('c16-long', 'claude', 'idle', (c) => {
    for (let i = 1; i <= 70; i += 1) {
      c.write('prompt', `C16 지시 ${String(i).padStart(2, '0')}`)
      c.write('reply', `C16-${i}`, { text: `C16 답 ${String(i).padStart(2, '0')} — 과거 불러오기 확인용` })
    }
  })
  await make('c19-closed', 'claude', 'idle', (c) => {
    c.write('prompt', 'C19 끝난 세션의 지시')
    c.write('reply', 'C19', { text: 'C19 끝난 세션의 마지막 답 — 지난 기록으로 남습니다.' })
  }, { states: ['working', 'idle'] })
  fs.writeFileSync(args.out, JSON.stringify(scene, null, 2))
}

function load() {
  const scene = JSON.parse(fs.readFileSync(args.scene, 'utf8'))
  const entry = scene[args.name]
  if (entry === undefined) throw new Error(`장면에 없다: ${args.name}`)
  return { scene, entry }
}

async function add() {
  const { scene, entry } = load()
  const conv = new Conversation({ root: ROOT, agent: entry.agent, id: entry.id })
  conv.n = entry.n + 1000
  conv.last = entry.last
  const at = conv.write(args.kind, args.marker ?? `L581-ADD-${Date.now().toString(36)}`, args.opts === undefined ? {} : JSON.parse(args.opts))
  scene[args.name] = { ...entry, n: conv.n, last: conv.last }
  fs.writeFileSync(args.scene, JSON.stringify(scene, null, 2))
  console.log(JSON.stringify({ at, name: args.name, kind: args.kind }))
}

async function close() {
  const { entry } = load()
  await herdr(ROOT, 'pane.close', { pane_id: entry.paneId })
  console.log(JSON.stringify({ at: Date.now(), closed: args.name, paneId: entry.paneId }))
}

const run = { build, add, close }[cmd]
if (run === undefined) {
  console.error('명령: build · add · close')
  process.exit(2)
}
run().catch((error) => {
  console.error(error)
  process.exit(1)
})
