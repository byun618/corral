// LIFE-683 S2·S3·S4·S5·S11 — 소스 제어 순수 모델: porcelain v2 분류(XY·rename·충돌·`-z` 경로), 그룹·정렬·트리 압축, 클릭 대상, 탭 id.
// 실제 git 출력으로 분류를 고정하는 시험은 아래 「실제 git」 블록(fixture 저장소).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parsePorcelainV2 } from './explorer-git.js'
import {
  buildTree,
  comparePaths,
  diffTabId,
  diffTitle,
  flattenTree,
  groupChanges,
  isPlainRel,
  openOf,
  parseBaseDiff,
  parseDiffTabId,
  parseScmChanges,
  SCM_BASE_SOURCE_TEXT,
  scmErrorKind,
  scmMark,
  scmStrike,
  sidesOf,
  withUntracked,
  type ScmChange,
  type ScmStatus,
} from './scm.js'

const v2 = (...records: string[]): string => records.join('\0') + '\0'
const ordinary = (xy: string, rel: string): string => `1 ${xy} N... 100644 100644 100644 aaaa bbbb ${rel}`
const renamed = (xy: string, rel: string, orig: string): string[] => [`2 ${xy} N... 100644 100644 100644 aaaa bbbb R100 ${rel}`, orig]
const unmerged = (xy: string, rel: string): string => `u ${xy} N... 100644 100644 100644 100644 aaaa bbbb cccc ${rel}`

describe('parseScmChanges — VS Code repository.ts 3205-3248 분류', () => {
  it('X → 스테이지, Y → 변경, 둘 다면 두 그룹에 각각', () => {
    expect(parseScmChanges(v2(ordinary('M.', 'a.ts'), ordinary('.M', 'b.ts'), ordinary('MM', 'c.ts')))).toEqual([
      { group: 'index', status: 'INDEX_MODIFIED', rel: 'a.ts', orig: null },
      { group: 'workingTree', status: 'MODIFIED', rel: 'b.ts', orig: null },
      { group: 'index', status: 'INDEX_MODIFIED', rel: 'c.ts', orig: null },
      { group: 'workingTree', status: 'MODIFIED', rel: 'c.ts', orig: null },
    ])
  })
  it('추가·삭제·형식·intent-to-add·추적 안 함(mixed — 변경 그룹)', () => {
    expect(parseScmChanges(v2(ordinary('A.', 'n.ts'), ordinary('D.', 'gone.ts'), ordinary('.D', 'wd.ts'), ordinary('.T', 't.ts'), ordinary('T.', 'it.ts'), ordinary('.A', 'ita.ts'), '? new file.txt'))).toEqual([
      { group: 'index', status: 'INDEX_ADDED', rel: 'n.ts', orig: null },
      { group: 'index', status: 'INDEX_DELETED', rel: 'gone.ts', orig: null },
      { group: 'workingTree', status: 'DELETED', rel: 'wd.ts', orig: null },
      { group: 'workingTree', status: 'TYPE_CHANGED', rel: 't.ts', orig: null },
      { group: 'index', status: 'INDEX_TYPE_CHANGED', rel: 'it.ts', orig: null },
      { group: 'workingTree', status: 'INTENT_TO_ADD', rel: 'ita.ts', orig: null },
      { group: 'workingTree', status: 'UNTRACKED', rel: 'new file.txt', orig: null },
    ])
  })
  it('이름 바뀜 — 새 경로 + 원래 경로(다음 NUL 칸), 작업 트리 쪽 수정은 새 경로', () => {
    expect(parseScmChanges(v2(...renamed('RM', 'dir/새 이름.ts', 'old "q".ts'), ordinary('.M', 'after.ts')))).toEqual([
      { group: 'index', status: 'INDEX_RENAMED', rel: 'dir/새 이름.ts', orig: 'old "q".ts' },
      { group: 'workingTree', status: 'MODIFIED', rel: 'dir/새 이름.ts', orig: null },
      { group: 'workingTree', status: 'MODIFIED', rel: 'after.ts', orig: null },
    ])
  })
  it('충돌 XY 7종 → 병합 변경(그 밖 그룹 없음), ignored 는 빼고 머리 줄은 건너뛴다', () => {
    const got = parseScmChanges(v2('# branch.oid abc', unmerged('UU', 'uu'), unmerged('AA', 'aa'), unmerged('DU', 'du'), unmerged('UD', 'ud'), unmerged('AU', 'au'), unmerged('UA', 'ua'), unmerged('DD', 'dd'), '! node_modules/'))
    expect(got.map((change) => [change.group, change.status, change.rel])).toEqual([
      ['merge', 'BOTH_MODIFIED', 'uu'],
      ['merge', 'BOTH_ADDED', 'aa'],
      ['merge', 'DELETED_BY_US', 'du'],
      ['merge', 'DELETED_BY_THEM', 'ud'],
      ['merge', 'ADDED_BY_US', 'au'],
      ['merge', 'ADDED_BY_THEM', 'ua'],
      ['merge', 'BOTH_DELETED', 'dd'],
    ])
  })
  it('탐색기 배지(`parsePorcelainV2`)는 같은 입력에서 그대로 — 작업 트리 쪽 하나로 접는다(S10)', () => {
    const stdout = v2(ordinary('MM', 'c.ts'), ordinary('M.', 'a.ts'), ...renamed('R.', 'n.ts', 'o.ts'), '? u.txt', unmerged('UU', 'x'))
    expect([...parsePorcelainV2(stdout).marks]).toEqual([['c.ts', 'M'], ['a.ts', 'M'], ['n.ts', 'R'], ['u.txt', 'U'], ['x', '!']])
  })
})

