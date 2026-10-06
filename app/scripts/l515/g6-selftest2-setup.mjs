// LIFE-515 fix2·fix3 — 실제 수집기(g6-hash.sh)·비교기(g6-compare.mjs) 자체 검사 fixture. **임시 HOME**(L515_G6_HOME)만 쓴다 — 사용자 경로를 읽지 않는다.
// 경우마다 <root>/<경우>/home 을 기본 상태로 만들고 → (prepare 가 있으면 적용) → 실제 수집기로 before.txt 를 찍고 → 변형을 적용한다.
// fix3 R3-01 경우(상위 경로 탐색 불가·ENOTDIR·부재 양성 대조)는 끝에 붙였다. 권한을 바꾼 fixture 는 검사 뒤 `--cleanup` 으로 복원·삭제한다.
// 판정 회차는 경우마다 run.mjs 한 행: L515_G6_HOME=<root>/<경우>/home node app/scripts/l515/g6-compare.mjs <root>/<경우>/before.txt <root>/<경우>/after.txt
// 사용: node app/scripts/l515/g6-selftest2-setup.mjs /tmp/l515g6h
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const root = process.argv[2]
if (root === undefined || !root.startsWith('/tmp/l515')) throw new Error('사용: g6-selftest2-setup.mjs /tmp/l515…')
const collector = path.join(path.dirname(new URL(import.meta.url).pathname), 'g6-hash.sh')

/** 기본 HOME — 고정 파일 6개(corral keybindings 는 없음)·hooks 일반 파일 2개·링크 hook 1개(대상은 hooks 밖). */
function baseHome({ home }) {
  const write = ({ rel, text }) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
    fs.writeFileSync(path.join(home, rel), text)
  }
  write({ rel: '.orca/keybindings.json', text: '{}\n' })
  write({ rel: '.claude/settings.json', text: '{"a":1}\n' })
  write({ rel: '.codex/config.toml', text: 'model = "x"\n' })
  write({ rel: '.grok/config.toml', text: 'k = 1\n' })
  write({ rel: '.grok/trusted_folders.toml', text: 'folders = []\n' })
  write({ rel: 'Library/Application Support/corral/settings.json', text: '{"version":1}\n' })
  write({ rel: '.claude/hooks/state.sh', text: 'echo claude\n' })
  write({ rel: '.grok/hooks/herdr.json', text: '{"h":1}\n' })
  write({ rel: 'dotfiles/hook-target.sh', text: 'echo before\n' })
  write({ rel: 'dotfiles/hook-other.sh', text: 'echo before\n' })
  fs.symlinkSync(path.join(home, 'dotfiles/hook-target.sh'), path.join(home, '.grok/hooks/linked.sh'))
}

