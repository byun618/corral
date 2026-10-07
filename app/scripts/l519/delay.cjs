// LIFE-519 시험용 지연 — 제품 코드에 넣지 않는다. NODE_OPTIONS="--require <이 파일>" 로 소켓 주인(CLI serve·Electron 메인)에 싣는다.
// L519_DELAY_PATH 와 같은 경로의 fs.chmodSync 직전에 L519_DELAY_MS 동안 이벤트 루프를 막는다 = bind(소켓 파일 생성) 뒤 ~ 권한 확정(chmod) 사이를 넓힌다.
// 기준 코드·고친 코드 모두 이 지점(listen 뒤 chmod 앞)이 같다. 실을 때마다 stderr 에 한 줄 남긴다(양성 확인용).
const fs = require('node:fs')
const target = process.env.L519_DELAY_PATH, ms = Number(process.env.L519_DELAY_MS ?? 0)
if (target && ms > 0) {
  const original = fs.chmodSync
  fs.chmodSync = function (file, mode) {
    if (String(file) === target) {
      let seen = 'ENOENT'; try { seen = (fs.lstatSync(target).mode & 0o777).toString(8) } catch {}
      process.stderr.write(`[l519-delay] pid ${process.pid} chmod(${target}) delayed ${ms}ms, mode before=${seen}\n`)
      const until = Date.now() + ms; while (Date.now() < until) { /* busy-wait: 이벤트 루프를 막아 틈을 넓힌다 */ }
    }
    return original.call(this, file, mode)
  }
}
