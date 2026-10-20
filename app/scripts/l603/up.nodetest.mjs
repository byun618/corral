// LIFE-603 R1-H ① 자기점검 — 격리 가드가 사용자 경로를 거절하고(판별력), 드라이 실행의 모든 경로가 ROOT 아래이며 기본 소켓·설치본 userData 를 가리키지 않는다.
// 실제 기동(herdr·Electron)은 최종 관문 몫 — 여기선 띄우지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sh = (script, args, env = {}) => spawnSync('sh', [path.join(here, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('ROOT 가드 — /tmp/l603g-* 밖 · .. · 빈 값은 exit 2 (양성 대조: 맞는 ROOT 드라이는 0)', () => {
  for (const bad of ['', '/tmp/x', `${os.homedir()}/Library/Application Support/corral`, '/tmp/l603g-a/../../etc', '/tmp/l602q-a']) {
    assert.equal(sh('up.sh', bad === '' ? [] : [bad], { L603_DRY: '1' }).status, 2, bad)
    assert.equal(sh('down.sh', bad === '' ? [] : [bad]).status, 2, bad)
  }
  assert.equal(sh('up.sh', ['/tmp/l603g-selfcheck'], { L603_DRY: '1' }).status, 0)
})

test('드라이 환경 — 파일·소켓 경로는 전부 ROOT 아래(herdr 소켓은 이름 세션), 기본 소켓·설치본 userData 없음, LA 는 닿지 않는 주소', () => {
  const root = '/tmp/l603g-selfcheck'
  const out = sh('up.sh', [root], { L603_DRY: '1' })
  assert.equal(out.status, 0)
  const envs = Object.fromEntries(out.stdout.trim().split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  for (const name of ['CORRAL_USER_DATA', 'CORRAL_CONTROL_SOCKET', 'CORRAL_SETTINGS', 'CORRAL_LOG', 'CORRAL_WORK_CONNECTIONS', 'CORRAL_WORK_ACTIVITY', 'CORRAL_WORK_START_PENDING', 'CORRAL_UI_PREFS', 'CORRAL_REGISTRY']) {
    assert.ok(envs[name]?.startsWith(`${root}/`), `${name}=${envs[name]}`)
  }
  assert.equal(envs.CORRAL_SESSION, 'l603g-selfcheck')
  assert.ok(envs.CORRAL_BACKEND_SOCKET.includes('/sessions/l603g-selfcheck/'))
  assert.equal(envs.CORRAL_LA_MCP_URL, 'http://127.0.0.1:9/mcp')
  assert.ok(!out.stdout.includes('Application Support/corral'))
  assert.ok(!out.stdout.includes('runtime/rpc.sock'))
})