const at = ({ home, rel }) => path.join(home, rel)
const cases = [
  { name: 'unchanged', expect: 0, note: '무변경(링크 hook 포함)', mutate: () => {} },
  { name: 'modified', expect: 1, note: '~/.grok/config.toml 내용 수정', mutate: ({ home }) => fs.writeFileSync(at({ home, rel: '.grok/config.toml' }), 'k = 2\n') },
  { name: 'deleted', expect: 1, note: 'hook 파일 삭제', mutate: ({ home }) => fs.rmSync(at({ home, rel: '.grok/hooks/herdr.json' })) },
  { name: 'added', expect: 1, note: 'hook 파일 추가', mutate: ({ home }) => fs.writeFileSync(at({ home, rel: '.claude/hooks/new.sh' }), 'echo new\n') },
  { name: 'empty-snapshot', expect: 1, note: '시작 snapshot 이 빈 파일(지금 쪽은 실제 수집기)', mutate: ({ dir }) => fs.writeFileSync(path.join(dir, 'before.txt'), '') },
  { name: 'collector-failure', expect: 1, note: '읽을 수 없는 hook 파일(chmod 000) → 수집기 exit 3', mutate: ({ home }) => fs.chmodSync(at({ home, rel: '.claude/hooks/state.sh' }), 0o000) },
  { name: 'unreadable-subdir', expect: 1, note: 'hooks 아래 하위 폴더(파일 포함) 추가 후 chmod 000 → find 오류 → 수집기 exit 3 (R2-01)', mutate: ({ home }) => {
    fs.mkdirSync(at({ home, rel: '.grok/hooks/sub' }))
    fs.writeFileSync(at({ home, rel: '.grok/hooks/sub/inner.sh' }), 'echo inner\n')
    fs.chmodSync(at({ home, rel: '.grok/hooks/sub' }), 0o000)
  } },
  { name: 'link-target-content', expect: 1, note: '링크 hook 대상 내용 변경 (R2-02)', mutate: ({ home }) => fs.writeFileSync(at({ home, rel: 'dotfiles/hook-target.sh' }), 'echo changed effective hook\n') },
  { name: 'link-retarget', expect: 1, note: '링크 hook 대상 교체 — 내용이 같은 다른 파일 (R2-02)', mutate: ({ home }) => {
    fs.rmSync(at({ home, rel: '.grok/hooks/linked.sh' }))
    fs.symlinkSync(at({ home, rel: 'dotfiles/hook-other.sh' }), at({ home, rel: '.grok/hooks/linked.sh' }))
  } },
  { name: 'broken-link', expect: 1, note: '링크 hook 대상 삭제(끊긴 링크) → 수집기 exit 3 (R2-02)', mutate: ({ home }) => fs.rmSync(at({ home, rel: 'dotfiles/hook-target.sh' })) },
  { name: 'link-to-dir', expect: 1, note: '폴더를 가리키는 링크 hook → 수집기 exit 3', mutate: ({ home }) => fs.symlinkSync(at({ home, rel: 'dotfiles' }), at({ home, rel: '.claude/hooks/dir-link' })) },
  { name: 'fifo', expect: 1, note: 'hooks 안 fifo(지원하지 않는 종류) → 수집기 exit 3', mutate: ({ home }) => execFileSync('mkfifo', [at({ home, rel: '.claude/hooks/pipe' })]) },
  // ── fix3 R3-01 ──
  { name: 'fixed-absent-parent-unsearchable', expect: 1, note: '시작: ~/.codex 없음(absent) → 지금: .codex/config.toml 생김 + .codex chmod 000 → 수집기 exit 3 (EACCES 를 없음으로 읽지 않음)',
    prepare: ({ home }) => fs.rmSync(at({ home, rel: '.codex' }), { recursive: true }),
    mutate: ({ home }) => { fs.mkdirSync(at({ home, rel: '.codex' })); fs.writeFileSync(at({ home, rel: '.codex/config.toml' }), 'model = "y"\n'); fs.chmodSync(at({ home, rel: '.codex' }), 0o000) } },
  { name: 'hooks-absent-parent-unsearchable', expect: 1, note: '시작: ~/.claude/hooks 없음(absent) → 지금: hooks 생김 + ~/.claude chmod 000 → 수집기 exit 3 (같은 상위의 ~/.claude/settings.json 검사가 먼저 걸린다)',
    prepare: ({ home }) => fs.rmSync(at({ home, rel: '.claude/hooks' }), { recursive: true }),
    mutate: ({ home }) => { fs.mkdirSync(at({ home, rel: '.claude/hooks' })); fs.writeFileSync(at({ home, rel: '.claude/hooks/new.sh' }), 'echo new\n'); fs.chmodSync(at({ home, rel: '.claude' }), 0o000) } },
  { name: 'existing-parent-unsearchable', expect: 1, note: '있는 파일(~/.orca/keybindings.json)의 상위 ~/.orca chmod 000 → 수집기 exit 3',
    mutate: ({ home }) => fs.chmodSync(at({ home, rel: '.orca' }), 0o000) },
  { name: 'parent-enotdir', expect: 1, note: '시작: ~/.codex 없음 → 지금: ~/.codex 가 일반 파일(ENOTDIR) → 수집기 exit 3',
    prepare: ({ home }) => fs.rmSync(at({ home, rel: '.codex' }), { recursive: true }),
    mutate: ({ home }) => fs.writeFileSync(at({ home, rel: '.codex' }), 'not a dir\n') },
  { name: 'absent-target-positive', expect: 0, note: '양성 대조: 상위 ~/.codex 는 탐색 가능, config.toml 만 없음 → absent 줄 · 수집 0 · 비교 0',
    prepare: ({ home }) => fs.rmSync(at({ home, rel: '.codex/config.toml' })), mutate: () => {} },
  { name: 'absent-ancestor-positive', expect: 0, note: '양성 대조: ~/.codex 폴더째 없음(ENOENT 가 더 위에서) → absent 줄 · 수집 0 · 비교 0',
    prepare: ({ home }) => fs.rmSync(at({ home, rel: '.codex' }), { recursive: true }), mutate: () => {} },
]

// 앞 회차가 남긴 chmod 000 폴더도 지울 수 있게 권한을 되돌린 뒤 지운다. `--cleanup` 이면 그것만 하고 끝낸다.
if (fs.existsSync(root)) spawnSync('chmod', ['-R', 'u+rwx', root])
fs.rmSync(root, { recursive: true, force: true })
if (process.argv[3] === '--cleanup') {
  console.log(`정리: ${root} 권한 복원·삭제 — 남음 ${fs.existsSync(root)}`)
  process.exit(fs.existsSync(root) ? 1 : 0)
}
const summary = []
for (const item of cases) {
  const dir = path.join(root, item.name)
  const home = path.join(dir, 'home')
  baseHome({ home })
  item.prepare?.({ home })
  const before = spawnSync('sh', [collector], { encoding: 'utf8', env: { ...process.env, L515_G6_HOME: home } })
  if (before.status !== 0) throw new Error(`${item.name}: 기본 HOME 수집 실패 ${before.status} ${before.stderr}`)
  fs.writeFileSync(path.join(dir, 'before.txt'), before.stdout)
  item.mutate({ home, dir })
  summary.push({ name: item.name, expect: item.expect, note: item.note, home })
}
fs.writeFileSync(path.join(root, 'cases.json'), `${JSON.stringify(summary, null, 2)}\n`)
console.log(summary.map((item) => `${item.name} 기대 ${item.expect} — ${item.note}`).join('\n'))
console.log(`\n기본 HOME snapshot 예(unchanged/before.txt):\n${fs.readFileSync(path.join(root, 'unchanged', 'before.txt'), 'utf8')}`)
