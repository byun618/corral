// 탐색기 파일 조작 (LIFE-592 F4 · E9) — **쓰기 경계**. 렌더러가 준 (루트, 상대 경로, 이름)을 열린 worktree 밑에서만 만들고·옮기고·복사하고·휴지통에 보낸다.
//
// 가둠 판정은 F1 `confine`(등록 루트·형·realpath 접두사)에 맡기고, 판정이 낸 **링크 없는 realpath** 위에서만 연산한다. 그 뒤가 두 갈래다:
//   · **fd 로 되는 연산**(파일 만들기·복제/가져오기의 파일 쓰기·삭제 취소 다시 만들기 — F3 `file-write.ts` 방식):
//       부모 realpath + 이름을 `O_CREAT | O_EXCL | O_NOFOLLOW_ANY` 로 연다. 검사 뒤 경로 어느 성분이 링크로 바뀌었으면 커널이 `ELOOP` 로 거절하고(밖에 만들어지지 않는다),
//       이미 있으면 `EEXIST`(덮어쓰기 0). 원본 읽기도 `O_NOFOLLOW_ANY` 로 연 fd 에서만 한다(검사 뒤 링크로 바뀐 원본을 따라가지 않는다).
//   · **경로 기반 연산**(이름 변경·이동 `rename` · 폴더 만들기 `mkdir` · 휴지통 `shell.trashItem` · 링크 복제 `symlink`): Node 에 `renameat`·`mkdirat` 이 없고
//       `/dev/fd` 경유도 안 된다(00-analysis A2·`raw/coordinator/c10`). 게이트 ⓪ Q8 = (a) — 링크 없는 realpath 로만 부르고, 부르기 **직전**에 정체·빈 자리를 다시 재고,
//       부른 **뒤** 결과 정체(dev:ino)·부모 realpath 를 다시 재 어긋나면 `changed`(done) 로 알린다. 남는 경쟁 창은 `raw/claude/residual.md` 에 정확히 적었다.
// **덮어쓰기 0** — `fs.rename` 은 대상을 조용히 덮으므로 대상 자리가 비어 있을 때만 부른다(대소문자만 바꾸기 = 같은 inode 는 허용). 이 확인과 rename 사이의 경쟁도 잔여다.
// **영구 삭제 0** — 이 파일에는 `unlink`·`rm`·`rmdir` 이 없다. 휴지통은 `deps.trashItem`(main `shell.trashItem`)뿐이고, 실패하면 안내로 끝난다(VS Code 의 「영구 삭제할까요」 폴백 없음).
// 실행 취소용 「삭제 전 내용 사본」(Q1 — 파일 ≤ 5 MB)은 이 프로세스 메모리에만 두고 id 로만 가리킨다 — 렌더러가 되살릴 내용을 만들지 못한다.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import path from 'node:path'
import { confine, isInside } from './explorer-fs.js'
import { O_NOFOLLOW_ANY } from './file-write.js'
import { copyName, isGitName, isProtectedRel, nameError, splitNewName, UNDO_SNAPSHOT_LIMIT, UNVERIFIABLE, type EntryKind, type EntryMark, type ExplorerOpRefusal, type ExplorerOpResult } from '../shared/explorer-ops.js'

type Refused = Extract<ExplorerOpResult, { ok: false }>
/** 만든 뒤 실패한 거절 — 만든 파일의 fd 정체(`stat`)가 있으면 싣는다(부분 파일을 결과에 넣을 때 「이번에 만든 것」 으로 묶는다 — R2-A·R3). */
type MadeRefused = Refused & { stat?: Stats }
/** 결과로 내보내는 거절 — 안쪽 필드(`stat`)를 떼어 낸다. */
const plain = (refused: Refused): Refused => refuse(refused.code, refused.error, refused.done)
const refuse = (code: ExplorerOpRefusal, error: string, done?: boolean): Refused => (done === true ? { ok: false, code, error, done } : { ok: false, code, error })

/** 시험 전용 주입(E9ⓒ⑩) — 검사 뒤·연산 호출 직전에 부른다. 제품 경로에서는 늘 비어 있다(`loadOpHooks`). */
export type OpHooks = { afterCheck?: (phase: string) => Promise<void> }

/**
 * 삭제 전 내용 사본(Q1) — 파일 내용 또는 빈 폴더. 메모리 상한을 넘으면 가장 오래된 것부터 버린다(그 실행 취소는 `expired`).
 * `was` = 휴지통에 보낸 바로 그 항목의 정체(사본을 뜬 fd 의 fstat — 읽는 동안 바뀌었으면 없음). 되살린 새 항목을 이 정체로 잇는다(수정 r4 R4-A).
 */
type Snapshot = ({ root: string; kind: 'file'; bytes: Buffer; mode: number } | { root: string; kind: 'dir'; mode: number }) & { was?: OwnedEntry[] }
export const SNAPSHOT_MEMORY_LIMIT = 64 * 1024 * 1024
/** 정체 잇기 상한(항목 줄 수) — 넘으면 가장 오래된 것부터 놓는다(놓인 연결의 앞 기록은 「바뀜」 으로 거절 — 안전한 쪽). */
export const LINK_LIMIT = 100_000

/**
 * 실행 취소용 main 메모리 — 삭제 전 내용 사본과 **정체 잇기**(수정 r4 R4-A).
 * 앱 자신의 실행 취소·다시 실행이 항목을 새 정체로 다시 만들면(삭제 되살림·만들기/복제/가져오기 재생) 그 새 정체(만든 순간 표지 — 수정 r3 의 같은 함수)를
 * 옛 정체에 잇는다. 잇기는 옛 정체가 **앱이 이번에 치운 바로 그 항목**일 때만 — 사본을 뜬 fd 의 정체(되살림) 또는 실행 취소 휴지통이 만든 집합과 정확히 같다고
 * 확인한 정체(재생, `noteTrashed`) — 이고, 경로만 같다고 잇지 않는다. 대조(실행 취소 `expect`·이동 `expect`·원본 도장)는 지금 디스크를 읽어 이어진 것만
 * 옛 정체로 바꿔 읽는다(`canon*`) — 다시 만든 뒤 남이 바꾸면(도장이 달라짐) 바꿔 읽지 않으니 여전히 거절된다.
 */
export class SnapshotStore {
  private readonly items = new Map<string, Snapshot>()
  private bytes = 0
  /** 새 도장 → 옛 도장, 새 정체(dev:ino) → 옛 정체. */
  private readonly stamps = new Map<string, string>()
  private readonly ids = new Map<string, string>()
  /** 실행 취소 휴지통이 치운 집합 — `root\0rel\0표지` → 그 집합(옛 정체로 읽은 것). */
  private readonly trashed = new Map<string, OwnedEntry[]>()
  constructor(private readonly limit = SNAPSHOT_MEMORY_LIMIT) {}
  canonStamp(stamp: string): string {
    return this.stamps.get(stamp) ?? stamp
  }
  canonId(id: string): string {
    return this.ids.get(id) ?? id
  }
  /** 실행 취소 휴지통으로 치운 집합을 적어 둔다 — 같은 자리·같은 표지로 재생하면 잇는다. */
  noteTrashed(input: { root: string; rel: string; stamp: string; entries: OwnedEntry[] }): void {
    const key = `${input.root}\0${input.rel}\0${input.stamp}`
    this.trashed.delete(key)
    this.trashed.set(key, input.entries)
    trim(this.trashed, LINK_LIMIT / 100)
  }
  trashedOf(input: { root: string; rel: string; stamp: string }): OwnedEntry[] | null {
    return this.trashed.get(`${input.root}\0${input.rel}\0${input.stamp}`) ?? null
  }
  /** 새로 만든 집합(`made` — 만든 순간 표지)을 옛 집합(`was`)에 잇는다. 상대 경로·종류가 정확히 같을 때만 — 하나라도 다르면 잇지 않는다. */
  link(input: { made: readonly OwnedEntry[]; was: readonly OwnedEntry[] }): boolean {
    const old = new Map(input.was.map((entry) => [entry.rel, entry]))
    if (old.size !== input.made.length || input.made.some((entry) => old.get(entry.rel)?.kind !== entry.kind)) return false
    for (const entry of input.made) {
      const before = old.get(entry.rel)
      if (before === undefined) continue
      this.stamps.set(entry.stamp, before.stamp)
      this.ids.set(entry.id, before.id)
    }
    trim(this.stamps, LINK_LIMIT)
    trim(this.ids, LINK_LIMIT)
    return true
  }
  put(snapshot: Snapshot): string {
    const id = crypto.randomUUID()
    this.items.set(id, snapshot)
    this.bytes += snapshot.kind === 'file' ? snapshot.bytes.length : 0
    for (const [oldId, old] of this.items) {
      if (this.bytes <= this.limit || oldId === id) break
      this.items.delete(oldId)
      this.bytes -= old.kind === 'file' ? old.bytes.length : 0
    }
    return id
  }
  get(id: string): Snapshot | undefined {
    return this.items.get(id)
  }
  drop(id: string): void {
    const found = this.items.get(id)
    if (found === undefined) return
    this.items.delete(id)
    this.bytes -= found.kind === 'file' ? found.bytes.length : 0
  }
  get size(): number {
    return this.items.size
  }
}

