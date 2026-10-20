// LIFE-670 수정 2 — 격리 회차 스크립트(q-overlay · q-backlog) 공용: 기록·판정·기동·클릭·캡처. q-entry·q-minpush 는 앞 라운드 그대로 둔다.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

export { APP, ctl, sleep, until }

export function session({ root, out, shotDir }) {
  const log = recorder(path.resolve(out))
  const verdicts = []
  const judge = (item, pass, detail) => {
    verdicts.push({ item, pass })
    log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
  }
  const sh = (args, env = {}) => {
    const run = spawnSync('sh', args, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
    log(`$ sh ${args.join(' ')} → exit ${run.status}`)
    log((run.stdout + run.stderr).trim().replaceAll(process.env.HOME ?? '~', '~'))
    if (run.status !== 0) throw new Error(`${args[0]} 실패`)
  }
  const js = (code) => evalJs(root, code)
  const click = async (selector) => {
    let last = null
    await until(async () => { last = await ctl(root, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 15_000, everyMs: 250, label: selector }).catch(() => null)
    if (!last?.ok) throw new Error(`클릭 실패 ${selector} ${JSON.stringify(last)}`)
  }
  const shot = async (name) => {
    const result = await ctl(root, { cmd: 'shot', name })
    if (!result.file) { log('shot 실패', result); return }
    fs.mkdirSync(shotDir, { recursive: true })
    const target = path.join(shotDir, `${name}.png`)
    fs.copyFileSync(result.file, target)
    log('copied', { target: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
  }
  /** 앱 사본 + 창 노출 플래그로 기동 → 모의 연결 → ⌘I → 보드 카드가 보일 때까지. */
  const boot = async ({ token }) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    sh(['scripts/l670/fixture-app.sh', `${root}-app`])
    sh(['scripts/l670/up.sh', root, 'L670_EXTRA_ARGS=--disable-backgrounding-occluded-windows'], { L670_APP_DIR: `${root}-app` })
    await until(() => js(`!!document.querySelector('[data-tasks-open]')`), { timeoutMs: 30_000, label: '사이드바 「작업」' })
    const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: '${token}', replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
    judge('모의 연결 추가(가짜 토큰)', added?.ok === true, JSON.stringify(added))
    await ctl(root, { cmd: 'key', keyCode: 'I', modifiers: ['meta'] })
    await until(() => js(`(() => { const p = document.querySelector('[data-tasks-page]'); return !!p && !p.classList.contains('is-closed') })()`), { timeoutMs: 10_000, label: '⌘I' })
    await until(() => js(`!!document.querySelector('[data-tasks-board] [data-issue-card="CORE-2"]')`), { timeoutMs: 15_000, label: '보드 카드' })
    return added.id
  }
  const showView = async (view) => {
    await click(`[data-tasks-view-tab="${view}"]`)
    await until(() => js(`document.querySelector('[data-tasks-page]')?.getAttribute('data-tasks-view') === '${view}'`), { timeoutMs: 5_000, label: `보기 ${view}` })
    await sleep(300)
  }
  const finish = async (run) => {
    let exitCode = 1
    log(`# ${path.basename(out)} ${new Date().toISOString()} ROOT=${root}`)
    try {
      await run()
      const failed = verdicts.filter((verdict) => !verdict.pass)
      log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
      exitCode = failed.length === 0 ? 0 : 1
    } catch (error) {
      log('오류', String(error?.stack ?? error))
    } finally {
      try { sh(['scripts/l670/down.sh', root, 'herdr']) } catch (error) { log('down 실패', String(error)) }
      log(`# exit ${exitCode}`)
      process.exit(exitCode)
    }
  }
  return { log, judge, sh, js, click, shot, boot, showView, finish }
}
