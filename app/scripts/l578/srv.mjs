// LIFE-578 최종 관문 격리 회차 — 개발 Electron(g-up.sh 로 띄운 /tmp/l578g-*) 의 모바일 서버를 제어 소켓으로 다룬다. 실제 tailscale·설치본 무접촉.
// 사용: node srv.mjs <ROOT> status | enable <relay 상태 파일> | disable | pairing <비밀 파일> | revoke <id|all>
// pairing 은 페이로드(코드 포함)를 **새 0600 파일**에만 쓰고 출력에는 <redacted> 로만 찍는다(G5).
import fs from 'node:fs'
import { clickSwitch, ctl, openMobile, status, switchChecked, until } from '../l577/g-lib.mjs'

const [root, cmd, arg] = process.argv.slice(2)
const out = (value) => console.log(JSON.stringify({ at: Date.now(), ...value }))
const redact = (value) => JSON.parse(JSON.stringify(value).replace(/"code":"[^"]*"/g, '"code":"<redacted>"').replace(/"payload":"(?:[^"\\]|\\.)*"/g, '"payload":"<redacted>"'))

if (cmd === 'status') {
  out({ status: redact(await status(root)) })
} else if (cmd === 'enable' || cmd === 'disable') {
  await openMobile(root)
  const want = cmd === 'enable' ? 'true' : 'false'
  if ((await switchChecked(root)) !== want) await clickSwitch(root)
  const done = await until(async () => {
    const mobile = await status(root)
    return cmd === 'enable' ? (typeof mobile?.serverPort === 'number' && mobile.serverPort > 0 && mobile.exposure?.kind === 'exposed' ? mobile : null) : !mobile?.serverPort ? mobile ?? {} : null
  }, { timeoutMs: 30_000, everyMs: 250, label: cmd })
  if (cmd === 'enable' && arg) {
    const prev = (() => { try { return JSON.parse(fs.readFileSync(arg, 'utf8')) } catch { return { frozen: false } } })()
    fs.writeFileSync(arg, JSON.stringify({ ...prev, target: done.value.serverPort }))
  }
  out({ [cmd]: true, ms: done.ms, status: redact(done.value) })
} else if (cmd === 'pairing') {
  const reply = await ctl(root, { cmd: 'mobile-pairing' })
  if (!reply.ok || !reply.pairing?.ok) {
    out({ pairing: false, reply: redact(reply) })
    process.exit(1)
  }
  fs.writeFileSync(arg, reply.pairing.payload, { mode: 0o600, flag: 'wx' })
  out({ pairing: true, file: arg, url: reply.pairing.url, expiresAt: reply.pairing.expiresAt, code: '<redacted>' })
} else if (cmd === 'revoke') {
  const mobile = await status(root)
  const devices = mobile?.devices ?? []
  const targets = arg === 'all' ? devices.map((device) => device.id) : [arg]
  for (const id of targets) out({ revoke: id, reply: (await ctl(root, { cmd: 'mobile-revoke', id })).revoked })
} else {
  console.log('명령: status · enable · disable · pairing · revoke')
  process.exit(2)
}
