// 사용자 설정 저장소 (LIFE-512 S11·K1) — `<userData>/settings.json`. 경로 오버라이드는 `CORRAL_SETTINGS`(ui-prefs 의 `CORRAL_UI_PREFS` 와 같은 방식).
//
// ui-prefs.ts 와 같은 결: 칸별 검증으로 읽고(손상된 칸만 기본값, 나머지 생존), tmp→rename 원자적 쓰기. 다른 점 둘:
//   ① **설정을 바꾸기 전에는 파일을 만들지 않는다** — 없으면 기본값으로 산다. 네이티브 관문 원복이 「파일 없음」 으로 돌아갈 수
//      있게 하고(K9ⓒ), 기본값을 파일에 굳혀 두면 나중에 기본값이 바뀌어도 옛 값이 남는 일을 막는다.
//   ② 디바운스 없이 **매 갱신 즉시 쓴다** — 쓰는 쪽(설정 화면)이 확정 때만 갱신한다(숫자 입력은 Enter/blur, ± 는 한 번에 한 칸).
//      즉시 쓰기라 종료 직전 마지막 변경도 디스크에 있다 — 종료 시 비우기 경로가 필요 없다(K1ⓓ).
// 칸 이름·기본값·읽기 규칙은 `shared/terminal-settings.ts` 한 곳이다.

import fs from 'node:fs'
import path from 'node:path'
import { safeParse } from '../shared/json.js'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, readSettings, sanitizeSettingsPatch, type Settings } from '../shared/terminal-settings.js'
import { log } from './log.js'

export class SettingsStore {
  readonly file: string
  private settings: Settings = { ...DEFAULT_SETTINGS }

  constructor(userDataDir: string) {
    const fromEnv = process.env.CORRAL_SETTINGS
    this.file = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : path.join(userDataDir, 'settings.json')
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.settings = { ...DEFAULT_SETTINGS }
        return
      }
      this.settings = readSettings(safeParse(fs.readFileSync(this.file, 'utf8')))
      log('settings.load', { file: this.file })
    } catch (error) {
      this.settings = { ...DEFAULT_SETTINGS }
      log('settings.load_failed', { file: this.file, error: String(error) })
    }
  }

  /** 복사본 — 받은 쪽이 고쳐도 저장소가 바뀌지 않는다(칸이 전부 원시값이라 얕은 복사로 충분하다). */
  get(): Settings {
    return { ...this.settings }
  }

  /**
   * 부분 갱신 — 검증을 통과한 칸만 덮고 즉시 원자적으로 쓴다. 바뀐 칸이 없으면 쓰지 않는다(파일도 만들지 않는다).
   * 돌려주는 값: 갱신 뒤 전체 설정 + 바뀌었는지(main 이 푸시 여부를 정한다).
   */
  update(patch: unknown): { settings: Settings; changed: boolean } {
    const { accepted, rejected } = sanitizeSettingsPatch(patch)
    if (rejected.length > 0) log('settings.patch_rejected', { keys: rejected })
    const next: Settings = { ...this.settings, ...accepted }
    const changed = Object.keys(next).some((key) => Reflect.get(next, key) !== Reflect.get(this.settings, key))
    if (!changed) return { settings: this.get(), changed: false }
    this.settings = next
    const payload = JSON.stringify({ version: SETTINGS_VERSION, ...this.settings }, null, 2) + '\n'
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, this.file)
    } catch (error) {
      fs.rmSync(tmp, { force: true })
      log('settings.save_failed', { file: this.file, error: String(error) })
    }
    return { settings: this.get(), changed: true }
  }
}
