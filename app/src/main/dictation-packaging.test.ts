// LIFE-834 — 패키징 설정 문서 검사(C4 문구·C8ⓑⓔ 순서). 실제 dmg 확인은 최종 관문(C8 — PlistBuddy·codesign)이 한다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const builder = fs.readFileSync(path.join(app, 'electron-builder.yml'), 'utf8')
const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).scripts

describe('받아쓰기 패키징 설정', () => {
  it('NSMicrophoneUsageDescription 은 Electron 기본 문구가 아니라 이 기능을 설명한다(C4)', () => {
    const line = builder.split('\n').find((row) => row.trim().startsWith('NSMicrophoneUsageDescription:'))
    expect(line).toBeDefined()
    expect(line).not.toContain('This app needs access to the microphone')
    expect(line).toContain('받아쓰기')
    expect(line).toContain('기기 밖으로 나가지 않습니다')
  })
  it('도우미를 Resources/helper 로 싣는다', () => {
    expect(builder).toContain('- from: build/helper/corral-dictation\n    to: helper/corral-dictation')
  })
  it('package:mac 은 electron-builder 전에 도우미를 빌드·확인한다(실패하면 거기서 멈춘다) — C8ⓑ', () => {
    const steps = scripts['package:mac']?.split(' && ') ?? []
    const helper = steps.indexOf('node scripts/build-dictation.mjs')
    const builderStep = steps.findIndex((step) => step.startsWith('electron-builder'))
    expect(helper).toBeGreaterThan(-1)
    expect(helper).toBeLessThan(builderStep)
  })
  it('dev·build·typecheck·test 는 도우미 빌드(swiftc)에 기대지 않는다 — C8ⓔ', () => {
    for (const name of ['predev', 'dev', 'build', 'typecheck', 'test']) expect(scripts[name] ?? '').not.toContain('dictation')
  })
})