/** Map 을 상한까지 줄인다 — 가장 먼저 넣은 것부터 뺀다. */
function trim(map: Map<string, unknown>, limit: number): void {
  for (const key of map.keys()) {
    if (map.size <= limit) break
    map.delete(key)
  }
}

/** 가져오기 재생 근거(수정 r2 R2-D·R2-E) — 원래 드롭에서 온 원본(링크 푼 경로)·그것으로 만든 이름·가져오기 직전 원본 도장. */
export type ReplayRecord = { root: string; dir: string; items: { src: string; name: string; source: string }[] }
/** 붙잡는 재생 근거 상한 — 렌더러 기록(worktree 별 실행 취소·다시 실행 각 50)이 놓기를 빠뜨려도 메모리가 끝없이 늘지 않게 하는 안전망. 넘으면 가장 오래된 것부터 놓는다. */
export const REPLAY_HOLD_LIMIT = 1000

/**
 * OS 드롭 원본(E7ⓓ) — preload 가 실제 드롭 이벤트에서 얻은 경로를 main 에 직접 맡기고 표지를 받는다. 렌더러는 표지만 본다(경로를 만들 수 없다).
 * 표지는 한 번 쓰면 없어지고, 2 분이 지나면 버린다.
 * 가져오기가 끝나면 그 드롭에서 **실제로 만든 것**의 재생 근거를 따로 붙잡는다(`hold` — 시간 제한 없음). 렌더러 실행 취소 기록이 그 id 를 가리키는 동안 남고,
 * 기록에서 빠지면(상한으로 밀림·새 조작이 다시 실행 칸을 비움) 렌더러가 `release` 로 놓는다. 앱을 다시 시작하면 기록과 함께 사라진다(E5ⓓ).
 * 재생 근거는 main 안에서 원래 드롭으로만 만든다 — 렌더러는 id 만 보고 경로를 만들거나 바꿀 수 없다(E7ⓓ 유지).
 * **수명 세대**(수정 r4 R4-B) — 가져오기는 시작할 때의 세대(`generation`)와 요청한 hook(`owner`)을 들고 간다. 끝났을 때 전체 해제(렌더러 재생성)로 세대가
 * 바뀌었거나 그 owner 가 닫혔으면(hook 언마운트) 근거를 붙잡지 않는다 — main 이 판정한다(진행 중 가져오기가 수명 뒤에 끝나도 남지 않게).
 * owner 를 닫으면(`close`) 그 owner 가 붙잡은 근거도 전부 놓는다(놓기 신호가 가져오기 결과보다 늦게 와도).
 */
export class DropStore {
  private readonly items = new Map<string, { paths: string[]; at: number }>()
  private readonly held = new Map<string, { record: ReplayRecord; owner: string | null }>()
  private readonly closed = new Set<string>()
  private lifetime = 0
  constructor(
    private readonly ttlMs = 120_000,
    private readonly now = () => Date.now(),
    private readonly holdLimit = REPLAY_HOLD_LIMIT,
  ) {}
  register(paths: string[]): string {
    for (const [token, item] of this.items) if (this.now() - item.at > this.ttlMs) this.items.delete(token)
    const token = crypto.randomUUID()
    this.items.set(token, { paths, at: this.now() })
    return token
  }
  take(token: unknown): string[] | null {
    if (typeof token !== 'string') return null
    const item = this.items.get(token)
    if (item === undefined) return null
    this.items.delete(token)
    return this.now() - item.at > this.ttlMs ? null : item.paths
  }
  /** 지금 수명 세대 — 가져오기가 시작할 때 들고 간다(R4-B). */
  get generation(): number {
    return this.lifetime
  }
  /** 근거를 붙잡는다 — 시작 뒤 세대가 바뀌었거나 owner 가 닫혔으면 붙잡지 않고 null(R4-B). */
  hold(input: { record: ReplayRecord; owner: string | null; generation: number }): string | null {
    if (input.generation !== this.lifetime || (input.owner !== null && this.closed.has(input.owner))) return null
    const id = crypto.randomUUID()
    this.held.set(id, { record: input.record, owner: input.owner })
    trim(this.held, this.holdLimit)
    return id
  }
  replayOf(id: unknown): ReplayRecord | null {
    return typeof id === 'string' ? (this.held.get(id)?.record ?? null) : null
  }
  release(ids: unknown): void {
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') this.held.delete(id)
  }
  /** hook 이 사라졌다 — 그 owner 의 근거를 전부 놓고, 이후 그 owner 로 끝나는 가져오기는 붙잡지 않는다(R4-B). */
  close(owner: unknown): void {
    if (typeof owner !== 'string') return
    this.closed.add(owner)
    for (const [id, item] of this.held) if (item.owner === owner) this.held.delete(id)
  }
  /** 렌더러가 새로 떴다 — 그 실행 취소 기록이 없으니 재생 근거를 전부 놓고 세대를 넘긴다(수정 r3·r4). 드롭 표지(2 분)는 그대로 둔다. */
  releaseAll(): void {
    this.held.clear()
    this.closed.clear()
    this.lifetime += 1
  }
  get heldSize(): number {
    return this.held.size
  }
}

export type OpDeps = {
  roots: () => readonly string[]
  /** main `shell.trashItem` — 실패면 reject. 영구 삭제로 넘어가지 않는다. */
  trashItem: (abs: string) => Promise<void>
  snapshots: SnapshotStore
  drops: DropStore
  hooks?: OpHooks
}

const errorCode = (error: unknown): string => (typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '')
const idOf = (stat: { dev: number; ino: number }): string => `${stat.dev}:${stat.ino}`
const stampOf = (stat: { dev: number; ino: number; size: number; mtimeMs: number }): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
/** 실행 취소 표지용 도장 — `stampOf` + 권한 비트(수정 r2 R2-C: chmod 는 mtime 을 바꾸지 않는다). 문서·감시 stamp 와는 다른 값이다(되살리기 결과 `stamp` 는 `stampOf`). */
const markStampOf = (stat: { dev: number; ino: number; size: number; mtimeMs: number; mode: number }): string => `${stampOf(stat)}:${(stat.mode & 0o7777).toString(8)}`
const kindOf = (stat: { isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean }): EntryKind | null =>
  stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null
const joinRel = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const parentOf = (rel: string): string => {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}
const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex')

/** 시스템 오류 → 거절 코드. `ELOOP` = 검사 뒤 경로에 링크가 끼었다(fd 연산이 거절한 경쟁). */
function fsRefusal(error: unknown, what: string): Refused {
  switch (errorCode(error)) {
    case 'EEXIST':
    case 'ENOTEMPTY':
      return refuse('exists', `${what}: 이미 있다 (${String(error)})`)
    case 'ENOENT':
      return refuse('not_found', `${what}: 없다 (${String(error)})`)
    case 'ELOOP':
      return refuse('changed', `${what}: 검사 뒤 경로에 링크가 끼었다 — 하지 않았다 (${String(error)})`)
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return refuse('permission_denied', `${what}: 권한 없음 (${String(error)})`)
    case 'ENOTDIR':
      return refuse('not_directory', `${what}: 폴더가 아니다 (${String(error)})`)
    default:
      return refuse('io_error', `${what}: ${String(error)}`)
  }
}

