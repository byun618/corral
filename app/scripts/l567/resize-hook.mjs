// LIFE-567 탐색 — 개발 실행 렌더러의 xterm 인스턴스 term.resize 를 감싸 호출 전후 버퍼 상태를 링에 남긴다(탐색 전용, 판정 회차에는 쓰지 않는다). 사용: node resize-hook.mjs <ctl.sock> install|read
import { rpc } from '../gui-diff/lib/corral.mjs'
const [sock, mode] = process.argv.slice(2)
const HEAD = `const host = document.querySelector('.term-pane.is-selected [data-term-pane]') ?? document.querySelector('[data-term-pane]');
  const xt = host.querySelector('.xterm');
  const findTerm = (el) => { const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$')); let fiber = key ? el[key] : null;
    for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return) for (let hook = fiber.memoizedState; hook && typeof hook === 'object'; hook = hook.next) {
      const cur = hook.memoizedState && hook.memoizedState.current; if (cur && cur.buffer && cur.buffer.active && cur.element) return cur } return null };
  const term = findTerm(xt.parentElement) || findTerm(xt);`
const code = mode === 'install' ? `${HEAD} window.__l567log = []; if (!term.__l567orig) { term.__l567orig = term.resize.bind(term); term.resize = (c, r) => { const b = term.buffer.active;
  const pre = { cols: term.cols, rows: term.rows, baseY: b.baseY, viewportY: b.viewportY, cursorY: b.cursorY, long: Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true).length ?? 0).filter((n) => n > c).length };
  term.__l567orig(c, r); window.__l567log.push({ at: Date.now(), to: [c, r], pre, post: { baseY: b.baseY, viewportY: b.viewportY, cursorY: b.cursorY, length: b.length } }) } } return 'ok'`
  : `return window.__l567log`
console.log(JSON.stringify((await rpc(sock, { cmd: 'eval', code: `(() => { ${code} })()` })).result))
