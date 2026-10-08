// LIFE-565 C1ⓑⓒ·C4ⓒ·ⓖ — 개발 앱 pane 에서 실제 claude(haiku)를 띄워 URL 세 모양을 출력시키고 화면 행·프레임 OSC 8 을 남긴다.
// 사용: node claude-round.mjs <원자료 폴더>
import fs from 'node:fs'
import * as l from './lib.mjs'
const [out] = process.argv.slice(2)
const P = l.PORT
const SHORT = `http://localhost:${P}/l565-c1b-short`
const LONG = `http://localhost:${P}/l565-c4c-long/${'a'.repeat(120)}/${'b'.repeat(60)}`
const LIST = `http://localhost:${P}/l565-g-list/${'c'.repeat(130)}`
fs.writeFileSync(`${out}/g20-claude-urls.txt`, `${SHORT}\n${LONG}\n${LIST}\n`)
await l.run('clear; claude --model claude-haiku-4-5')
await l.until(async () => { const t = await l.termRead(); return t.lines.some((x) => x.startsWith('❯')) ? t : null }, 'claude ready', 60_000, 500)
await l.pause(1500)
const ready = await l.termRead()
fs.writeFileSync(`${out}/g21-claude-ready-screen.json`, `${JSON.stringify(ready, null, 1)}\n`)
await l.installFrameWatch()
const prompt = `Output exactly the following three items and nothing else, no code blocks. First, on its own line: ${SHORT} Second, on its own line: ${LONG} Third, a markdown bullet item: - link: ${LIST}`
await l.control({ cmd: 'type', text: prompt })
await l.pause(500)
await l.control({ cmd: 'key', keyCode: 'Return' })
const done = await l.until(async () => { const t = await l.termRead(); const s = t.lines.join('\n'); return s.includes('l565-g-list') && /\b(Cooked|Worked|Baked|Brewed|Churned|Cogitated|Crunched|Sautéed)\b|for \d+s/.test(s) ? t : null }, 'claude answer', 90_000, 1000)
await l.pause(1500)
const t = await l.termRead()
const fw = await l.frameWatch()
fs.writeFileSync(`${out}/g22-claude-answer-screen.json`, `${JSON.stringify(t, null, 1)}\n`)
fs.writeFileSync(`${out}/g23-frame-hyperlinks.json`, `${JSON.stringify(fw, null, 1)}\n`)
console.log(`cols=${t.cols} rows=${t.rows}`)
t.lines.forEach((line, i) => { if (line.trim()) console.log(String(i).padStart(2), String(line.replace(/ +$/, '').length).padStart(3), line.replace(/ +$/, '')) })
console.log('frameWatch', JSON.stringify(fw))
void done
