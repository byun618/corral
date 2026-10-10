// LIFE-580 최종 관문 L9 ⓒⓓ 격리 원자료.
//   ⓒ 해지: 폰 자리 R(해지 대상)·L(살아 있음)이 구독 → R 해지 → 상태 변화 3회 → R 이 해지 뒤 받은 목록 0 · L 은 ≥ 1(양성 대조)
//      replaced: 같은 토큰으로 연결 1 구독 → 연결 2 hello(→ 1 은 replaced) → 상태 변화 → 연결 1 이 그 뒤 받은 목록 0 · 연결 2 는 ≥ 1
//   ⓓ 페이로드: 셸 pane·에이전트 pane 화면에 표식 글(`L580-TERMINAL-MARKER-<n>`)을 찍어 둔 뒤 받은 목록 원문 전체에서
//      토큰·이번 페어링 코드·표식·셸 pane id 가 0 — 양성 대조: 같은 검사기가 표식을 일부러 넣은 글에서는 잡는다
// 사용(app/): node scripts/l580/l9-isolated.mjs --root /tmp/l580g-x --fake /tmp/l580g-fx --herdr-bin <격리 guard> --out <폴더>
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'
import { checkRoots, ctl, freshPane, herdrSession, pairDevice, PROTOCOL, reportAgent, revokeAll, setMobile, sleep, until, writeJson } from './lib.mjs'
import { status } from '../l577/g-lib.mjs'

const { values: args } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, 'herdr-bin': { type: 'string' }, out: { type: 'string' } } })
try {
  checkRoots({ root: args.root, fake: args.fake })
  if (!args.out || !args['herdr-bin']) throw new Error('--out · --herdr-bin 필요')
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(2)
}
const ROOT = args.root
const OUT = path.resolve(args.out)
fs.mkdirSync(OUT, { recursive: true })
const env = { ...process.env, HERDR_SOCKET_PATH: path.join(os.homedir(), '.config/herdr-dev/sessions', herdrSession(ROOT), 'herdr.sock'), HERDR_BIN_PATH: args['herdr-bin'], HERDR_PANE_ID: '' }