describe('글자·취소선 — VS Code getStatusLetter·strikeThrough', () => {
  it('글자', () => {
    const statuses: ScmStatus[] = ['INDEX_MODIFIED', 'MODIFIED', 'INDEX_ADDED', 'INTENT_TO_ADD', 'INDEX_DELETED', 'DELETED', 'INDEX_RENAMED', 'INDEX_COPIED', 'TYPE_CHANGED', 'UNTRACKED', 'BOTH_MODIFIED']
    expect(statuses.map((status) => scmMark(status))).toEqual(['M', 'M', 'A', 'A', 'D', 'D', 'R', 'C', 'T', 'U', '!'])
  })
  it('취소선은 삭제류만', () => {
    expect(scmStrike('DELETED')).toBe(true)
    expect(scmStrike('INDEX_DELETED')).toBe(true)
    expect(scmStrike('DELETED_BY_US')).toBe(true)
    expect(scmStrike('MODIFIED')).toBe(false)
    expect(scmStrike('BOTH_MODIFIED')).toBe(false)
  })
})

const change = (group: ScmChange['group'], rel: string, status: ScmChange['status'] = 'MODIFIED'): ScmChange => ({ group, status, rel, orig: null })

describe('그룹·정렬 (S2·S4)', () => {
  it('순서 병합 → 스테이지 → 변경, 빈 그룹 숨김, 그룹 안 경로순(얕은 파일 먼저 · 자연 정렬)', () => {
    const { groups } = groupChanges([change('workingTree', 'src/b.ts'), change('workingTree', 'z.txt'), change('workingTree', 'src/a10.ts'), change('workingTree', 'src/a2.ts'), change('merge', 'm', 'BOTH_MODIFIED')])
    expect(groups.map((group) => group.id)).toEqual(['merge', 'workingTree'])
    expect(groups[1]?.changes.map((item) => item.rel)).toEqual(['z.txt', 'src/a2.ts', 'src/a10.ts', 'src/b.ts'])
  })
  it('변경 0 → 그룹 0, 상한 넘으면 앞에서 잘라 알린다', () => {
    expect(groupChanges([]).groups).toEqual([])
    const many = Array.from({ length: 5 }, (_value, index) => change('workingTree', `f${index}`))
    expect(groupChanges(many, 3)).toMatchObject({ total: 5, truncated: true })
    expect(groupChanges(many, 3).groups[0]?.changes).toHaveLength(3)
  })
  it('comparePaths — VS Code comparers.ts 278-303 과 같은 순서', () => {
    expect(['a/b.txt', 'z.txt', 'a/x/y', 'a/b', 'b/c'].sort(comparePaths)).toEqual(['z.txt', 'a/b', 'a/b.txt', 'a/x/y', 'b/c'])
  })
})

