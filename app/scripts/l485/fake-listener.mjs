// LIFE-485 K5 「재연결 중」 — 소켓 파일에서 연결을 받자마자 끊는 가짜 백엔드. 사용: node fake-listener.mjs <sock>
import fs from 'node:fs'
import net from 'node:net'
const sock = process.argv[2]
fs.rmSync(sock, { force: true })
net.createServer((socket) => socket.destroy()).listen(sock, () => console.log(`listening ${sock} pid ${process.pid}`))