/** 상대 경로 형 검사 — 기존 항목을 가리키는 쪽. `..` 탈출은 가둠(`outside_root`)에서 걸리게 두고, 루트 안에 머무는 `.`·`..`·빈 성분은 이름 규칙으로 거절한다. */
function relShape(input: { realRoot: string; rel: string }): Refused | null {
  const parts = input.rel.split('/')
  if (!parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return isInside(input.realRoot, path.resolve(input.realRoot, input.rel)) ? refuse('invalid_name', `경로 성분 규칙 위반: ${JSON.stringify(input.rel)}`) : refuse('outside_root', '루트 밖')
}

/**
 * `.git` 보호를 **실제 위치**로 본다(수정 r1 R1-B) — 링크 없는 realpath(`abs`)가 루트 밑 어느 깊이에서든 `.git`(대소문자 무시 — APFS) 성분을 지나면 메타데이터 영역이다.
 * 들어온 상대 경로 문자열(`isProtectedRel`)만 보면 `.git` 을 가리키는 내부 링크·`.GIT` 표기로 그 안에 쓸 수 있었다.
 */
function insideGit(realRoot: string, abs: string): boolean {
  const rel = path.relative(realRoot, abs)
  if (rel === '' || path.isAbsolute(rel)) return false
  const parts = rel.split(path.sep)
  // 루트 밖은 첫 성분이 정확히 `..` 일 때뿐이다 — `..archive` 같은 정상 이름을 밖으로 보지 않는다(수정 r2 R2-B).
  return parts[0] !== '..' && parts.some(isGitName)
}

/** 폴더 가둠 — 루트 밑 실제 폴더(링크 없는 realpath). */
async function confineDir(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<{ ok: true; realRoot: string; abs: string; rel: string } | Refused> {
  const confined = await confine(input)
  if (!confined.ok) return refuse(confined.code, confined.error)
  try {
    const stat = await fs.lstat(confined.abs)
    if (!stat.isDirectory()) return refuse('not_directory', '폴더가 아니다')
  } catch (error) {
    return fsRefusal(error, '폴더')
  }
  // 쓰기 대상 폴더(만들기·옮겨 넣기·가져오기·되살리기의 부모)가 실제로 `.git` 안이면 거절.
  if (insideGit(confined.realRoot, confined.abs)) return refuse('protected', '.git 안에는 쓸 수 없다')
  return { ok: true, realRoot: confined.realRoot, abs: confined.abs, rel: confined.rel }
}

/**
 * 이미 있는 항목 — **마지막 성분은 따라가지 않는다**(링크면 링크 자체). 부모만 가두고(realpath), 부모 realpath + 이름 = 링크 없는 경로.
 * 루트 자체·`.git` 은 `protected`.
 */
type Entry = { realRoot: string; parentAbs: string; parentRel: string; name: string; abs: string; rel: string; kind: EntryKind; id: string; stamp: string; size: number; mode: number; nlink: number }
async function entryAt(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<{ ok: true; entry: Entry } | Refused> {
  const { rel } = input
  if (typeof rel !== 'string' || rel.includes('\0') || rel.startsWith('/') || rel.length > 4096) return refuse('invalid_argument', '상대 경로 형 위반')
  if (typeof input.root !== 'string' || !input.roots.includes(input.root)) return refuse('not_worktree', '열린 worktree 루트가 아니다')
  let realRoot: string
  try {
    realRoot = await fs.realpath(input.root)
  } catch (error) {
    return refuse('not_found', `루트 없음 ${String(error)}`)
  }
  if (rel === '') return refuse('protected', '루트 자체는 조작할 수 없다')
  const shape = relShape({ realRoot, rel })
  if (shape !== null) return shape
  if (isProtectedRel(rel)) return refuse('protected', rel === '' ? '루트 자체는 조작할 수 없다' : '.git 은 조작할 수 없다')
  const parentRel = parentOf(rel)
  const parent = await confineDir({ roots: input.roots, root: input.root, rel: parentRel })
  if (!parent.ok) return parent
  const name = rel.slice(parentRel === '' ? 0 : parentRel.length + 1)
  const abs = path.join(parent.abs, name)
  if (insideGit(parent.realRoot, abs)) return refuse('protected', '.git 은 조작할 수 없다')
  try {
    const stat = await fs.lstat(abs)
    const kind = kindOf(stat)
    if (kind === null) return refuse('not_file', '일반 파일·폴더·링크가 아니다(FIFO·소켓·장치) — 조작하지 않는다')
    return { ok: true, entry: { realRoot: parent.realRoot, parentAbs: parent.abs, parentRel, name, abs, rel, kind, id: idOf(stat), stamp: stampOf(stat), size: stat.size, mode: stat.mode, nlink: stat.nlink } }
  } catch (error) {
    return fsRefusal(error, '대상')
  }
}

/** 그 자리가 비어 있나(lstat ENOENT). 있으면 그 정체. */
async function occupant(abs: string): Promise<string | null> {
  try {
    return idOf(await fs.lstat(abs))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// --- 표지 (수정 r3 — 개념 하나) ----------------------------------------------------------------------------------
// 표지 = **이번 조작이 실제로 만든 항목들의 정체 집합**. 항목을 만든 그 순간 만든 쪽이 쥔 것으로 기록한다 — 파일은 쓴 fd 의 fstat, 폴더는 mkdir 직후
// 정체를 확인한(`mkdirChecked`) lstat, 링크는 symlink 직후 확인한 lstat. 조작이 끝난 뒤 경로를 다시 읽어 표지를 만들지 않는다(리뷰 r3 R3-A·B).
// 폴더 표지는 맨 위만이 아니라 이번 조작이 만든 하위 전부의 줄(상대 경로·종류·도장)을 담는다 — 복사 실패·건너뜀·`EEXIST`(남이 먼저 만든 것)는 담지 않는다.
// 실행 취소(`trash` 의 `expect`)는 지금 디스크를 같은 형식으로 읽어(`currentStamp`) 그 집합과 **정확히 같을 때만** 휴지통으로 보낸다 —
// 집합에 없는 항목이 폴더 안에 있거나(남이 추가) 집합 항목의 정체·도장이 다르면 거절. 새 파일·중간 폴더·복제·가져오기·되살리기·다시 실행이 모두 이 길을 쓴다.
// 도장: 파일·링크 = dev:ino:size:mtime:mode(`markStampOf`, 링크는 글 포함), 폴더 = dev:ino:mode(폴더 mtime 은 하위가 생길 때마다 바뀌므로 넣지 않는다 — 하위 변화는 줄 집합이 잡는다).

/** 표지 한 줄 — 맨 위 기준 상대 경로(맨 위 = '')·종류(f 파일·d 폴더·l 링크·o 특수)·정체(dev:ino)·도장(링크는 글 포함). */
type OwnedEntry = { rel: string; kind: 'f' | 'd' | 'l' | 'o'; id: string; stamp: string; link?: string }
/** 이번 조작이 만든 항목(맨 위)과 그 밑에서 이번에 만든 것 전부. */
type Owned = { kind: EntryKind; id: string; stamp: string; entries: OwnedEntry[] }
const dirStampOf = (stat: { dev: number; ino: number; mode: number }): string => `${stat.dev}:${stat.ino}:${(stat.mode & 0o7777).toString(8)}`
const ownedFile = (stat: Stats): Owned => {
  const stamp = markStampOf(stat)
  return { kind: 'file', id: idOf(stat), stamp, entries: [{ rel: '', kind: 'f', id: idOf(stat), stamp }] }
}
const ownedLink = (input: { stat: Stats; text: string }): Owned => {
  const stamp = markStampOf(input.stat)
  return { kind: 'link', id: idOf(input.stat), stamp, entries: [{ rel: '', kind: 'l', id: idOf(input.stat), stamp, link: input.text }] }
}
const ownedDir = (stat: Stats): Owned => {
  const stamp = dirStampOf(stat)
  return { kind: 'dir', id: idOf(stat), stamp, entries: [{ rel: '', kind: 'd', id: idOf(stat), stamp }] }
}
/** 하위에서 이번에 만든 것을 부모 집합에 싣는다(`at` = 부모 기준 상대 경로). */
const adopt = (input: { parent: Owned; at: string; child: Owned }): void => {
  input.parent.entries.push(...input.child.entries.map((entry) => ({ ...entry, rel: entry.rel === '' ? input.at : `${input.at}/${entry.rel}` })))
}
const entryText = (entry: OwnedEntry): string => (entry.kind === 'l' ? `l\0${entry.link ?? ''}\0${entry.stamp}` : entry.kind === 'o' ? `o\0${entry.id}` : `${entry.kind}\0${entry.stamp}`)
const treeHash = (entries: readonly OwnedEntry[]): string => `tree:${sha256(Buffer.from(entries.map((entry) => `${entry.rel}\0${entryText(entry)}`).sort().join('\n')))}`
/** 집합의 도장 — 폴더는 줄 집합의 해시, 파일·링크는 그 도장. */
const stampOfOwned = (owned: Owned): string => (owned.kind === 'dir' ? treeHash(owned.entries) : owned.stamp)
/** 만든 집합의 표지. */
const markOfOwned = (input: { rel: string; owned: Owned }): EntryMark => ({ rel: input.rel, stamp: stampOfOwned(input.owned) })
/** 이어진 정체로 바꿔 읽는다(수정 r4 R4-A — `SnapshotStore` 잇기). 잇기가 없는 줄은 그대로. 특수 파일 줄은 앱이 다시 만들지 않으므로 그대로. */
const canonOwned = (input: { owned: Owned; canon: SnapshotStore }): Owned => {
  const { owned, canon } = input
  const entries = owned.entries.map((entry) => (entry.kind === 'o' ? entry : { ...entry, id: canon.canonId(entry.id), stamp: canon.canonStamp(entry.stamp) }))
  return { kind: owned.kind, id: canon.canonId(owned.id), stamp: canon.canonStamp(owned.stamp), entries }
}

/**
 * 지금 디스크의 집합 — 표지와 같은 형식으로 읽는다(따라가지 않음). 폴더는 밑 전부(남이 넣은 것·특수 파일 포함).
 * 읽을 수 없는 하위가 있으면 던진다 — 실행 취소는 거절, 결과 표지는 「확인 불가」(`finalMark` — R2-G).
 */
async function currentOwned(abs: string): Promise<Owned> {
  const top = await fs.lstat(abs)
  if (top.isSymbolicLink()) return ownedLink({ stat: top, text: await fs.readlink(abs) })
  if (!top.isDirectory()) return ownedFile(top)
  const owned = ownedDir(top)
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await fs.readdir(dir)) {
      const child = path.join(dir, name)
      const at = rel === '' ? name : `${rel}/${name}`
      const entry = await fs.lstat(child)
      if (entry.isDirectory()) {
        adopt({ parent: owned, at, child: ownedDir(entry) })
        await walk(child, at)
      } else if (entry.isSymbolicLink()) adopt({ parent: owned, at, child: ownedLink({ stat: entry, text: await fs.readlink(child) }) })
      else if (entry.isFile()) adopt({ parent: owned, at, child: ownedFile(entry) })
      else owned.entries.push({ rel: at, kind: 'o', id: idOf(entry), stamp: idOf(entry) })
    }
  }
  await walk(abs, '')
  return owned
}
/** 지금 디스크 도장 그대로(이어 읽지 않음) — 만든 직후 그 자리가 만든 것인지 볼 때(R3-B). */
const currentStamp = (abs: string): Promise<string> => currentOwned(abs).then(stampOfOwned)

/** 지금 디스크 표지 — 이어진 정체로 읽는다(실행 취소 대조·원본 도장용 — R4-A). */
async function currentMarkOf(input: { parentAbs: string; name: string; rel: string; canon: SnapshotStore }): Promise<EntryMark> {
  return { rel: input.rel, stamp: stampOfOwned(canonOwned({ owned: await currentOwned(path.join(input.parentAbs, input.name)), canon: input.canon })) }
}

/** 원본 도장 — 못 읽으면 「확인 불가」(그 원본의 다시 실행은 거절된다). */
const safeMarkOf = (input: { parentAbs: string; name: string; rel: string; canon: SnapshotStore }): Promise<EntryMark> => currentMarkOf(input).catch(() => ({ rel: input.rel, stamp: UNVERIFIABLE }))

/**
 * 재생(다시 실행)이 새로 만든 집합을 실행 취소 때 치운 집합에 잇는다(R4-A). `was` = 렌더러 기록이 그 휴지통에 댄 표지 — main 이 그 표지로 실제 치운 집합을
 * 적어 둔 것(`noteTrashed`)이 있을 때만 잇는다(렌더러가 표지만으로 잇게 할 수 없다). 결과 표지는 이어진 정체로 낸다.
 */
function linkReplay(input: { canon: SnapshotStore; root: string; rel: string; made: Owned; was: unknown }): Owned {
  const marks = Array.isArray(input.was) ? input.was : []
  for (const mark of marks) {
    const rel = typeof mark === 'object' && mark !== null && 'rel' in mark ? mark.rel : undefined
    const stamp = typeof mark === 'object' && mark !== null && 'stamp' in mark ? mark.stamp : undefined
    if (rel !== input.rel || typeof stamp !== 'string') continue
    const trashed = input.canon.trashedOf({ root: input.root, rel: input.rel, stamp })
    if (trashed !== null) input.canon.link({ made: input.made.entries, was: trashed })
  }
  return canonOwned({ owned: input.made, canon: input.canon })
}

/**
 * 결과 표지 — 만든 집합의 표지. 다만 지금 그 자리를 읽을 수 없으면(읽을 수 없는 하위 — R2-G) 실행 취소가 대조할 수 없으므로 「확인 불가」 로 알린다.
 * 지금 디스크가 집합과 다른 것(복사 도중 남이 추가 — R3-A)은 표지를 바꾸지 않는다 — 실행 취소가 거절한다.
 */
async function finalMark(input: { abs: string; rel: string; owned: Owned }): Promise<EntryMark> {
  const mark = markOfOwned({ rel: input.rel, owned: input.owned })
  return currentStamp(input.abs).then(
    () => mark,
    () => ({ rel: input.rel, stamp: UNVERIFIABLE }),
  )
}

/**
 * 경로 연산 뒤 확인(Q8 (a)) — 부모 realpath 가 그대로(그 사이 부모 경로에 링크가 끼지 않았다)이고 그 자리 항목 정체가 기대와 같은가.
 * 어긋나면 경로 연산이 이미 다른 곳을 건드렸을 수 있다 — `changed`(done)로 알리고 로그에 남긴다.
 */
async function verifyAt(input: { parentAbs: string; name: string; id: string | null; kind: EntryKind }): Promise<string | null> {
  try {
    if ((await fs.realpath(input.parentAbs)) !== input.parentAbs) return '부모 경로가 연산 중에 바뀌었다'
    const target = path.join(input.parentAbs, input.name)
    const stat = await fs.lstat(target)
    if (input.id !== null && idOf(stat) !== input.id) return '결과 자리의 항목이 기대한 것과 다르다'
    // 링크가 아니면 경로 전체를 링크 없이 열어 본다(중간 성분이 링크로 바뀌었으면 ELOOP).
    if (input.kind !== 'link') {
      const handle = await fs.open(target, constants.O_RDONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK).catch((error: unknown) => (errorCode(error) === 'EACCES' ? null : Promise.reject(error)))
      if (handle !== null) {
        const fd = await handle.stat().finally(() => handle.close().catch(() => undefined))
        if (input.id !== null && idOf(fd) !== input.id) return '결과 자리의 항목(fd)이 기대한 것과 다르다'
      }
    }
    return null
  } catch (error) {
    return `사후 확인 실패: ${String(error)}`
  }
}

/** 폴더 하나 만들기(경로 연산) + 사후 확인. */
async function mkdirChecked(input: { parentAbs: string; name: string; mode?: number; hooks: OpHooks }): Promise<{ ok: true; id: string; hash: null; stat: Stats } | Refused> {
  const target = path.join(input.parentAbs, input.name)
  await input.hooks.afterCheck?.('mkdir')
  try {
    await fs.mkdir(target, { mode: input.mode ?? 0o777 })
  } catch (error) {
    return fsRefusal(error, '폴더 만들기')
  }
  const stat = await fs.lstat(target).catch(() => null)
  const problem = stat === null || !stat.isDirectory() ? '만든 폴더가 그 자리에 없다' : await verifyAt({ parentAbs: input.parentAbs, name: input.name, id: idOf(stat), kind: 'dir' })
  if (problem !== null || stat === null) return refuse('changed', `폴더를 만들었지만 사후 확인이 어긋났다: ${problem ?? ''}`, true)
  return { ok: true, id: idOf(stat), hash: null, stat }
}

/** 파일 만들기(fd 연산) — 링크 없는 부모 realpath + 이름을 `O_CREAT|O_EXCL|O_NOFOLLOW_ANY`. `source` 가 있으면 그 fd 에서 내용을 옮긴다. */
async function createFileFd(input: { parentAbs: string; name: string; bytes?: Buffer; source?: fs.FileHandle; mode?: number; hooks: OpHooks }): Promise<{ ok: true; id: string; hash: string | null; stat: Stats } | MadeRefused> {
  await input.hooks.afterCheck?.('create-file')
  let handle: fs.FileHandle
  try {
    handle = await fs.open(path.join(input.parentAbs, input.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY | constants.O_NONBLOCK, 0o666)
  } catch (error) {
    return fsRefusal(error, '파일 만들기')
  }
  try {
    let hash: string | null = null
    if (input.bytes !== undefined) {
      let offset = 0
      while (offset < input.bytes.length) offset += (await handle.write(input.bytes, offset, input.bytes.length - offset, offset)).bytesWritten
      hash = sha256(input.bytes)
    } else if (input.source !== undefined) {
      const chunk = Buffer.alloc(1024 * 1024)
      let position = 0
      for (;;) {
        const { bytesRead } = await input.source.read(chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) written += (await handle.write(chunk, written, bytesRead - written, position + written)).bytesWritten
        position += bytesRead
      }
    }
    if (input.mode !== undefined) await handle.chmod(input.mode & 0o777)
    // 표지 = 쓴 fd 의 fstat(수정 r3) — 경로를 다시 읽지 않는다.
    const stat = await handle.stat()
    return { ok: true, id: idOf(stat), hash, stat }
  } catch (error) {
    const refused = refuse('io_error', `파일을 만들었지만 쓰는 도중 실패했다 — 부분 파일이 남았다: ${String(error)}`, true)
    const stat = await handle.stat().catch(() => null)
    return stat === null ? refused : { ...refused, stat }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 원본 파일을 `O_NOFOLLOW_ANY` 로 연다(가져오기·복제) — 검사 뒤 링크로 바뀐 원본을 따라가지 않는다. 일반 파일이 아니면 null. */
async function openSource(abs: string): Promise<{ ok: true; handle: fs.FileHandle; mode: number; nlink: number } | Refused> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(abs, constants.O_RDONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK)
  } catch (error) {
    return fsRefusal(error, '원본 열기')
  }
  const stat = await handle.stat()
  if (!stat.isFile()) {
    await handle.close().catch(() => undefined)
    return refuse('not_file', '원본이 일반 파일이 아니다')
  }
  return { ok: true, handle, mode: stat.mode, nlink: stat.nlink }
}

/** 이름이 대소문자 무시로 그 폴더에 있나 — 복제·가져오기 새 이름 고르기(APFS 대소문자 무시). */
async function takenIn(parentAbs: string): Promise<(name: string) => boolean> {
  const names = new Set((await fs.readdir(parentAbs)).map((name) => name.normalize('NFC').toLowerCase()))
  return (name: string) => names.has(name.normalize('NFC').toLowerCase())
}

type CopyReport = { skipped: { name: string; reason: string }[]; failed: { name: string; error: string }[] }
/**
 * 복사 한 번의 결과 — `refused` = 거절(맨 위면 그 조작 거절, 하위면 경쟁 `changed` 만), `made` = 맨 위 항목과 그 밑에서 **이번에 만든** 것의 정체 집합(수정 r3).
 * 건너뜀(링크·특수 파일)·만들기 전 거절이면 `made` 가 null — 같은 이름에 그 사이 다른 작성자가 만든 것을 결과·실행 취소 대상에 넣지 않는다(수정 r2 R2-A).
 */
type Copied = { refused: Refused | null; made: Owned | null }

/**
 * 원본 하나를 `dstParentAbs/dstName` 으로 복사(재귀). 원본 파일은 `O_NOFOLLOW_ANY` fd 로만 읽는다. 원본 안 링크는 `links` 에 따라 —
 * `recreate`(복제: 링크는 링크로, 대상 글 그대로) · `skip`(가져오기: 따라가지도 만들지도 않는다 — Orca 와 같다). FIFO·소켓·장치는 건너뛴다.
 */
async function copyTree(input: { srcAbs: string; label: string; dstParentAbs: string; dstName: string; links: 'recreate' | 'skip'; hooks: OpHooks; report: CopyReport; top: boolean }): Promise<Copied> {
  const { srcAbs, label, report } = input
  const dstAbs = path.join(input.dstParentAbs, input.dstName)
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stat = await fs.lstat(srcAbs)
  } catch (error) {
    report.failed.push({ name: label, error: String(error) })
    return { refused: input.top ? fsRefusal(error, '원본') : null, made: null }
  }
  const kind = kindOf(stat)
  if (kind === null) {
    report.skipped.push({ name: label, reason: '특수 파일(FIFO·소켓·장치) — 복사하지 않음' })
    return { refused: null, made: null }
  }
  if (kind === 'link') {
    if (input.links === 'skip') {
      report.skipped.push({ name: label, reason: '심볼릭 링크 — 따라가지 않음(밖 내용을 들이지 않는다)' })
      return { refused: null, made: null }
    }
    const text = await fs.readlink(srcAbs)
    await input.hooks.afterCheck?.('symlink')
    try {
      await fs.symlink(text, dstAbs)
    } catch (error) {
      const refused = fsRefusal(error, '링크 만들기')
      report.failed.push({ name: label, error: refused.error })
      return { refused: input.top ? refused : null, made: null }
    }
    const linked = await fs.lstat(dstAbs).catch(() => null)
    const problem = linked === null ? '만든 링크가 그 자리에 없다' : await verifyAt({ parentAbs: input.dstParentAbs, name: input.dstName, id: idOf(linked), kind: 'link' })
    if (problem !== null || linked === null) return { refused: refuse('changed', `링크를 만들었지만 사후 확인이 어긋났다: ${problem ?? ''}`, true), made: null }
    return { refused: null, made: ownedLink({ stat: linked, text }) }
  }
  if (kind === 'file') {
    const source = await openSource(srcAbs)
    if (!source.ok) {
      report.failed.push({ name: label, error: source.error })
      return { refused: input.top ? source : null, made: null }
    }
    try {
      const made = await createFileFd({ parentAbs: input.dstParentAbs, name: input.dstName, source: source.handle, mode: source.mode, hooks: input.hooks })
      if (!made.ok) {
        report.failed.push({ name: label, error: made.error })
        return { refused: input.top || made.code === 'changed' ? plain(made) : null, made: made.stat === undefined ? null : ownedFile(made.stat) }
      }
      if (source.nlink > 1) report.skipped.push({ name: label, reason: `하드링크(nlink ${source.nlink}) — 내용을 새 파일로 복사함(링크 관계는 옮기지 않음)` })
      return { refused: null, made: ownedFile(made.stat) }
    } finally {
      await source.handle.close().catch(() => undefined)
    }
  }
  const made = await mkdirChecked({ parentAbs: input.dstParentAbs, name: input.dstName, mode: stat.mode & 0o777, hooks: input.hooks })
  if (!made.ok) {
    report.failed.push({ name: label, error: made.error })
    return { refused: input.top || made.code === 'changed' ? made : null, made: null }
  }
  const owned = ownedDir(made.stat)
  let names: string[]
  try {
    names = await fs.readdir(srcAbs)
  } catch (error) {
    report.failed.push({ name: label, error: `폴더 읽기 실패: ${String(error)}` })
    return { refused: null, made: owned }
  }
  for (const name of names) {
    const child = await copyTree({ ...input, srcAbs: path.join(srcAbs, name), label: `${label}/${name}`, dstParentAbs: dstAbs, dstName: name, top: false })
    // 하위에서 이번에 만든 것만 싣는다 — `EEXIST`(남이 먼저 만든 것)·실패·건너뜀은 `made` 가 없다(R3-A).
    if (child.made !== null) adopt({ parent: owned, at: name, child: child.made })
    if (child.refused !== null) return { refused: child.refused, made: owned }
  }
  return { refused: null, made: owned }
}

// --- 조작 ------------------------------------------------------------------------------------------------

/** 조작 한 번 — 예외는 `io_error` 로 돌려준다(핸들러가 던지지 않게). */
export async function runExplorerOp(deps: OpDeps, input: unknown): Promise<ExplorerOpResult> {
  try {
    return await dispatchOp(deps, input)
  } catch (error) {
    return refuse('io_error', String(error))
  }
}

async function dispatchOp(deps: OpDeps, input: unknown): Promise<ExplorerOpResult> {
  const record = typeof input === 'object' && input !== null ? input : {}
  const field = (name: string): unknown => (name in record ? Reflect.get(record, name) : undefined)
  const roots = deps.roots()
  const hooks = deps.hooks ?? {}
  const root = field('root')
  switch (field('op')) {
    case 'create':
      return create({ roots, root, dir: field('dir'), name: field('name'), kind: field('kind'), again: field('again') === true, was: field('was'), canon: deps.snapshots, hooks })
    case 'move':
      return move({ roots, root, from: field('from'), to: field('to'), expect: field('expect'), canon: deps.snapshots, hooks })
    case 'trash':
      return trash({ deps, roots, root, rel: field('rel'), snapshot: field('snapshot') === true, expect: field('expect'), hooks })
    case 'restore':
      return restore({ deps, roots, root, rel: field('rel'), snapshotId: field('snapshotId'), hooks })
    case 'duplicate':
      return duplicate({ roots, root, rel: field('rel'), again: field('again'), was: field('was'), canon: deps.snapshots, hooks })
    case 'import':
      return importDrop({ deps, roots, root, dir: field('dir'), token: field('token'), replay: field('replay'), names: field('names'), was: field('was'), owner: field('owner'), hooks })
    case 'release':
      deps.drops.release(field('ids'))
      deps.drops.close(field('owner'))
      return { ok: true, op: 'release' }
    case 'inspect':
      return inspect({ roots, root, rel: field('rel') })
    default:
      return refuse('invalid_argument', '모르는 조작')
  }
}

async function create(input: { roots: readonly string[]; root: unknown; dir: unknown; name: unknown; kind: unknown; again: boolean; was: unknown; canon: SnapshotStore; hooks: OpHooks }): Promise<ExplorerOpResult> {
  const { kind } = input
  if (typeof input.name !== 'string' || (kind !== 'file' && kind !== 'dir') || typeof input.dir !== 'string') return refuse('invalid_argument', '형 위반')
  const split = splitNewName(input.name)
  if (!split.ok) return refuse('invalid_name', split.error)
  const parent = await confineDir({ roots: input.roots, root: input.root, rel: input.dir })
  if (!parent.ok) return parent
  if (isProtectedRel(joinRel(parent.rel, split.parts[0] ?? '')) || split.parts.some(isGitName)) return refuse('protected', '.git 안에는 만들 수 없다')
  // 다시 실행(R3-C) — 원래 조작이 만든 맨 위 자리(첫 성분)가 비어 있을 때만. 남이 그 이름으로 만든 폴더 안에 쓰지 않는다(새 만들기의 「이미 있는 중간 폴더 사용」 — E1ⓓ — 과 다르다).
  if (input.again) {
    const first = split.parts[0] ?? ''
    if ((await occupant(path.join(parent.abs, first)).catch(() => 'error')) !== null) return refuse('exists', `원래 만든 '${joinRel(parent.rel, first)}' 자리에 이미 항목이 있다 — 그 안에 다시 만들지 않는다`)
  }
  let currentAbs = parent.abs
  let currentRel = parent.rel
  /** 처음 만든 것(중간 폴더를 만들었으면 그 맨 위)과 그 밑에서 이번에 만든 것 전부(R3-B). */
  let created: { rel: string; abs: string; owned: Owned } | null = null
  const took = (rel: string, abs: string, owned: Owned): void => {
    if (created === null) created = { rel, abs, owned }
    else adopt({ parent: created.owned, at: rel.slice(created.rel.length + 1), child: owned })
  }
  // 도중 실패 — 앞서 만든 중간 폴더가 남는다. 조용히 남기지 않고 남은 폴더를 싣는다(done — 점검 표 M-1·R3-D).
  const partly = (made: Refused): Refused => (created === null ? plain(made) : { ok: false, code: made.code, error: `${made.error} — 중간 폴더 '${created.rel}' 는 만들어졌다`, done: true, remains: [created.rel] })
  for (const [index, part] of split.parts.entries()) {
    const last = index === split.parts.length - 1
    const rel = joinRel(currentRel, part)
    const abs = path.join(currentAbs, part)
    if (!last) {
      // 중간 폴더 — 이미 있는 폴더면 그대로 내려가고(링크·파일이면 거절), 없으면 만든다.
      const existing = await fs.lstat(abs).catch((error: unknown) => (errorCode(error) === 'ENOENT' ? null : Promise.reject(error)))
      if (existing !== null && !existing.isDirectory()) return partly(refuse('exists', `'${rel}' 이(가) 폴더가 아니다`))
      if (existing === null) {
        const made = await mkdirChecked({ parentAbs: currentAbs, name: part, hooks: input.hooks })
        if (!made.ok) return partly(made)
        took(rel, abs, ownedDir(made.stat))
      }
      currentAbs = abs
      currentRel = rel
      continue
    }
    const made = kind === 'dir' ? await mkdirChecked({ parentAbs: currentAbs, name: part, hooks: input.hooks }) : await createFileFd({ parentAbs: currentAbs, name: part, bytes: Buffer.alloc(0), hooks: input.hooks })
    if (!made.ok) return partly(made)
    took(rel, abs, kind === 'dir' ? ownedDir(made.stat) : ownedFile(made.stat))
    if (created === null) return refuse('io_error', '만든 항목이 없다', true)
    const top: { rel: string; abs: string; owned: Owned } = created
    // 만든 직후 그 자리가 이미 다른 항목이면(외부 원자 저장 등) 성공·표지로 기록하지 않는다 — 실행 취소가 남의 것을 치우지 않게(R3-B).
    const mark = markOfOwned({ rel: top.rel, owned: top.owned })
    if ((await currentStamp(top.abs).catch(() => null)) !== mark.stamp) return refuse('changed', `'${top.rel}' 을(를) 만들었지만 그 자리가 곧바로 다른 항목으로 바뀌었다 — 실행 취소 기록을 만들지 않았다`, true)
    // 다시 실행 재생이면 실행 취소 때 치운 집합에 잇는다(R4-A) — 결과 표지는 이어진 정체.
    const owned = input.again ? linkReplay({ canon: input.canon, root: parent.realRoot, rel: top.rel, made: top.owned, was: input.was }) : canonOwned({ owned: top.owned, canon: input.canon })
    return { ok: true, op: 'create', rel, kind, created: top.rel, marks: [markOfOwned({ rel: top.rel, owned })] }
  }
  return refuse('invalid_name', '빈 이름')
}

async function move(input: { roots: readonly string[]; root: unknown; from: unknown; to: unknown; expect: unknown; canon: SnapshotStore; hooks: OpHooks }): Promise<ExplorerOpResult> {
  if (typeof input.to !== 'string' || input.to.includes('\0') || input.to.startsWith('/')) return refuse('invalid_argument', '대상 경로 형 위반')
  const found = await entryAt({ roots: input.roots, root: input.root, rel: input.from })
  if (!found.ok) return found
  const src = found.entry
  // 정체는 이어진 것으로 본다(R4-A — 앱이 되살리거나 재생한 항목은 옛 정체). 결과 `id` 도 같은 정체로 낸다(다음 실행 취소·다시 실행이 대조).
  const srcId = input.canon.canonId(src.id)
  if (typeof input.expect === 'string' && input.expect !== srcId) return refuse('modified', '되돌릴 항목이 그 사이 바뀌었다(다른 항목)')
  const to = input.to
  const toParentRel = parentOf(to)
  const toName = to.slice(toParentRel === '' ? 0 : toParentRel.length + 1)
  const shape = toParentRel === '' ? null : relShape({ realRoot: src.realRoot, rel: toParentRel })
  if (shape !== null) return shape
  const badName = nameError(toName)
  if (badName !== null) return refuse('invalid_name', badName)
  if (isProtectedRel(to)) return refuse('protected', '.git 으로 옮길 수 없다')
  if (to === src.rel) return { ok: true, op: 'move', from: src.rel, to, id: srcId }
  if (src.kind === 'dir' && to.startsWith(`${src.rel}/`)) return refuse('into_self', '폴더를 자기 자신이나 그 안으로 옮길 수 없다')
  const dst = await confineDir({ roots: input.roots, root: input.root, rel: toParentRel })
  if (!dst.ok) return dst
  const dstAbs = path.join(dst.abs, toName)
  // 실경로로도 자기 하위인지(링크 폴더를 거친 경로) 본다.
  if (src.kind === 'dir' && (dst.abs === src.abs || dst.abs.startsWith(`${src.abs}/`))) return refuse('into_self', '폴더를 자기 자신이나 그 안으로 옮길 수 없다')
  if (dstAbs === src.abs) return { ok: true, op: 'move', from: src.rel, to, id: srcId }
  // 대상 자리 — 비어 있어야 한다. 같은 부모·같은 inode(대소문자만 다른 이름 — APFS 대소문자 무시)면 허용(E2ⓒ).
  const caseOnly = dst.abs === src.parentAbs && toName.toLowerCase() === src.name.toLowerCase()
  const checkTarget = async (): Promise<Refused | null> => {
    const there = await occupant(dstAbs).catch(() => 'error')
    if (there === null || (caseOnly && there === src.id)) return null
    return refuse('exists', `'${to}' 에 이미 항목이 있다 — 덮어쓰지 않는다`)
  }
  const occupied = await checkTarget()
  if (occupied !== null) return occupied
  await input.hooks.afterCheck?.('rename')
  // 부르기 직전 다시(창을 좁힌다) — 원본 정체 그대로·대상 자리 비어 있음.
  const again = await occupant(src.abs).catch(() => null)
  if (again !== src.id) return refuse('changed', '원본이 검사 뒤에 바뀌었다 — 옮기지 않았다')
  const stillFree = await checkTarget()
  if (stillFree !== null) return stillFree
  try {
    await fs.rename(src.abs, dstAbs)
  } catch (error) {
    return fsRefusal(error, '이름 변경')
  }
  const problem = (await verifyAt({ parentAbs: dst.abs, name: toName, id: src.id, kind: src.kind })) ?? (caseOnly ? null : (await occupant(src.abs).catch(() => null)) === null ? null : '원본 자리에 아직 항목이 있다')
  if (problem !== null) return refuse('changed', `옮겼지만 사후 확인이 어긋났다: ${problem}`, true)
  return { ok: true, op: 'move', from: src.rel, to, id: srcId }
}

async function trash(input: { deps: OpDeps; roots: readonly string[]; root: unknown; rel: unknown; snapshot: boolean; expect: unknown; hooks: OpHooks }): Promise<ExplorerOpResult> {
  const found = await entryAt({ roots: input.roots, root: input.root, rel: input.rel })
  if (!found.ok) return found
  const entry = found.entry
  // 실행 취소(만들기 되돌리기) — 만든 뒤 바뀌었으면 거절(조용히 지우지 않는다 — E5ⓒ).
  if (Array.isArray(input.expect)) {
    for (const mark of input.expect) {
      const rel = typeof mark === 'object' && mark !== null && 'rel' in mark ? mark.rel : undefined
      const stamp = typeof mark === 'object' && mark !== null && 'stamp' in mark ? mark.stamp : undefined
      if (typeof rel !== 'string' || typeof stamp !== 'string') return refuse('invalid_argument', '표지 형 위반')
      const now = rel === entry.rel ? entry : await entryAt({ roots: input.roots, root: input.root, rel }).then((result) => (result.ok ? result.entry : null))
      // 폴더는 밑 전부를 담은 도장으로 견준다(R1-C — 하위 파일 편집·추가·삭제도 「바뀜」).
      // 만들 때 도장을 못 만든 항목(R2-G — 읽을 수 없는 하위)은 바뀌었는지 알 수 없다 — 지우지 않는다.
      if (stamp === UNVERIFIABLE) return refuse('modified', `'${rel}' 은(는) 바뀌었는지 확인할 수 없다(읽을 수 없는 하위 항목) — 실행 취소하지 않았다(직접 삭제하세요)`)
      // 지금 디스크가 만든 집합과 정확히 같을 때만(수정 r3 — 집합에 없는 하위·정체·도장이 다르면 거절).
      // 앱이 되살리거나 재생한 항목은 이어진 옛 정체로 읽는다(R4-A — 그 뒤 남이 바꿨으면 잇지 않으니 거절 그대로).
      const current = now === null ? null : await currentMarkOf({ parentAbs: now.parentAbs, name: now.name, rel, canon: input.deps.snapshots }).catch(() => null)
      if (current === null || current.stamp !== stamp) return refuse('modified', `'${rel}' 이(가) 만든 뒤 바뀌었다 — 실행 취소하지 않았다(직접 삭제하세요)`)
    }
  }
  // 실행 취소로 치우는 집합(R4-A) — 대조를 통과한 바로 그 집합을 적어 두면, 그 표지로 재생(다시 실행)한 새 항목을 이 정체로 잇는다.
  const sweptMark = Array.isArray(input.expect) ? input.expect.find((mark: unknown) => typeof mark === 'object' && mark !== null && 'rel' in mark && mark.rel === entry.rel) : undefined
  const sweptStamp = typeof sweptMark === 'object' && sweptMark !== null && 'stamp' in sweptMark && typeof sweptMark.stamp === 'string' ? sweptMark.stamp : null
  const swept = sweptStamp === null ? null : await currentOwned(entry.abs).then((owned) => canonOwned({ owned, canon: input.deps.snapshots }), () => null)
  let snapshotId: string | null = null
  if (input.snapshot && entry.kind === 'file' && entry.size <= UNDO_SNAPSHOT_LIMIT) {
    const source = await openSource(entry.abs)
    if (!source.ok) return source
    try {
      const stat = await source.handle.stat()
      if (idOf(stat) !== entry.id) return refuse('changed', '검사와 읽기 사이에 다른 파일로 바뀌었다')
      const bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < stat.size) {
        const { bytesRead } = await source.handle.read(bytes, offset, stat.size - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      // 사본을 뜬 바로 그 항목의 정체(R4-A) — 읽는 동안 바뀌었으면(도장이 다르면) 잇지 않는다.
      const after = await source.handle.stat()
      const was = markStampOf(after) === markStampOf(stat) && offset === stat.size ? canonOwned({ owned: ownedFile(stat), canon: input.deps.snapshots }).entries : undefined
      snapshotId = input.deps.snapshots.put({ root: entry.realRoot, kind: 'file', bytes: bytes.subarray(0, offset), mode: stat.mode & 0o777, was })
    } finally {
      await source.handle.close().catch(() => undefined)
    }
  } else if (input.snapshot && entry.kind === 'dir' && (await fs.readdir(entry.abs)).length === 0) {
    const stat = await fs.lstat(entry.abs)
    const was = idOf(stat) === entry.id && stat.isDirectory() ? canonOwned({ owned: ownedDir(stat), canon: input.deps.snapshots }).entries : undefined
    snapshotId = input.deps.snapshots.put({ root: entry.realRoot, kind: 'dir', mode: entry.mode & 0o777, was })
  }
  await input.hooks.afterCheck?.('trash')
  const again = await occupant(entry.abs).catch(() => null)
  if (again !== entry.id || (await fs.realpath(entry.parentAbs).catch(() => null)) !== entry.parentAbs) {
    if (snapshotId !== null) input.deps.snapshots.drop(snapshotId)
    return refuse('changed', '대상이 검사 뒤에 바뀌었다 — 휴지통으로 보내지 않았다')
  }
  try {
    await input.deps.trashItem(entry.abs)
  } catch (error) {
    if (snapshotId !== null) input.deps.snapshots.drop(snapshotId)
    return refuse('trash_failed', `휴지통으로 옮기지 못했다 — 영구 삭제하지 않았다: ${String(error)}`)
  }
  const left = await occupant(entry.abs).catch(() => null)
  if (left !== null) {
    if (snapshotId !== null) input.deps.snapshots.drop(snapshotId)
    return refuse('changed', '휴지통으로 옮겼지만 그 자리에 항목이 남아 있다(사후 확인)', true)
  }
  if (swept !== null && sweptStamp !== null && stampOfOwned(swept) === sweptStamp) input.deps.snapshots.noteTrashed({ root: entry.realRoot, rel: entry.rel, stamp: sweptStamp, entries: swept.entries })
  return { ok: true, op: 'trash', rel: entry.rel, kind: entry.kind, snapshotId }
}

async function restore(input: { deps: OpDeps; roots: readonly string[]; root: unknown; rel: unknown; snapshotId: unknown; hooks: OpHooks }): Promise<ExplorerOpResult> {
  if (typeof input.rel !== 'string' || typeof input.snapshotId !== 'string') return refuse('invalid_argument', '형 위반')
  const snapshot = input.deps.snapshots.get(input.snapshotId)
  if (snapshot === undefined) return refuse('expired', '되살릴 내용 사본이 메모리에 없다(앱 재시작 또는 상한 초과)')
  const rel = input.rel
  const parentRel = parentOf(rel)
  const name = rel.slice(parentRel === '' ? 0 : parentRel.length + 1)
  const badName = nameError(name)
  if (badName !== null) return refuse('invalid_name', badName)
  if (isProtectedRel(rel)) return refuse('protected', '.git 은 조작할 수 없다')
  const parent = await confineDir({ roots: input.roots, root: input.root, rel: parentRel })
  if (!parent.ok) return parent
  if (parent.realRoot !== snapshot.root) return refuse('invalid_argument', '사본이 다른 worktree 의 것이다')
  const made = snapshot.kind === 'file' ? await createFileFd({ parentAbs: parent.abs, name, bytes: snapshot.bytes, mode: snapshot.mode, hooks: input.hooks }) : await mkdirChecked({ parentAbs: parent.abs, name, mode: snapshot.mode, hooks: input.hooks })
  if (!made.ok) return plain(made)
  input.deps.snapshots.drop(input.snapshotId)
  // 표지 = 되살린 fd·mkdir 의 정체(R3-B). 곧바로 그 자리가 다른 항목이면 성공·표지로 기록하지 않는다.
  const owned = snapshot.kind === 'file' ? ownedFile(made.stat) : ownedDir(made.stat)
  if ((await currentStamp(path.join(parent.abs, name)).catch(() => null)) !== stampOfOwned(owned)) return refuse('changed', `'${rel}' 을(를) 되살렸지만 그 자리가 곧바로 다른 항목으로 바뀌었다 — 실행 취소 기록을 만들지 않았다`, true)
  // 되살린 새 항목을 휴지통에 보낸 바로 그 항목의 정체에 잇는다(R4-A) — 앞·뒤 기록(만들기·이름 변경·이동·복제·가져오기)이 기대하던 정체 그대로 대조된다.
  if (snapshot.was !== undefined) input.deps.snapshots.link({ made: owned.entries, was: snapshot.was })
  const mark = markOfOwned({ rel, owned: canonOwned({ owned, canon: input.deps.snapshots }) })
  // 결과 `stamp` 는 문서·감시와 같은 형식(`stampOf`) — 남은 수정 중 탭의 기준을 옮긴다. 표지(`marks`)는 권한까지 담은 실행 취소용.
  return { ok: true, op: 'restore', rel, marks: [mark], hash: made.hash, stamp: snapshot.kind === 'file' ? stampOf(made.stat) : null }
}

/** 다시 실행 재생 인자(R2-D) — 형이 맞지 않으면 'invalid'. */
function againOf(value: unknown): { name: string; source: string } | null | 'invalid' {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || !('name' in value) || !('source' in value)) return 'invalid'
  const { name, source } = value
  return typeof name === 'string' && typeof source === 'string' ? { name, source } : 'invalid'
}

async function duplicate(input: { roots: readonly string[]; root: unknown; rel: unknown; again: unknown; was: unknown; canon: SnapshotStore; hooks: OpHooks }): Promise<ExplorerOpResult> {
  const found = await entryAt({ roots: input.roots, root: input.root, rel: input.rel })
  if (!found.ok) return found
  const src = found.entry
  const again = againOf(input.again)
  if (again === 'invalid') return refuse('invalid_argument', '다시 실행 인자 형 위반')
  // 원본 도장 — 복제 직전. 다시 실행은 이것이 원래 복제 때와 같을 때만 같은 이름으로 다시 만든다(R2-D — 지금 원본·새 이름으로 재생하지 않는다).
  const source = await safeMarkOf({ parentAbs: src.parentAbs, name: src.name, rel: src.rel, canon: input.canon })
  let newName: string
  if (again === null) newName = copyName({ name: src.name, isDir: src.kind === 'dir', taken: await takenIn(src.parentAbs) })
  else {
    const badName = nameError(again.name)
    if (badName !== null) return refuse('invalid_name', badName)
    if (isGitName(again.name)) return refuse('protected', '.git 은 만들 수 없다')
    if (again.source === UNVERIFIABLE || source.stamp !== again.source) return refuse('modified', `복제 원본 '${src.rel}' 이(가) 원래 복제 뒤 바뀌었다(또는 확인할 수 없다) — 다시 복제하지 않았다`)
    if ((await occupant(path.join(src.parentAbs, again.name))) !== null) return refuse('exists', `원래 사본 자리 '${again.name}' 에 이미 항목이 있다 — 다른 이름으로 만들지 않는다`)
    newName = again.name
  }
  const report: CopyReport = { skipped: [], failed: [] }
  const { refused, made } = await copyTree({ srcAbs: src.abs, label: src.name, dstParentAbs: src.parentAbs, dstName: newName, links: 'recreate', hooks: input.hooks, report, top: true })
  const rel = joinRel(src.parentRel, newName)
  // 도중 실패로 덜 만든 사본(R1-H 와 같은 규칙) — 이번에 만든 것(정체)이 그 자리에 그대로 있으면 결과·실행 취소 대상에 넣고 실패를 같이 알린다. 경쟁(`changed`)·만든 것 없음은 거절 그대로.
  if (refused !== null && (refused.code === 'changed' || refused.done !== true || made === null)) return refused
  if (made === null) return refuse('io_error', '복제한 항목이 그 자리에 없다', true)
  if ((await occupant(path.join(src.parentAbs, newName)).catch(() => null)) !== made.id) return refuse('changed', '복제한 자리의 항목이 만든 것과 다르다 — 실행 취소 대상에 넣지 않았다', true)
  if (refused !== null && !report.failed.some((row) => row.error === refused.error)) report.failed.push({ name: src.name, error: refused.error })
  // 다시 실행 재생이면 실행 취소 때 치운 집합에 잇는다(R4-A).
  const owned = again !== null ? linkReplay({ canon: input.canon, root: src.realRoot, rel, made, was: input.was }) : canonOwned({ owned: made, canon: input.canon })
  return { ok: true, op: 'duplicate', from: src.rel, rel, kind: src.kind, marks: [await finalMark({ abs: path.join(src.parentAbs, newName), rel, owned })], skipped: report.skipped, failed: report.failed, source: source.stamp }
}

/** 가져올 원본 하나 — 새 드롭이면 `name` 은 null(충돌 이름을 고른다), 다시 실행이면 원래 만든 이름·원래 원본 도장. */
type ImportSource = { src: string; name: string | null; source: string | null }

async function importDrop(input: { deps: OpDeps; roots: readonly string[]; root: unknown; dir: unknown; token: unknown; replay: unknown; names: unknown; was: unknown; owner: unknown; hooks: OpHooks }): Promise<ExplorerOpResult> {
  const replaying = input.replay !== undefined
  // 시작할 때의 수명 세대(R4-B) — 끝났을 때 바뀌었으면 재생 근거를 붙잡지 않는다.
  const generation = input.deps.drops.generation
  const canon = input.deps.snapshots
  let sources: ImportSource[]
  let record: ReplayRecord | null = null
  if (!replaying) {
    const paths = input.deps.drops.take(input.token)
    if (paths === null) return refuse('bad_token', '가져오기 표지가 없거나 이미 썼다 — 실제 드롭에서 온 원본만 가져온다')
    sources = []
    for (const original of paths) {
      // 원본 부모의 링크(예: /tmp → /private/tmp)는 풀고, 원본 항목 자체는 따라가지 않는다(lstat — 링크면 건너뜀).
      const srcParent = await fs.realpath(path.dirname(original)).catch(() => null)
      sources.push({ src: srcParent === null ? original : path.join(srcParent, path.basename(original)), name: srcParent === null ? '' : null, source: null })
    }
  } else {
    record = input.deps.drops.replayOf(input.replay)
    if (record === null) return refuse('bad_token', '다시 가져올 근거가 없다(실행 취소 기록에서 빠졌거나 앱을 다시 시작했다)')
    const names = Array.isArray(input.names) ? input.names.filter((name): name is string => typeof name === 'string') : []
    const items = record.items.filter((item) => names.includes(item.name))
    if (items.length === 0 || items.length !== names.length) return refuse('invalid_argument', '다시 가져올 항목 형 위반')
    sources = items.map((item) => ({ src: item.src, name: item.name, source: item.source }))
  }
  const dir = await confineDir({ roots: input.roots, root: input.root, rel: input.dir })
  if (!dir.ok) return dir
  if (dir.rel !== '' && isProtectedRel(dir.rel)) return refuse('protected', '.git 안으로는 가져오지 않는다')
  if (record !== null && (record.root !== dir.realRoot || record.dir !== dir.rel)) return refuse('invalid_argument', '다시 가져올 곳이 원래 가져온 곳과 다르다')
  // 다시 실행 — 하나라도 원본이 바뀌었거나(확인 불가 포함) 원래 자리가 차 있으면 아무것도 만들지 않는다(R2-D — 새 이름·지금 원본으로 재생하지 않는다).
  for (const item of replaying ? sources : []) {
    const now = await safeMarkOf({ parentAbs: path.dirname(item.src), name: path.basename(item.src), rel: '', canon })
    if (item.source === null || item.source === UNVERIFIABLE || now.stamp !== item.source) return refuse('modified', `가져오기 원본 '${path.basename(item.src)}' 이(가) 원래 가져오기 뒤 바뀌었다(또는 확인할 수 없다) — 다시 가져오지 않았다`)
    if ((await occupant(path.join(dir.abs, item.name ?? '')).catch(() => 'error')) !== null) return refuse('exists', `원래 자리 '${item.name ?? ''}' 에 이미 항목이 있다 — 다른 이름으로 만들지 않는다`)
  }
  const report: CopyReport = { skipped: [], failed: [] }
  const rels: string[] = []
  const marks: EntryMark[][] = []
  const partial: string[] = []
  const held: ReplayRecord['items'] = []
  for (const item of sources) {
    const name = path.basename(item.src)
    if (item.name === '' || nameError(name) !== null) {
      report.failed.push({ name, error: '원본 경로를 읽을 수 없다' })
      continue
    }
    const srcAbs = item.src
    // 원본이 대상 폴더 자신이거나 그 위(조상)면 끝없이 복사한다 — 거절.
    if (dir.abs === srcAbs || dir.abs.startsWith(`${srcAbs}/`)) {
      report.skipped.push({ name, reason: '대상 폴더가 원본 안에 있다 — 가져오지 않음' })
      continue
    }
    // 원본 이름이 `.git`(대소문자 무시)이면 worktree 안에 메타데이터 폴더를 들이지 않는다(R1-B).
    if (isGitName(name)) {
      report.skipped.push({ name, reason: '.git — 가져오지 않음' })
      continue
    }
    const stat = await fs.lstat(srcAbs).catch(() => null)
    // 원본 도장 — 가져오기 직전(다시 실행이 원본이 그대로인지 본다 — R2-D).
    const source = item.source ?? (await safeMarkOf({ parentAbs: path.dirname(srcAbs), name, rel: '', canon })).stamp
    const dstName = item.name ?? copyName({ name, isDir: stat?.isDirectory() === true, taken: await takenIn(dir.abs) })
    const before = report.failed.length
    const { refused, made } = await copyTree({ srcAbs, label: name, dstParentAbs: dir.abs, dstName, links: 'skip', hooks: input.hooks, report, top: true })
    if (refused !== null && refused.code === 'changed') return { ...refused, error: `${refused.error} (가져온 것: ${rels.join(', ') || '없음'})` }
    if (refused !== null && report.failed.length === before) report.failed.push({ name, error: refused.error })
    // 결과·표지·실행 취소 대상 = 이번에 **만든** 항목만(R2-A). 건너뜀(링크·특수 파일)·만들기 전 거절은 만든 것이 없다 — 그 이름에 그 사이 다른 작성자가 만든 것이 있어도 넣지 않는다.
    // 만든 뒤 쓰기 도중 실패(`done`)면 부분 파일이 남는다 — 정체가 그대로면 결과·실행 취소 대상에 넣는다(R1-H).
    if (made === null) continue
    if ((await occupant(path.join(dir.abs, dstName)).catch(() => null)) !== made.id) {
      report.failed.push({ name, error: '만든 뒤 그 자리 항목이 바뀌었다 — 결과·실행 취소 대상에 넣지 않음' })
      continue
    }
    const rel = joinRel(dir.rel, dstName)
    rels.push(rel)
    // 다시 실행 재생이면 실행 취소 때 치운 집합에 잇는다(R4-A).
    const owned = replaying ? linkReplay({ canon, root: dir.realRoot, rel, made, was: input.was }) : canonOwned({ owned: made, canon })
    marks.push([await finalMark({ abs: path.join(dir.abs, dstName), rel, owned })])
    held.push({ src: srcAbs, name: dstName, source })
    if (refused !== null || report.failed.length > before) partial.push(rel)
  }
  // 다시 실행 근거(R2-E) — 새 가져오기면 이번에 만든 것만 붙잡고, 다시 실행이면 원래 근거 그대로(같은 id).
  // 새 가져오기의 근거는 시작 때 세대·owner 가 아직 살아 있을 때만 붙잡는다(R4-B — 수명이 끝난 뒤 끝난 가져오기는 놓은 채로).
  const owner = typeof input.owner === 'string' ? input.owner : null
  const replayId = typeof input.replay === 'string' ? input.replay : held.length > 0 ? input.deps.drops.hold({ record: { root: dir.realRoot, dir: dir.rel, items: held }, owner, generation }) : null
  return { ok: true, op: 'import', dir: dir.rel, rels, marks, skipped: report.skipped, failed: report.failed, partial, replayId }
}

async function inspect(input: { roots: readonly string[]; root: unknown; rel: unknown }): Promise<ExplorerOpResult> {
  const found = await entryAt(input)
  if (!found.ok) return found
  const { entry } = found
  return { ok: true, op: 'inspect', rel: entry.rel, kind: entry.kind, size: entry.size, undoable: entry.kind === 'file' && entry.size <= UNDO_SNAPSHOT_LIMIT }
}

/**
 * 시험 전용 주입을 읽는다 — **패키지 앱이면 늘 빈 값**, 개발 실행도 `CORRAL_TEST_OP_HOOK_FILE` 이 있을 때만(파일은 조작마다 다시 읽는다).
 * 형식: `{ "phase": "<rename|mkdir|create-file|trash|symlink>", "swapDir": "<루트 안 폴더>", "linkTo": "<밖 폴더>" }` — 경로는 `/tmp/l592` 밑만.
 * 그 단계의 검사 뒤·호출 직전에 `swapDir` 을 `<이름>.l592-orig` 로 옮기고 같은 자리에 `linkTo` 링크를 만든다(E9ⓒ⑩ 경쟁 주입). 한 번만 한다.
 */
export async function loadOpHooks(input: { packaged: boolean; file: string | undefined }): Promise<OpHooks> {
  if (input.packaged || input.file === undefined || input.file === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(input.file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const underTmp = (value: unknown): value is string => typeof value === 'string' && /^\/(private\/)?tmp\/l592[^/]*\//.test(value)
  const swapDir = 'swapDir' in parsed ? parsed.swapDir : undefined
  const linkTo = 'linkTo' in parsed ? parsed.linkTo : undefined
  const phase = 'phase' in parsed ? parsed.phase : undefined
  if (!underTmp(swapDir) || !underTmp(linkTo)) return {}
  let fired = false
  return {
    afterCheck: async (at) => {
      if (fired || (typeof phase === 'string' && phase !== at)) return
      fired = true
      await fs.rename(swapDir, `${swapDir}.l592-orig`)
      await fs.symlink(linkTo, swapDir)
    },
  }
}
