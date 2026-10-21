/* global process, setInterval, Buffer */
// LIFE-676 R6ⓑ 부하 — 420 MiB 를 잡고 1초마다 페이지마다 한 바이트씩 쓴다(압축·swap 으로 빠지지 않게 계속 만진다). argv 에 표식 L676M.
const MiB = 1024 * 1024
const block = Buffer.alloc(420 * MiB, 1)
setInterval(() => { for (let i = 0; i < block.length; i += 4096) block[i] = (block[i] + 1) & 255 }, 1000)
process.title = 'node-l676-memload'
