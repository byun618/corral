// S1(L11) — R2 셀 일치 회귀. fixture 3종 × 5회, 정착 화면 텍스트·행 배치 불일치 0.
//
// R3 변경이 R2 터미널 스트리밍(프레임 파이프라인)을 깨지 않았나. 오라클(기준 S1): 제3 오라클 =
// control 소켓 pane.read(=herdr 화면) vs xterm 버퍼 실물(렌더러 term-read 프로브). 벤더 frame 은
// 판별자로 안 쓴다.
//
// l353/s1-cell-match.mjs + fixtures.mjs 를 life356 세션·스크래치 레포·l356 raw 로 옮겼다 (킥오프:
// LIFE-353 raw 는 건드리지 않는다). 세션 무관한 순수/앱 헬퍼(attachPane·settleXterm·diffScreen·
// normalizeLines)는 l353/lib 에서 그대로 가져오고, herdr 세션에 매인 것(herdrRead·settleHerdr·
// fixtures)만 l356 herdrRequest 로 다시 뺀다.

import { attachPane, diffScreen, normalizeLines, settleXterm } from '../l353/lib.mjs'
import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const ROUNDS = 5

async function panesInWs(workspaceId) {
  return (await herdrRequest('pane.list', {})).panes.filter((p) => p.workspace_id === workspaceId)
}

// --- herdr 오라클 (life356) ----------------------------------------------------
async function herdrRead(paneId, source = 'visible') {
  const r = await herdrRequest('pane.read', { pane_id: paneId, source, format: 'text' })
  return r.read
}
async function settleHerdr(paneId, { timeoutMs = 8000, everyMs = 100 } = {}) {
  const startedAt = Date.now()
  let previous = null
  let stable = 0
  for (;;) {
    const read = await herdrRead(paneId)
    const lines = normalizeLines(read.text)
    const key = lines.join('\n')
    if (key === previous) {
      stable += 1
      if (stable >= 2) return { lines, ms: Date.now() - startedAt }
    } else {
      stable = 0
      previous = key
    }
    if (Date.now() - startedAt > timeoutMs) return { lines, ms: Date.now() - startedAt, timedOut: true }
    await sleep(everyMs)
  }
}