describe('트리 (S4 — 폴더 먼저 · 이름순 · compactFolders)', () => {
  it('자식이 폴더 하나뿐인 체인을 압축하고, 접은 폴더 자식은 뺀다', () => {
    const tree = buildTree([change('workingTree', 'src/main/deep/x.ts'), change('workingTree', 'src/main/deep/y.ts'), change('workingTree', 'src/a.ts'), change('workingTree', 'README.md'), change('workingTree', 'docs/one/two.md')])
    const rows = flattenTree(tree, new Set())
    expect(rows.map((row) => (row.kind === 'dir' ? `${'  '.repeat(row.depth - 1)}${row.name}/` : `${'  '.repeat(row.depth - 1)}${row.name}`))).toEqual(['docs/one/', '  two.md', 'src/', '  main/deep/', '    x.ts', '    y.ts', '  a.ts', 'README.md'])
    expect(flattenTree(tree, new Set(['src/main/deep'])).map((row) => row.kind === 'dir' ? row.path : row.change.rel)).toEqual(['docs/one', 'docs/one/two.md', 'src', 'src/main/deep', 'src/a.ts', 'README.md'])
  })
})

describe('클릭 대상 (S5 — VS Code repository.ts 532-694)', () => {
  const open = (status: ScmChange['status'], rel = 'a.ts', orig: string | null = null) => openOf({ group: 'workingTree', status, rel, orig })
  it('작업 트리 수정 = 인덱스 ↔ 작업 diff, 스테이지 수정 = HEAD ↔ 인덱스, 이름 바뀜 = HEAD 원래 ↔ 인덱스 새', () => {
    const wt = open('MODIFIED')
    expect(wt.kind === 'diff' && sidesOf(wt.target)).toEqual({ left: { side: 'index', rel: 'a.ts' }, right: { side: 'working', rel: 'a.ts' } })
    const idx = open('INDEX_MODIFIED')
    expect(idx.kind === 'diff' && sidesOf(idx.target)).toEqual({ left: { side: 'head', rel: 'a.ts' }, right: { side: 'index', rel: 'a.ts' } })
    const ren = open('INDEX_RENAMED', 'new.ts', 'old.ts')
    expect(ren.kind === 'diff' && sidesOf(ren.target)).toEqual({ left: { side: 'head', rel: 'old.ts' }, right: { side: 'index', rel: 'new.ts' } })
  })
  it('인덱스 추가 = 인덱스 단일, 삭제(둘 다) = HEAD 단일, 추적 안 함·충돌 = 보통 파일 탭', () => {
    const added = open('INDEX_ADDED')
    expect(added.kind === 'diff' && sidesOf(added.target)).toEqual({ left: null, right: { side: 'index', rel: 'a.ts' } })
    for (const status of ['DELETED', 'INDEX_DELETED'] as const) {
      const deleted = open(status)
      expect(deleted.kind === 'diff' && sidesOf(deleted.target)).toEqual({ left: null, right: { side: 'head', rel: 'a.ts' } })
    }
    expect(open('UNTRACKED')).toEqual({ kind: 'file', rel: 'a.ts' })
    expect(open('BOTH_MODIFIED')).toEqual({ kind: 'file', rel: 'a.ts' })
  })
  it('제목 — VS Code getTitle 형식', () => {
    expect(diffTitle({ mode: 'wt', rel: 'src/a.ts', orig: null })).toBe('a.ts (작업 트리)')
    expect(diffTitle({ mode: 'idx', rel: 'a.ts', orig: null })).toBe('a.ts (인덱스)')
    expect(diffTitle({ mode: 'idxOnly', rel: 'a.ts', orig: null })).toBe('a.ts (인덱스)')
    expect(diffTitle({ mode: 'deleted', rel: 'a.ts', orig: null })).toBe('a.ts (삭제됨)')
  })
})