/** hello + 구독. 받은 원문(raw)과 받은 시각, 닫힘 코드를 모은다. */
async function open(url, token, label) {
  const ws = new WebSocket(url)
  const got = { label, raw: [], lists: [], closed: null }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} hello 시간 초과`)), 10_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL, token, client: { name: label, version: '1' } })))
    ws.on('message', (data) => {
      const text = data.toString()
      got.raw.push(text)
      const message = JSON.parse(text)
      if (message.type === 'hello' && message.ok === true) {
        clearTimeout(timer)
        ws.send(JSON.stringify({ type: 'list.subscribe' }))
        resolve()
      } else if (message.type === 'list') got.lists.push({ at: Date.now(), seq: message.seq })
    })
    ws.on('error', reject)
  })
  ws.on('close', (code) => { got.closed = { code, at: Date.now() } })
  got.close = () => new Promise((resolve) => { if (ws.readyState === WebSocket.CLOSED) resolve(); else { ws.once('close', resolve); ws.close() } })
  return got
}

async function main() {
  await setMobile(ROOT, args.fake, true)
  const url = `ws://127.0.0.1:${(await status(ROOT)).serverPort}/ws`
  const { paneId: agentPane } = await freshPane(ROOT, { name: 'l9-agent' })
  const { paneId: shellPane } = await freshPane(ROOT, { name: 'l9-shell' })
  // 화면 표식 — 터미널 내용이 페이로드에 닿는지 본다
  for (const [pane, n] of [[agentPane, 1], [shellPane, 2]]) spawnSync(args['herdr-bin'], ['pane', 'run', pane, `echo L580-TERMINAL-MARKER-${n}`], { env, encoding: 'utf8', timeout: 10_000 })
  await reportAgent(ROOT, { paneId: agentPane, state: 'idle' })
  await sleep(1_000)
  // 이번 회차에 만든 코드들을 모은다(페이로드 검사용) — pairDevice 가 쓰는 코드는 ctl 로 다시 받을 수 없으니 직접 만든다
  const codes = []
  const tokens = {}
  for (const key of ['revokeMe', 'live', 'replaceMe']) {
    tokens[key] = await pairDevice(ROOT, { name: `l9-${key}` })
  }
  const extra = await ctl(ROOT, { cmd: 'mobile-pairing' })
  if (extra.pairing?.code) codes.push(extra.pairing.code)

  // ⓒ 해지
  const r = await open(url, tokens.revokeMe, 'revokeMe')
  const l = await open(url, tokens.live, 'live')
  await sleep(500)
  const devices = (await ctl(ROOT, { cmd: 'mobile-status' })).mobile?.devices ?? []
  const target = devices.find((device) => device.name === 'l9-revokeMe')
  const revokeAt = Date.now()
  await ctl(ROOT, { cmd: 'mobile-revoke', id: target?.id })
  await sleep(300)
  for (const state of ['working', 'blocked', 'idle']) {
    await reportAgent(ROOT, { paneId: agentPane, state })
    await sleep(700)
  }
  const revoked = { deviceFound: target !== undefined, revokeAt, revokedClosed: r.closed, revokedListsAfter: r.lists.filter((item) => item.at > revokeAt).length, liveListsAfter: l.lists.filter((item) => item.at > revokeAt).length }
  revoked.pass = revoked.deviceFound && revoked.revokedListsAfter === 0 && revoked.liveListsAfter >= 1

  // ⓒ replaced
  const c1 = await open(url, tokens.replaceMe, 'replace-1')
  await sleep(500)
  const c2 = await open(url, tokens.replaceMe, 'replace-2')
  await until(() => (c1.closed ? true : null), { timeoutMs: 5_000, label: 'replaced 닫힘' }).catch(() => null)
  const replacedAt = Date.now()
  for (const state of ['working', 'idle']) {
    await reportAgent(ROOT, { paneId: agentPane, state })
    await sleep(700)
  }
  const replaced = { firstClosed: c1.closed, firstListsAfter: c1.lists.filter((item) => item.at > replacedAt).length, secondListsAfter: c2.lists.filter((item) => item.at > replacedAt).length }
  replaced.pass = replaced.firstClosed?.code === 4006 && replaced.firstListsAfter === 0 && replaced.secondListsAfter >= 1

  // ⓓ 페이로드 grep
  const listRaw = [...r.raw, ...l.raw, ...c1.raw, ...c2.raw].filter((text) => text.includes('"type":"list"'))
  const needles = { tokens: Object.values(tokens), codes, markers: ['L580-TERMINAL-MARKER-1', 'L580-TERMINAL-MARKER-2'], shellPaneId: [`"${shellPane}"`] }
  const hits = Object.fromEntries(Object.entries(needles).map(([key, list]) => [key, list.filter((needle) => listRaw.some((text) => text.includes(needle))).length]))
  const control = needles.markers.every((needle) => [`x ${needle} y`].some((text) => text.includes(needle)))
  const agentInList = listRaw.some((text) => text.includes(`"${agentPane}"`))
  const payload = { listMessages: listRaw.length, bytes: listRaw.reduce((sum, text) => sum + text.length, 0), hits, positiveControl: control, agentPaneInList: agentInList }
  payload.pass = listRaw.length > 0 && Object.values(hits).every((n) => n === 0) && control && agentInList
  // 화면에 표식이 실제로 찍혔나(표식이 없으면 grep 0 은 무의미 — 양성 대조)
  const screens = [agentPane, shellPane].map((pane) => spawnSync(args['herdr-bin'], ['pane', 'read', pane], { env, encoding: 'utf8', timeout: 10_000 }).stdout ?? '')
  payload.markersOnScreen = needles.markers.map((needle) => screens.some((text) => text.includes(needle)))
  payload.pass = payload.pass && payload.markersOnScreen.every(Boolean)

  for (const client of [r, l, c1, c2]) await client.close()
  await revokeAll(ROOT)
  const pass = revoked.pass && replaced.pass && payload.pass
  // 원자료에는 토큰·코드를 남기지 않는다(G5) — 개수만
  writeJson(path.join(OUT, 'l9-isolated.json'), { at: new Date().toISOString(), panes: { agentPane, shellPane }, revoked, replaced, payload, verdict: pass ? '통과' : '미달' })
  console.log(`L9ⓒ 해지 ${revoked.pass ? '통과' : '미달'} ${JSON.stringify(revoked)}`)
  console.log(`L9ⓒ replaced ${replaced.pass ? '통과' : '미달'} ${JSON.stringify(replaced)}`)
  console.log(`L9ⓓ 페이로드 ${payload.pass ? '통과' : '미달'} ${JSON.stringify(payload)}`)
  process.exit(pass ? 0 : 1)
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exit(1)
})
