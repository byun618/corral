// LIFE-565 G4 브라우저 쪽 관측 — 기본 브라우저가 실제로 연 localhost URL 을 접속 로그(NDJSON)로 남긴다.
import fs from 'node:fs'
import http from 'node:http'
const [port, file] = process.argv.slice(2)
http
  .createServer((req, res) => {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, ua: req.headers['user-agent'] ?? '' })}\n`)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<title>l565 ${req.url}</title><p>LIFE-565 관측 서버 — ${req.url}</p>`)
  })
  .listen(Number(port), '127.0.0.1')