describe('diff 탭 id (영속)', () => {
  it('같은 대상 = 같은 id(중복 탭 0), 왕복, 작업 트리·스테이지 같은 파일은 다른 id', () => {
    const wt = { mode: 'wt' as const, rel: '한글 "q" 파일.ts', orig: null }
    expect(parseDiffTabId(diffTabId(wt))).toEqual(wt)
    expect(diffTabId(wt)).toBe(diffTabId({ ...wt }))
    expect(diffTabId(wt)).not.toBe(diffTabId({ ...wt, mode: 'idx' }))
    expect(diffTabId(wt).startsWith('diff:')).toBe(true)
  })
  it('깨진 id·모르는 모드·탈출 경로는 null', () => {
    for (const bad of ['diff:', 'diff:{', 'diff:["zz","a",null]', 'diff:["wt","../x",null]', 'diff:["wt","/abs",null]', 'diff:["idx","a","a/../../b"]', 'diff:["wt",1,null]', 'file:a.ts']) expect(parseDiffTabId(bad)).toBeNull()
    expect(isPlainRel('a/b')).toBe(true)
    expect(isPlainRel('a//b')).toBe(false)
  })
})

describe('실제 git — fixture 저장소 분류(공백·한글·따옴표·rename·바이너리·충돌)', () => {
  it('porcelain v2 -z 실제 출력이 그룹대로 나뉜다', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l683-scm-')))
    try {
      const git = (...args: string[]): string => execFileSync('git', ['-C', base, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' })
      git('init', '-q', '-b', 'main')
      fs.writeFileSync(path.join(base, 'keep.ts'), 'a\n')
      fs.writeFileSync(path.join(base, 'old name.ts'), 'rename me\n'.repeat(20))
      fs.writeFileSync(path.join(base, 'gone.ts'), 'x\n')
      fs.writeFileSync(path.join(base, 'conflict.txt'), 'base\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'base')
      git('checkout', '-q', '-b', 'other')
      fs.writeFileSync(path.join(base, 'conflict.txt'), 'other\n')
      git('commit', '-q', '-am', 'other')
      git('checkout', '-q', 'main')
      fs.writeFileSync(path.join(base, 'conflict.txt'), 'main\n')
      git('commit', '-q', '-am', 'main')
      try {
        git('merge', '-q', 'other')
      } catch {
        // 충돌이 목적이다.
      }
      git('mv', 'old name.ts', '새 "이름".ts')
      fs.writeFileSync(path.join(base, 'keep.ts'), 'b\n')
      git('add', 'keep.ts')
      fs.writeFileSync(path.join(base, 'keep.ts'), 'c\n')
      fs.rmSync(path.join(base, 'gone.ts'))
      fs.writeFileSync(path.join(base, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
      const stdout = execFileSync('git', ['-C', base, '--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'], { encoding: 'utf8' })
      const got = parseScmChanges(stdout).map((item) => `${item.group}:${item.status}:${item.rel}${item.orig === null ? '' : `<-${item.orig}`}`).sort()
      expect(got).toEqual(
        [
          'merge:BOTH_MODIFIED:conflict.txt',
          'index:INDEX_RENAMED:새 "이름".ts<-old name.ts',
          'index:INDEX_MODIFIED:keep.ts',
          'workingTree:MODIFIED:keep.ts',
          'workingTree:DELETED:gone.ts',
          'workingTree:UNTRACKED:bin.dat',
        ].sort(),
      )
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

// --- fix r1 ---------------------------------------------------------------------------------
describe('fix r1 — 중첩 저장소(R1-02) · 하위 모듈(R1-04) · 전체 개수(R1-05) · 오류 종류(R1-08)', () => {
  it('`? dir/`(끝 슬래시 = 중첩 저장소)는 버리고, 보통 추적 안 함은 남긴다 — VS Code git.ts:895', () => {
    expect(parseScmChanges(v2('? nested/', '? plain.txt', '? dir/inner.txt'))).toEqual([
      { group: 'workingTree', status: 'UNTRACKED', rel: 'plain.txt', orig: null },
      { group: 'workingTree', status: 'UNTRACKED', rel: 'dir/inner.txt', orig: null },
    ])
  })
  it('하위 모듈 항목(`<sub>` = S…)은 표시를 달고, 클릭은 diff 대신 안내', () => {
    const [submodule] = parseScmChanges(v2('1 .M SC.. 160000 160000 160000 aaaa bbbb sub'))
    expect(submodule).toEqual({ group: 'workingTree', status: 'MODIFIED', rel: 'sub', orig: null, submodule: true })
    expect(submodule === undefined ? null : openOf(submodule).kind).toBe('notice')
    expect(parseScmChanges(v2(ordinary('.M', 'a.ts')))[0]).not.toHaveProperty('submodule')
  })
  it('잘라 보낸 목록 + 전체 개수 — 안내는 전체 개수로', () => {
    const shown = Array.from({ length: 4 }, (_value, index) => change('workingTree', `f${index}`))
    expect(groupChanges(shown, 3, 50)).toMatchObject({ total: 50, truncated: true })
    expect(groupChanges(shown.slice(0, 2), 3, 2)).toMatchObject({ total: 2, truncated: false })
  })
  it('오류 종류 — 저장소 아님 vs 조회 실패', () => {
    expect(scmErrorKind('Error: Command failed: git -C /x status\nfatal: not a git repository (or any of the parent directories): .git')).toBe('not_repo')
    expect(scmErrorKind('Error: spawn git ENOENT')).toBe('failed')
    expect(scmErrorKind('RangeError [ERR_CHILD_PROCESS_STDIO_MAXBUFFER]: stdout maxBuffer length exceeded')).toBe('failed')
    expect(scmErrorKind('Error: Command failed: git … (killed: SIGTERM, timeout)')).toBe('failed')
  })
  it('실제 git — 중첩 저장소는 빠지고 하위 모듈 수정은 표시가 붙는다', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l683-nest-')))
    try {
      const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' })
      const host = path.join(base, 'host')
      const lib = path.join(base, 'lib')
      for (const dir of [host, lib]) {
        fs.mkdirSync(dir)
        git(dir, 'init', '-q', '-b', 'main')
        fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'init')
      }
      git(host, 'submodule', 'add', '-q', lib, 'sub')
      git(host, 'commit', '-q', '-m', 'sub')
      fs.writeFileSync(path.join(host, 'sub', 'f.txt'), 'changed\n')
      fs.mkdirSync(path.join(host, 'nested'))
      git(path.join(host, 'nested'), 'init', '-q')
      fs.writeFileSync(path.join(host, 'nested', 'n.txt'), 'n\n')
      git(path.join(host, 'nested'), 'add', '-A')
      git(path.join(host, 'nested'), 'commit', '-q', '-m', 'n')
      fs.writeFileSync(path.join(host, 'loose.txt'), 'u\n')
      const stdout = execFileSync('git', ['-C', host, '--no-optional-locks', '-c', 'core.quotePath=false', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching'], { encoding: 'utf8' })
      expect(stdout.split('\0')).toContain('? nested/')
      expect(parseScmChanges(stdout)).toEqual([
        { group: 'workingTree', status: 'MODIFIED', rel: 'sub', orig: null, submodule: true },
        { group: 'workingTree', status: 'UNTRACKED', rel: 'loose.txt', orig: null },
      ])
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

// LIFE-830 B4·B5·B12 — base 대비: `diff --raw -z -M` 파서(이름 바뀜·공백·한글·하위 모듈·충돌), 추적 안 함 합치기, 클릭 대상·양쪽, 탭 id.
describe('base 대비 (LIFE-830)', () => {
  it('출처 문구 — 부모 worktree · repo 설정 · 기본 브랜치(기준 B3 정정 r1 — ③ 사슬은 로컬 main·master 까지 내려간다)', () => {
    expect(SCM_BASE_SOURCE_TEXT).toEqual({ parent: '부모 worktree', repo: 'repo 설정', default: '기본 브랜치' })
  })
  const raw = (...records: string[]): string => records.join('\0') + '\0'
  const Z = '0'.repeat(40)
  const O = 'a'.repeat(40)
  it('parseBaseDiff — A·M·D·R(점수 버림, 원래→새 경로)·T·U(충돌)·하위 모듈, 공백·한글 경로', () => {
    const out = parseBaseDiff(
      raw(
        `:000000 100644 ${Z} ${O} A`, 'added 파일.txt',
        `:100644 100644 ${O} ${Z} M`, 'dir/b c.txt',
        `:100644 000000 ${O} ${Z} D`, 'gone.txt',
        `:100644 100644 ${O} ${O} R087`, 'old name.txt', 'dir/새 이름.txt',
        `:100644 120000 ${O} ${Z} T`, 'link',
        `:000000 000000 ${Z} ${Z} U`, 'conflict.txt',
        `:160000 160000 ${O} ${Z} M`, 'sub',
        `:100644 100644 ${O} ${O} C050`, 'from.txt', 'copy.txt',
      ),
    )
    expect(out).toEqual([
      { group: 'base', status: 'ADDED', rel: 'added 파일.txt', orig: null },
      { group: 'base', status: 'MODIFIED', rel: 'dir/b c.txt', orig: null },
      { group: 'base', status: 'DELETED', rel: 'gone.txt', orig: null },
      { group: 'base', status: 'RENAMED', rel: 'dir/새 이름.txt', orig: 'old name.txt' },
      { group: 'base', status: 'TYPE_CHANGED', rel: 'link', orig: null },
      { group: 'base', status: 'BOTH_MODIFIED', rel: 'conflict.txt', orig: null },
      { group: 'base', status: 'MODIFIED', rel: 'sub', orig: null, submodule: true },
    ])
    expect(parseBaseDiff('')).toEqual([])
  })
  it('withUntracked — status 의 추적 안 함만 base 그룹으로 더한다', () => {
    const status: ScmChange[] = [
      { group: 'workingTree', status: 'UNTRACKED', rel: 'u.txt', orig: null },
      { group: 'workingTree', status: 'MODIFIED', rel: 'm.txt', orig: null },
      { group: 'index', status: 'INDEX_ADDED', rel: 'i.txt', orig: null },
    ]
    const diff: ScmChange[] = [{ group: 'base', status: 'MODIFIED', rel: 'm.txt', orig: null }]
    expect(withUntracked({ diff, status })).toEqual([...diff, { group: 'base', status: 'UNTRACKED', rel: 'u.txt', orig: null }])
  })
  it('글자·취소선·그룹 — A·R 은 작업 트리와 같은 글자, 삭제 취소선, 그룹 하나 「base 대비 변경 사항」', () => {
    expect(scmMark('ADDED')).toBe('A')
    expect(scmMark('RENAMED')).toBe('R')
    expect(scmStrike('DELETED')).toBe(true)
    const grouped = groupChanges([
      { group: 'base', status: 'MODIFIED', rel: 'b', orig: null },
      { group: 'base', status: 'UNTRACKED', rel: 'a', orig: null },
    ])
    expect(grouped.groups.map((group) => [group.id, group.title, group.changes.map((change) => change.rel)])).toEqual([['base', 'base 대비 변경 사항', ['a', 'b']]])
  })
  it('클릭 대상·양쪽 — 수정·추가·추적 안 함 = merge-base ↔ 작업 파일, 이름 바뀜 = 원래 경로 ↔ 새 경로, 삭제 = merge-base 단일, 충돌 = 작업 파일, 하위 모듈 = 안내', () => {
    const base = (status: ScmStatus, rel: string, orig: string | null = null, extra: { submodule?: true } = {}): ScmChange => ({ group: 'base', status, rel, orig, ...extra })
    expect(openOf(base('MODIFIED', 'm'))).toEqual({ kind: 'diff', target: { mode: 'base', rel: 'm', orig: null } })
    expect(openOf(base('ADDED', 'a'))).toEqual({ kind: 'diff', target: { mode: 'base', rel: 'a', orig: null } })
    expect(openOf(base('UNTRACKED', 'u'))).toEqual({ kind: 'diff', target: { mode: 'base', rel: 'u', orig: null } })
    expect(openOf(base('TYPE_CHANGED', 't'))).toEqual({ kind: 'diff', target: { mode: 'base', rel: 't', orig: null } })
    expect(openOf(base('RENAMED', 'new', 'old'))).toEqual({ kind: 'diff', target: { mode: 'base', rel: 'new', orig: 'old' } })
    expect(openOf(base('DELETED', 'd'))).toEqual({ kind: 'diff', target: { mode: 'baseDeleted', rel: 'd', orig: null } })
    expect(openOf(base('BOTH_MODIFIED', 'c'))).toEqual({ kind: 'file', rel: 'c' })
    expect(openOf(base('MODIFIED', 'sub', null, { submodule: true }))).toMatchObject({ kind: 'notice' })
    expect(sidesOf({ mode: 'base', rel: 'new', orig: 'old' })).toEqual({ left: { side: 'base', rel: 'old' }, right: { side: 'working', rel: 'new' } })
    expect(sidesOf({ mode: 'base', rel: 'm', orig: null })).toEqual({ left: { side: 'base', rel: 'm' }, right: { side: 'working', rel: 'm' } })
    expect(sidesOf({ mode: 'baseDeleted', rel: 'd', orig: null })).toEqual({ left: null, right: { side: 'base', rel: 'd' } })
    expect(diffTitle({ mode: 'base', rel: 'dir/m.ts', orig: null })).toBe('m.ts (base 대비)')
    // 작업 트리 모드 행은 그대로 — 같은 상태 이름이어도 그룹이 다르면 다른 대상.
    expect(openOf({ group: 'workingTree', status: 'MODIFIED', rel: 'm', orig: null })).toEqual({ kind: 'diff', target: { mode: 'wt', rel: 'm', orig: null } })
    expect(openOf({ group: 'workingTree', status: 'UNTRACKED', rel: 'u', orig: null })).toEqual({ kind: 'file', rel: 'u' })
  })
  it('탭 id — 새 모드는 작업 트리 탭과 다른 id, 왕복, 옛 id 형식 그대로 읽힘', () => {
    const target = { mode: 'base' as const, rel: 'm.ts', orig: null }
    expect(parseDiffTabId(diffTabId(target))).toEqual(target)
    expect(parseDiffTabId(diffTabId({ mode: 'baseDeleted', rel: 'd', orig: null }))).toEqual({ mode: 'baseDeleted', rel: 'd', orig: null })
    expect(diffTabId(target)).not.toBe(diffTabId({ ...target, mode: 'wt' }))
    expect(diffTabId(target)).toBe('diff:["base","m.ts",null]')
    // v0.6.0 이 쓴 id(문자열 그대로) — 이 빌드도 같은 대상으로 읽는다.
    expect(parseDiffTabId('diff:["wt","a.ts",null]')).toEqual({ mode: 'wt', rel: 'a.ts', orig: null })
    expect(parseDiffTabId('diff:["idx","b.ts","a.ts"]')).toEqual({ mode: 'idx', rel: 'b.ts', orig: 'a.ts' })
    expect(parseDiffTabId('diff:["base","../x",null]')).toBeNull()
  })
})