// --- fixtures (life356 herdrRequest 로 재배선 — 명령 본문은 l353 그대로) ----------
async function neutralizePrompt(paneId) {
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x03' })
  await sleep(150)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x15' })
  await sleep(120)
  await herdrRequest('pane.send_text', {
    pane_id: paneId,
    text:
      'precmd() {}; preexec() {}; typeset -ga precmd_functions=(); typeset -ga preexec_functions=(); ' +
      '(( $+functions[_zsh_autosuggest_disable] )) && _zsh_autosuggest_disable; fc -p /dev/null 2>/dev/null; ' +
      "unset RPROMPT RPS1; PROMPT='READY%# '; clear\n",
  })
  await sleep(500)
}
async function resetPane(paneId) {
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x1b' })
  await sleep(150)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: ':qa!\r' })
  await sleep(300)
  await herdrRequest('pane.send_text', { pane_id: paneId, text: '\x03' })
  await sleep(150)
  await neutralizePrompt(paneId)
}
const FIXTURES = {
  scroll: {
    key: 'scroll',
    label: 'ⓐ 스크롤 로그',
    async setup(paneId) {
      await resetPane(paneId)
      await herdrRequest('pane.send_text', { pane_id: paneId, text: "seq 1 400 | awk '{printf \"scroll-line-%03d\\n\", $1}'\n" })
      await sleep(1500)
    },
  },
  cjk: {
    key: 'cjk',
    label: 'ⓑ CJK·이모지',
    async setup(paneId) {
      await resetPane(paneId)
      const lines = [
        '한글 가나다라마바사 아자차카타파하',
        '中文 汉字 测试 终端 显示 宽度',
        'emoji 🙂 🚀 ✨ 👩‍💻 🇨🇳 여기까지',
        'mixed A한B中C🙂D E©F½G ガギグ ｶﾅ半角',
        'box ┌───┬───┐ │ a │ 中 │ └───┴───┘',
      ]
      const body = lines.map((line) => line.replace(/'/g, "'\\''")).join('\\n')
      await herdrRequest('pane.send_text', { pane_id: paneId, text: `printf '${body}\\n' > /tmp/l356-cjk.txt\n` })
      await sleep(500)
      await herdrRequest('pane.send_text', { pane_id: paneId, text: 'clear; /bin/cat /tmp/l356-cjk.txt\n' })
      await sleep(1000)
    },
  },
  tui: {
    key: 'tui',
    label: 'ⓒ 전체화면 TUI(vim)',
    async setup(paneId) {
      await resetPane(paneId)
      await herdrRequest('pane.send_text', { pane_id: paneId, text: "seq 1 60 | awk '{printf \"vim-buffer-%02d\\n\", $1}' > /tmp/l356-tui.txt\n" })
      await sleep(500)
      await herdrRequest('pane.send_text', { pane_id: paneId, text: 'vim -u NONE /tmp/l356-tui.txt\n' })
      await sleep(1500)
    },
  },
}
async function assertAltScreen(paneId, { marker = /vim-buffer-01/ } = {}) {
  const read = await herdrRead(paneId)
  const text = read.text
  const hasVimContent = marker.test(text)
  const noShellPrompt = !/\$\s*$/.test(text.trim())
  return { alt: hasVimContent && noShellPrompt, hasVimContent, noShellPrompt }
}

const app = await startApp({ name: 's1-cell-match' })
// attachPane·settleXterm 가 기대하는 앱 메서드를 붙인다 (control 채널, 세션 무관).
app.selectPane = (paneId) => app.send({ cmd: 'click', selector: `[data-pane="${paneId}"]` })
app.termRead = async () => (await app.send({ cmd: 'term-read' })).term

const out = { at: new Date().toISOString(), ready: app.ready, rounds: ROUNDS, perFixture: [] }

try {
  const repo = makeScratchRepo('s1')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const workspaceId = (await until(async () => {
    const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
    return wt?.workspace?.workspaceId ?? null
  }, { what: 'primary ws', timeoutMs: 15000 })).value
  // 셸 행 하나 만들고 그 pane 을 잡는다
  const before = new Set((await panesInWs(workspaceId)).map((p) => p.pane_id))
  await app.click(`[data-create-row="${workspaceId}"][data-kind="shell"]`)
  const pane = (await until(async () => {
    for (const p of await panesInWs(workspaceId)) if (!before.has(p.pane_id)) return p
    return null
  }, { what: 'shell pane', timeoutMs: 15000 })).value
  const paneId = pane.pane_id
  out.paneId = paneId

  const attached = await attachPane(app, paneId, { repoRoot: repo.root })
  out.attach = { streamingMs: attached.streamingMs }
  await neutralizePrompt(paneId)

  for (const fixture of Object.values(FIXTURES)) {
    const rounds = []
    for (let round = 1; round <= ROUNDS; round++) {
      await fixture.setup(paneId)
      let altCheck = null
      if (fixture.key === 'tui') {
        altCheck = await assertAltScreen(paneId)
        if (!altCheck.alt) console.error(`  [${fixture.key} r${round}] 알트 미확인`, altCheck)
      }
      const herdrSettled = await settleHerdr(paneId)
      const xtermSettled = await settleXterm(app)
      const term = xtermSettled.term
      const mismatches = diffScreen(herdrSettled.lines, term.lines)
      rounds.push({
        round,
        herdrSettleMs: herdrSettled.ms,
        xtermSettleMs: xtermSettled.ms,
        xtermSize: `${term.cols}x${term.rows}`,
        alt: altCheck?.alt ?? null,
        mismatchRows: mismatches.length,
        mismatches: mismatches.slice(0, 5),
      })
      console.log(`[${fixture.key} ${round}/${ROUNDS}] mismatch=${mismatches.length} ${term.cols}x${term.rows}${fixture.key === 'tui' ? ` alt=${altCheck?.alt}` : ''}`)
    }
    await resetPane(paneId)
    out.perFixture.push({ key: fixture.key, label: fixture.label, rounds, totalMismatch: rounds.reduce((s, r) => s + r.mismatchRows, 0) })
  }

  const totalMismatch = out.perFixture.reduce((s, f) => s + f.totalMismatch, 0)
  const tuiAlt = out.perFixture.find((f) => f.key === 'tui')?.rounds.every((r) => r.alt) ?? false
  out.summary = {
    fixtures: out.perFixture.length,
    roundsEach: ROUNDS,
    totalMismatchRows: totalMismatch,
    tuiAllAltConfirmed: tuiAlt,
  }
  out.verdict = out.perFixture.length === 3 && totalMismatch === 0 && tuiAlt ? 'PASS' : 'FAIL'

  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('s1-cell-match.json', out)
console.log('\nS1(L11):', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
