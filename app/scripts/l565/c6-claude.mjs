// LIFE-565 C6ⓓ — 앱이 보여 주는 pane 에서 실제 claude(haiku)를 띄워 URL 을 출력시키고 화면 행·프레임 OSC 8 을 남긴다.
// 사용: L565_ROOT=/tmp/l565c6 node c6-claude.mjs <원자료 폴더>
// URL 은 무해 주소만 — example.com 과 관측 서버(localhost:<빈 포트>). 긴 URL 은 pane 폭(102)을 넘겨 줄 넘김된다.
import fs from 'node:fs'
import * as l from './lib.mjs'
const [out] = process.argv.slice(2)
const P = l.PORT
const SHORT = 'https://example.com/l565-c6-short'
const LONG = `http://localhost:${P}/l565-c6-long/${'a'.repeat(110)}/${'b'.repeat(40)}`
const LOCAL = `http://localhost:${P}/l565-c6-local`
fs.writeFileSync(`${out}/g20-claude-urls.txt`, `${SHORT}\n${LONG}\n${LOCAL}\n`)
if (process.argv[3] !== 'attached') await l.run('clear; claude --model claude-haiku-4-5')
const ready = await l.until(async () => {
  const t = await l.termRead()
  const s = t.lines.join('\n')
  // 처음 보는 폴더면 신뢰 확인이 뜬다(기본 선택 「No, exit」 — g24b) — 「Yes, I trust this folder」 로 내려 Enter.
  if (/Yes, I trust this folder/.test(s) && !globalThis.__trusted) {
    globalThis.__trusted = true
    fs.writeFileSync(`${out}/g21a-claude-trust-screen.json`, `${JSON.stringify(t, null, 1)}\n`)
    await l.control({ cmd: 'key', keyCode: 'Down' })
    await l.pause(300)
    await l.control({ cmd: 'key', keyCode: 'Return' })
    return null
  }
  return t.lines.some((x) => x.startsWith('❯')) ? t : null
}, 'claude ready', 90_000, 500)
await l.pause(1500)
fs.writeFileSync(`${out}/g21-claude-ready-screen.json`, `${JSON.stringify(ready, null, 1)}\n`)
await l.installFrameWatch()
const prompt = `Output exactly the following three URLs, each on its own line, and nothing else, no code blocks: ${SHORT} ${LONG} ${LOCAL}`
await l.control({ cmd: 'type', text: prompt })
await l.pause(500)
await l.control({ cmd: 'key', keyCode: 'Return' })
await l.until(async () => { const t = await l.termRead(); const s = t.lines.join('\n'); return s.includes('l565-c6-local') && /\b(Cooked|Worked|Baked|Brewed|Churned|Cogitated|Crunched|Sautéed)\b|for \d+s/.test(s) ? t : null }, 'claude answer', 120_000, 1000)
await l.pause(1500)
const t = await l.termRead()
const fw = await l.frameWatch()
fs.writeFileSync(`${out}/g22-claude-answer-screen.json`, `${JSON.stringify(t, null, 1)}\n`)
fs.writeFileSync(`${out}/g23-frame-hyperlinks.json`, `${JSON.stringify(fw, null, 1)}\n`)
console.log(`cols=${t.cols} rows=${t.rows}`)
t.lines.forEach((line, i) => { if (line.trim()) console.log(String(i).padStart(2), String(line.replace(/ +$/, '').length).padStart(3), line.replace(/ +$/, '')) })
console.log('frameWatch', JSON.stringify(fw))
