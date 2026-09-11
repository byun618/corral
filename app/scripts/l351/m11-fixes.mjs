// M11 — 수정 1회차에서 **앱·저장소 재생만으로는 안 보이는** 것들을 따로 잰다.
//
//   M4 connect 시한   — 연결이 얼면 시한 안에 거절되는가 · resyncing 이 풀리는가
//   M6 세션 자동 선택 — running:false 를 거르는가 · 명시 세션이 죽었으면 사유가 나오나
//   L1 ack 타이머     — 받으면 꺼지는가 (안 꺼지면 프로세스가 시한만큼 안 끝난다)
//   L8 경로 정규화    — symlink 로 등록해도 git·herdr 와 같은 경로가 되는가
//
// 앱을 띄우지 않는다. 재는 것이 전부 **한 모듈의 규칙**이라 재생이 더 날카롭다 —
// 멈춘 herdr 세션을 실제로 만들어 두면 그 상태가 다른 측정에까지 번진다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { APP_DIR, REPO_DIR, writeRaw } from './lib.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l351-fix1-'))
function bundle(relative, name) {
  const outFile = path.join(tmp, `${name}.mjs`)
  execFileSync(path.join(APP_DIR, 'node_modules/.bin/esbuild'), [
    path.join(APP_DIR, relative),
    '--bundle', '--format=esm', '--platform=node', `--outfile=${outFile}`,
  ])
  return outFile
}

const out = { at: new Date().toISOString() }

// ── M6 세션 자동 선택 ───────────────────────────────────────────────────────
{
  const { pickSessionName } = await import(bundle('src/main/pick-session.ts', 'pick'))
  const 사례 = (설명, sessions, wanted) => ({ 설명, wanted: wanted ?? null, sessions, ...pickSessionName({ sessions, wanted }) })
  const D = (running) => ({ name: 'default', isDefault: true, running })
  const N = (name, running) => ({ name, isDefault: false, running })

  const cases = [
    사례('default 가 살아 있으면 default', [D(true), N('life351-claude', true)]),
    사례('default 가 멈췄으면 살아 있는 것으로 (1회차는 여기서 죽은 소켓에 붙었다)', [D(false), N('life351-claude', true)]),
    사례('전부 멈췄으면 아무것도 안 고른다', [D(false), N('a', false)]),
    사례('세션이 없으면 아무것도 안 고른다', []),
    사례('명시 세션이 살아 있으면 그것', [D(true), N('life351-claude', true)], 'life351-claude'),
    사례('명시 세션이 멈췄으면 **갈아타지 않고** 사유를 낸다', [D(true), N('life351-claude', false)], 'life351-claude'),
    사례('명시 세션이 없으면 사유를 낸다', [D(true)], 'nope'),
  ]
  out['M6 세션 자동 선택'] = {
    질문: 'running:false 를 거르는가 · 명시 세션이 죽었을 때 몰래 갈아타지 않는가',
    cases,
    읽은것: {
      '멈춘 default 를 안 고른다': cases[1].name === 'life351-claude',
      '멈춘 default 를 골랐을 때 사유가 붙는다': cases[1].note !== null,
      '전부 멈추면 null': cases[2].name === null && cases[3].name === null,
      '명시 세션이 죽어도 다른 것으로 안 간다': cases[5].name === null,
      '그때 사유가 화면에 갈 문장이다': typeof cases[5].note === 'string' && cases[5].note.includes('멈춰'),
    },
  }
}

// ── M4 connect 시한 ─────────────────────────────────────────────────────────
{
  const { LineSocket } = await import(bundle('src/main/adapter/internal/line-socket.ts', 'line'))
  // **받아만 놓고 아무 응답도 안 하는 서버**가 아니라, 연결 자체가 얼어야 한다.
  // 유닉스 소켓은 backlog 가 차도 커널이 받아 주므로, 얼음은 net.Socket.connect 를 막아 만든다.
  const real = net.Socket.prototype.connect
  net.Socket.prototype.connect = function frozen() {
    return this // 아무 이벤트도 내지 않는다 — 1회차라면 여기서 영영 멈춘다
  }
  const socket = new LineSocket({ onLine: () => {}, onClose: () => {}, onError: () => {} })
  const startedAt = Date.now()
  let 결과 = null
  try {
    await socket.connect('/tmp/l351-frozen.sock', 700)
    결과 = { 풀렸나: true, 어떻게: 'resolve' }
  } catch (error) {
    결과 = { 풀렸나: true, 어떻게: 'reject', code: error.code ?? null, message: String(error.message ?? error) }
  }
  const ms = Date.now() - startedAt
  net.Socket.prototype.connect = real
  out['M4 connect 시한'] = {
    질문: '연결이 얼면 connect 프라미스가 시한 안에 풀리는가 (1회차에는 안 풀렸다)',
    시한ms: 700,
    걸린ms: ms,
    결과,
    읽은것: {
      '시한 안에 거절됐다': 결과.어떻게 === 'reject' && ms < 3000,
      'connect_timeout 으로 식별된다': 결과.code === 'connect_timeout',
    },
  }
}

