// ⌘V 이미지 붙여넣기의 main 쪽 (LIFE-497 · D41·D44) — 클립보드 이미지 → 임시 PNG, 그리고 그 PNG 의 정리.
//
// 렌더러는 sandbox 라 클립보드 이미지도 파일도 못 만진다 (00-analysis §4). 여기서 쓰고 **경로만** 돌려준다.
// Electron 44 에는 Orca 의 `clipboard.readImage()` 가 없다(F11) — W3C 모양 `clipboard.read()` 의
// `image/*` 항목을 읽는다. 클립보드·파일 시스템은 주입받는다(단위 테스트가 실제 클립보드를 안 건드리게).

import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ClipboardImageSaveResult } from '../shared/types.js'

/** corral 이 만든 파일만 이 꼴이다 — 정리는 **이 이름 + 이 폴더**로만 한정한다 (K4ⓒ). */
const PASTE_FILE_RE = /^corral-paste-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/

/** 셸 메타문자·공백이 없는 이름 — raw 경로로 붙여도 안전하다 (220 `orca-paste-<ts>-<uuid>.png` 대응). */
export function pasteFileName(input: { now: number; uuid: string }): string {
  return `corral-paste-${input.now}-${input.uuid}.png`
}

export function isPasteFileName(name: string): boolean {
  return PASTE_FILE_RE.test(name)
}

/** 클립보드에서 이미지 한 장을 PNG 바이트로. 이미지가 없으면 null. */
export type ReadClipboardPng = () => Promise<Buffer | null>

/**
 * Electron 클립보드 → PNG. `image/png` 는 그대로, 다른 `image/*` 는 nativeImage 로 PNG 로 바꾼다.
 * 첫 번째 이미지 항목만 본다(Orca `readImage()` 도 한 장이다).
 */
export function electronClipboardPng(deps: {
  read: () => Promise<Array<{ types: readonly string[]; getType: (type: string) => Promise<unknown> }>>
  toPng: (bytes: Buffer) => Buffer
}): ReadClipboardPng {
  return async () => {
    for (const item of await deps.read()) {
      const type = item.types.find((one) => one.startsWith('image/'))
      if (type === undefined) continue
      const blob = await item.getType(type)
      if (!(blob instanceof Blob)) continue
      const bytes = Buffer.from(await blob.arrayBuffer())
      const png = type === 'image/png' ? bytes : deps.toPng(bytes)
      return png.byteLength > 0 ? png : null
    }
    return null
  }
}

/**
 * 루트(`corral-paste`) 자체를 믿어도 되는가 (R1-02) — 심링크가 아닌 진짜 폴더이고 현재 사용자 소유여야 한다.
 * 공유 temp 에 남이 심어 둔 심링크·폴더를 따라가 거기에 쓰거나 거기서 지우지 않게 저장·정리 **둘 다** 먼저 본다.
 * 믿을 수 없으면 사유 문자열, 믿으면 null. `uid` 는 테스트 주입용 — 기본은 현재 프로세스.
 */
export async function untrustedPasteRoot(input: { dir: string; uid?: number }): Promise<string | null> {
  let stat: Stats
  try {
    stat = await fs.lstat(input.dir)
  } catch (error) {
    return `루트 lstat 실패: ${error instanceof Error ? error.message : String(error)}`
  }
  if (stat.isSymbolicLink()) return '루트가 심링크'
  if (!stat.isDirectory()) return '루트가 폴더가 아님'
  const uid = input.uid ?? process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) return `루트 소유자 불일치(${stat.uid})`
  return null
}

/**
 * 클립보드 이미지를 `dir` 에 PNG 로 쓰고 절대경로를 돌려준다. 실패는 **값으로** 돌려준다 —
 * 호출자가 로그에 남기고, 렌더러는 아무 바이트도 보내지 않는다 (K1ⓓ).
 */
export async function saveClipboardImage(input: {
  readPng: ReadClipboardPng
  dir: string
  now?: number
  uuid?: string
  uid?: number
}): Promise<ClipboardImageSaveResult> {
  try {
    const png = await input.readPng()
    if (png === null) return { status: 'empty' }
    await fs.mkdir(input.dir, { recursive: true, mode: 0o700 })
    const untrusted = await untrustedPasteRoot({ dir: input.dir, uid: input.uid })
    if (untrusted !== null) return { status: 'failed', error: untrusted }
    const file = path.join(input.dir, pasteFileName({ now: input.now ?? Date.now(), uuid: input.uuid ?? randomUUID() }))
    await fs.writeFile(file, png, { mode: 0o600 })
    return { status: 'saved', path: file }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 붙여넣기 PNG 정리 (D44) — `dir` 바로 아래, corral 이름 꼴, 일반 파일, `maxAgeMs` 보다 오래된 것만 지운다.
 *
 * 앱 종료 때 일괄 삭제하지 않는다: herdr 는 앱이 꺼져도 pane 을 살려 두고, 거기 아직 안 보낸 첨부가
 * 이 경로를 가리킨다. Codex 는 첨부 파일을 **전송(직렬화) 때** 읽는다(0.159.2 `clipboard_paste.rs`
 * "The file will be read and base64-encoded during serialization") — 지우는 시점이 전송보다 앞서면 첨부가 깨진다.
 * 그래서 나이로만 지운다(Orca #24009 드롭 사본 TTL 7일과 같은 값). 하위 폴더·심링크는 따라가지 않는다.
 * 루트 자체가 심링크·남의 폴더면 아예 건너뛰고 사유를 돌려준다(호출자가 로그) — R1-02.
 */
export async function sweepPasteFiles(input: {
  dir: string
  now: number
  maxAgeMs: number
  uid?: number
}): Promise<{ removed: string[]; kept: number; skipped: string | null }> {
  const exists = await fs.lstat(input.dir).then(() => true, () => false)
  if (!exists) return { removed: [], kept: 0, skipped: null }
  const untrusted = await untrustedPasteRoot({ dir: input.dir, uid: input.uid })
  if (untrusted !== null) return { removed: [], kept: 0, skipped: untrusted }
  let names: string[]
  try {
    names = await fs.readdir(input.dir)
  } catch (error) {
    return { removed: [], kept: 0, skipped: `readdir 실패: ${error instanceof Error ? error.message : String(error)}` }
  }
  const removed: string[] = []
  let kept = 0
  for (const name of names) {
    if (!isPasteFileName(name)) continue
    const file = path.join(input.dir, name)
    const stat = await fs.lstat(file).catch(() => null)
    if (stat === null || !stat.isFile()) continue
    if (input.now - stat.mtimeMs < input.maxAgeMs) {
      kept += 1
      continue
    }
    await fs.rm(file).then(() => removed.push(file), () => undefined)
  }
  return { removed, kept, skipped: null }
}

export const PASTE_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
