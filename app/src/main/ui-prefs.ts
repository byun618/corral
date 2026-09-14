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

export type UiPrefs = {
  sidebarWidth: number | null
  collapsedRepos: string[]
  collapsedGroups: string[]
}

const VERSION = 1
const DEFAULT_PREFS: UiPrefs = { sidebarWidth: null, collapsedRepos: [], collapsedGroups: [] }

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
      this.prefs = {
        sidebarWidth: typeof width === 'number' ? width : null,
        collapsedRepos: Array.isArray(repos) ? repos.filter((item): item is string => typeof item === 'string') : [],
        collapsedGroups: Array.isArray(groups) ? groups.filter((item): item is string => typeof item === 'string') : [],
      }
      log('ui_prefs.load', { file: this.file })
    } catch (error) {
      this.prefs = { ...DEFAULT_PREFS }
      log('ui_prefs.load_failed', { file: this.file, error: String(error) })
    }
  }

  get(): UiPrefs {
    return { ...this.prefs, collapsedRepos: [...this.prefs.collapsedRepos], collapsedGroups: [...this.prefs.collapsedGroups] }
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