// ── L1 ack 타임아웃 타이머 ──────────────────────────────────────────────────
{
  // 타이머가 살아 있으면 **이벤트 루프가 그만큼 더 돈다.** 그걸 그대로 잰다:
  // ack 를 즉시 주는 가짜 서버에 붙었다 끊고, 프로세스가 언제 끝나는지 본다.
  const script = `
    import net from 'node:net'
    import { Subscription } from '${bundle('src/main/adapter/internal/subscription.ts', 'sub')}'
    const sock = '${path.join(tmp, 'ack.sock')}'
    const server = net.createServer((socket) => {
      socket.on('data', () => socket.write(JSON.stringify({ id: 'sub', result: { ok: true } }) + '\\n'))
    })
    await new Promise((resolve) => server.listen(sock, resolve))
    const sub = new Subscription({ onPush: () => {}, onDrop: () => {} })
    await sub.connect(sock, ['tab.created'], 5000)
    sub.close()
    server.close()
    // 여기서 프로세스가 곧바로 끝나야 한다. ack 타이머가 살아 있으면 5초를 더 붙든다.
  `
  const file = path.join(tmp, 'ack-probe.mjs')
  fs.writeFileSync(file, script)
  const startedAt = Date.now()
  execFileSync(process.execPath, [file], { stdio: 'ignore', timeout: 20000, env: { ...process.env, CORRAL_LOG: '' } })
  const ms = Date.now() - startedAt
  out['L1 ack 타임아웃 타이머'] = {
    질문: 'ack 를 받은 뒤 5초짜리 타이머가 남아 프로세스를 붙드는가',
    'ack 시한ms': 5000,
    '프로세스가 끝나기까지ms': ms,
    읽은것: { '시한보다 훨씬 일찍 끝난다 (타이머가 꺼졌다)': ms < 3000 },
  }
}

// ── L8 경로 정규화 ──────────────────────────────────────────────────────────
{
  const { canonicalPath } = await import(bundle('src/main/canonical-path.ts', 'canon'))
  const link = path.join(tmp, 'repo-link')
  fs.symlinkSync(REPO_DIR, link)
  const direct = canonicalPath(REPO_DIR)
  const viaLink = canonicalPath(link)
  // `git worktree list` 는 **주 체크아웃부터** 준다 — 지금 서 있는 worktree 가 첫 줄이 아니다.
  // 그래서 "첫 줄과 같나" 가 아니라 "목록 안에 있나" 로 본다.
  const gitPaths = execFileSync('git', ['-C', REPO_DIR, 'worktree', 'list', '--porcelain'])
    .toString()
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalPath(line.slice('worktree '.length).trim()))
  out['L8 경로 정규화'] = {
    질문: 'symlink 로 준 경로가 git·herdr 가 주는 경로와 같아지는가',
    준값: link,
    정규화: viaLink,
    'REPO_DIR 정규화': direct,
    'git 이 주는 경로들': gitPaths,
    '없는 경로도 던지지 않는가': canonicalPath('/tmp/l351-없는경로-xyz'),
    읽은것: {
      'symlink 가 실경로로 접힌다': viaLink === direct,
      'git 목록 안에 그 경로가 있다': gitPaths.includes(viaLink),
      '없는 경로는 resolve 결과로 물러난다': canonicalPath('/tmp/l351-없는경로-xyz') === '/tmp/l351-없는경로-xyz',
    },
  }
}

out.판정 = Object.fromEntries(
  Object.entries(out)
    .filter(([, value]) => value !== null && typeof value === 'object' && value.읽은것 !== undefined)
    .flatMap(([key, value]) => Object.entries(value.읽은것).map(([name, ok]) => [`${key} · ${name}`, ok])),
)
out.어긋난것 = Object.entries(out.판정).filter(([, value]) => value !== true).map(([key]) => key)
console.log(JSON.stringify({ 판정: out.판정, 어긋난것: out.어긋난것 }, null, 2))
writeRaw('fix1-units.json', out)
fs.rmSync(tmp, { recursive: true, force: true })
