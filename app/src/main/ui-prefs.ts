// 화면 전용 영속 상태 (LIFE-357 C2·C3 — 사이드바 폭, 레포/에이전트그룹 접힘).
//
// **`localStorage` 대신 이 파일을 쓰는 이유** (실측): 이 앱은 프로덕션 빌드에서 렌더러를
// `loadFile()`(file:// 오리진)로 띄우는데, 그 경로에서는 Chromium 의 LocalStorage 커밋이
// 디스크에 반영되지 않는 현상을 실측했다 — `session.flushStorageData()` 를 명시로 불러도,
// 프로세스를 정상 종료해도 재기동 후 값이 사라졌다(raw/claude-orca/c2-resize.json 1차 실행
// 참고). registry.ts 와 같은 tmp→rename 원자적 쓰기로 옮겨 이 문제를 완전히 피한다 — corral
// 이 이미 갖고 있는, 검증된 영속 패턴이다.
//
// 저장하는 것은 **화면 UI 상태뿐**이다(레포 목록 등 다른 영속 상태와 섞지 않는다, registry.ts
// 의 "저장하는 순간 두 진실이 생긴다" 원칙과 같은 결). 파일: `<userData>/ui-prefs.json`.

import fs from 'node:fs'
import path from 'node:path'
import { isRecord, safeParse } from '../shared/json.js'
import { log } from './log.js'

/** 폴백 번호 배정 한 칸 (LIFE-366 C13) — `shared/types.ts` 의 `TabOrdinal` 과 같은 모양이다. */
export type TabOrdinal = { tabId: string; groupId: string; ordinal: number }

export type UiPrefs = {
  sidebarWidth: number | null
  sidebarCollapsed: boolean
  collapsedRepos: string[]
  collapsedGroups: string[]
  /** 에이전트 묶음 알약을 펼쳐 둔 worktree 경로 (LIFE-467) — `shared/types.ts` 의 같은 칸 주석. */
  expandedAgentGroups: string[]
  /**
   * 폴백 번호 배정표 (LIFE-366 C13, 수정 라운드 8).
   *
   * **왜 여기냐**: Orca 는 `tab.defaultTitle` 에 저장한다. corral 에서 같은 자리는 herdr
   * `tab.label` 인데 거기 쓰면 `userLabel` 이 그 숫자를 사용자 이름으로 읽어 **G5 가 되살아난다**.
   * 그래서 "저장하는 것은 화면 UI 상태뿐" 인 이 파일에 싣는다 — 폴백 번호는 herdr 가 모르는,
   * 화면이 혼자 쓰는 표시 상태다.
   */
  tabOrdinals: TabOrdinal[]
  /**
   * 영역(탭 그룹) 배치 — **worktree 별** (LIFE-373 F1-6 · §10-R3-h).
   *
   * 여기 있는 이유는 tabOrdinals 와 같다: herdr 가 모르는, 화면이 혼자 쓰는 상태다. 키를
   * `workspace_id` 가 아니라 **worktree 경로**로 잡는다 — workspace_id 는 herdr 서버 생애
   * 안에서만 유일해서(LIFE-344) 재기동하면 다른 worktree 의 배치를 뒤집어쓴다.
   *
   * 모양 검사는 렌더러(`group-tree.ts` readStoredLayouts)가 한다 — 트리 모양을 아는 쪽이
   * 거기고, 저장소는 **통째로 실어 나르기만** 한다(여기서 또 검사하면 두 진실이 생긴다).
   */
  groupLayouts: unknown[]
}

const VERSION = 1
const DEFAULT_PREFS: UiPrefs = { sidebarWidth: null, sidebarCollapsed: false, collapsedRepos: [], collapsedGroups: [], expandedAgentGroups: [], tabOrdinals: [], groupLayouts: [] }

/** 저장된 배정표를 **모양을 확인하며** 읽는다 — 손으로 고친 파일이 화면을 깨뜨리지 않게. */
function readTabOrdinals(value: unknown): TabOrdinal[] {
  if (!Array.isArray(value)) return []
  const rows: TabOrdinal[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const tabId = item['tabId']
    const groupId = item['groupId']
    const ordinal = item['ordinal']
    if (typeof tabId !== 'string' || tabId.length === 0) continue
    if (typeof groupId !== 'string') continue
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 1) continue
    rows.push({ tabId, groupId, ordinal })
  }
  return rows
}

export class UiPrefsStore {
  private readonly file: string
  private prefs: UiPrefs = { ...DEFAULT_PREFS }

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_UI_PREFS
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'ui-prefs.json')
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.prefs = { ...DEFAULT_PREFS }
        return
      }
      const parsed = safeParse(fs.readFileSync(this.file, 'utf8'))
      if (!isRecord(parsed)) throw new Error('ui-prefs 파일이 객체가 아니다')
      const width = parsed['sidebarWidth']
      const repos = parsed['collapsedRepos']
      const groups = parsed['collapsedGroups']
      const expanded = parsed['expandedAgentGroups']
      this.prefs = {
        sidebarWidth: typeof width === 'number' ? width : null,
        sidebarCollapsed: parsed['sidebarCollapsed'] === true,
        collapsedRepos: Array.isArray(repos) ? repos.filter((item): item is string => typeof item === 'string') : [],
        collapsedGroups: Array.isArray(groups) ? groups.filter((item): item is string => typeof item === 'string') : [],
        expandedAgentGroups: Array.isArray(expanded) ? expanded.filter((item): item is string => typeof item === 'string') : [],
        tabOrdinals: readTabOrdinals(parsed['tabOrdinals']),
        groupLayouts: Array.isArray(parsed['groupLayouts']) ? parsed['groupLayouts'] : [],
      }
      log('ui_prefs.load', { file: this.file })
    } catch (error) {
      this.prefs = { ...DEFAULT_PREFS }
      log('ui_prefs.load_failed', { file: this.file, error: String(error) })
    }
  }

  get(): UiPrefs {
    return {
      ...this.prefs,
      collapsedRepos: [...this.prefs.collapsedRepos],
      collapsedGroups: [...this.prefs.collapsedGroups],
      expandedAgentGroups: [...this.prefs.expandedAgentGroups],
      tabOrdinals: this.prefs.tabOrdinals.map((row) => ({ ...row })),
      groupLayouts: [...this.prefs.groupLayouts],
    }
  }

  /** 부분 갱신 — 준 필드만 덮는다(레지스트리처럼 즉시 원자적 쓰기, 디바운스 없음 — 쓰기 빈도가 낮다). */
  update(patch: Partial<UiPrefs>): void {
    this.prefs = { ...this.prefs, ...patch }
    const payload = JSON.stringify({ version: VERSION, ...this.prefs }, null, 2) + '\n'
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, this.file)
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      log('ui_prefs.save_failed', { file: this.file, error: String(error) })
    }
  }
}
