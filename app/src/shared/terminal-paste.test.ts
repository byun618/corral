// LIFE-497 — 붙여넣기·드롭 순수 계산. Orca v1.4.220 테스트에서 corral 에 해당하는 POSIX 케이스를 옮겼다
// (`terminal-drop-image-path.test.ts`·`terminal-drop-path-writer.test.ts`·`pane-helpers.test.ts`·
// `terminal-bracketed-paste.test.ts`·`terminal-clipboard-paste.test.ts`). Windows·SSH 케이스는 D45 의도적으로 뺐다.
import { describe, expect, it } from 'vitest'
import {
  canPasteImageDropPathRaw,
  clipboardImagePayload,
  createOrderedSender,
  dropPathPayloads,
  FILE_DROP_MAX_PATHS,
  formatImageDropPasteText,
  isImageDropPath,
  shellEscapePath,
  shouldPasteClipboardImage,
  wrapBracketedPaste,
} from './terminal-paste.js'

const wrap = wrapBracketedPaste

describe('wrapBracketedPaste', () => {
  it('강제 bracketed paste 로 싼다', () => {
    expect(wrap('/tmp/corral-paste-1-abc.png')).toBe('\x1b[200~/tmp/corral-paste-1-abc.png\x1b[201~')
  })

  it('안쪽 ESC 를 U+241B 로 무력화한다 (끼어든 201~ 가 틀을 닫지 않게)', () => {
    const wrapped = wrap('part\x1b[201~tail')
    expect(wrapped).toBe('\x1b[200~part\u241b[201~tail\x1b[201~')
    expect(wrapped.slice(6, -6)).not.toContain('\x1b')
  })

  it('줄바꿈을 xterm 네이티브 붙여넣기처럼 CR 로 맞춘다', () => {
    expect(wrap('one\r\ntwo\nthree')).toBe('\x1b[200~one\rtwo\rthree\x1b[201~')
  })
})

describe('isImageDropPath (220)', () => {
  it('detects common image extensions case-insensitively', () => {
    for (const path of ['/repo/shot.png', '/repo/shot.PNG', '/repo/a.jpg', '/repo/a.jpeg', '/repo/a.gif', '/repo/icon.svg', '/repo/a.webp', '/repo/a.bmp', '/repo/a.ico']) {
      expect(isImageDropPath(path)).toBe(true)
    }
  })

  it('rejects non-image and extension-less paths', () => {
    for (const path of ['/repo/index.ts', '/repo/notes.md', '/repo/archive.tar.gz', '/repo/Makefile', '/repo/.gitignore']) {
      expect(isImageDropPath(path)).toBe(false)
    }
  })

  it('does not classify directory components with dots as images', () => {
    expect(isImageDropPath('/home/jane.png/photo')).toBe(false)
    expect(isImageDropPath('/home/jane.doe/screenshot')).toBe(false)
  })
})

describe('canPasteImageDropPathRaw (220)', () => {
  it('pastes plain names raw', () => {
    expect(canPasteImageDropPathRaw('/tmp/orca-paste-1-abc.png')).toBe(true)
  })

  it('treats an ASCII space as unsafe but leaves U+202F alone', () => {
    expect(canPasteImageDropPathRaw('/t/Screenshot 2026-09-28 at 4.03.11\u202fPM.png')).toBe(false)
    expect(canPasteImageDropPathRaw('/t/4.03.11\u202fPM.png')).toBe(true)
  })
})

// 220 테스트의 수신 쪽 재현 — 에이전트가 붙여넣은 글자에서 경로를 되찾는 방식.
// Claude Code: 바깥 따옴표 한 쌍 제거 → `\X` → `X`.
function claudeCodeRecoverPath(pasted: string): string {
  const unquoted = /^(['"]).*\1$/s.test(pasted) ? pasted.slice(1, -1) : pasted
  return unquoted.replace(/\\(.)/gs, '$1')
}

// Codex `normalize_pasted_path`(POSIX): shlex 로 쪼개 정확히 1조각이어야 경로.
function codexRecoverPath(pasted: string): string | null {
  const tokens: string[] = []
  let current: string | null = null
  let quote: "'" | '"' | null = null
  for (let i = 0; i < pasted.length; i += 1) {
    const char = pasted.charAt(i)
    const next = pasted.charAt(i + 1)
    if (quote === "'") {
      if (char === "'") quote = null
      else current = (current ?? '') + char
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && /["\\$`]/.test(next)) {
        current = (current ?? '') + next
        i += 1
      } else current = (current ?? '') + char
    } else if (char === ' ' || char === '\t' || char === '\n') {
      if (current !== null) {
        tokens.push(current)
        current = null
      }
    } else if (char === '\\') {
      current = (current ?? '') + next
      i += 1
    } else if (char === "'" || char === '"') {
      current ??= ''
      quote = char
    } else current = (current ?? '') + char
  }
  if (quote !== null) return null
  if (current !== null) tokens.push(current)
  return tokens.length === 1 ? (tokens[0] ?? null) : null
}

describe('formatImageDropPasteText (220)', () => {
  it('backslash-escapes unsafe POSIX characters', () => {
    expect(formatImageDropPasteText('/t/shot.png')).toBe('/t/shot.png')
    expect(formatImageDropPasteText("/t/it's (1).png")).toBe("/t/it\\'s\\ \\(1\\).png")
  })

  it('refuses paths a paste frame would alter', () => {
    expect(formatImageDropPasteText('/t/a\nb.png')).toBeNull()
    expect(formatImageDropPasteText('/t/a\u001bb.png')).toBeNull()
  })
})

describe('agent recovery of pasted image paths (220)', () => {
  const screenshot = '/t/Screenshot 2026-09-28 at 4.03.11\u202fPM.png'

  it.each([screenshot, "/t/it's.png", '/t/download (1).png', '/t/a.png; touch /tmp/pwned #.png', '/t/"q" $HOME `x` \\ [1] {2} *?!&|<>~.png'])(
    'recovers %j in Claude Code and Codex',
    (path) => {
      const pasted = formatImageDropPasteText(path) ?? ''
      expect(claudeCodeRecoverPath(pasted)).toBe(path)
      expect(codexRecoverPath(pasted)).toBe(path)
    },
  )

  it("shows why the quoted `'\\''` form was not used: Claude Code corrupts it", () => {
    expect(claudeCodeRecoverPath("'/t/it'\\''s.png'")).toBe("/t/it'''s.png")
  })

  it('shows why a raw spaced path is not enough for Codex', () => {
    expect(codexRecoverPath(screenshot)).toBeNull()
  })
})

describe('shellEscapePath (220 posix)', () => {
  it('keeps safe POSIX paths unquoted', () => {
    expect(shellEscapePath('/tmp/file.txt')).toBe('/tmp/file.txt')
  })

  it('single-quotes POSIX paths with shell-special characters', () => {
    expect(shellEscapePath("/tmp/it's here.txt")).toBe("'/tmp/it'\\''s here.txt'")
  })
})

describe('dropPathPayloads (220 terminal-drop-path-writer)', () => {
  it('writes non-image paths shell-escaped with a trailing space', () => {
    expect(dropPathPayloads(['/repo/a.ts'])).toEqual(['/repo/a.ts '])
  })

  it('writes dropped image paths as a bracketed paste of the raw path', () => {
    expect(dropPathPayloads(['/tmp/orca-paste-1-abc.png'])).toEqual([wrap('/tmp/orca-paste-1-abc.png')])
  })

  it('pastes a spaced macOS screenshot name as a backslash-escaped path', () => {
    expect(dropPathPayloads(['/tmp/drag/Screenshot 2026-09-28 at 4.03.11\u202fPM.png'])).toEqual([
      wrap('/tmp/drag/Screenshot\\ 2026-09-28\\ at\\ 4.03.11\u202fPM.png'),
    ])
  })

  it('keeps separating spaces around escaped spaced image pastes', () => {
    expect(dropPathPayloads(['/repo/Screenshot 1.png', '/repo/Screenshot 2.png', '/repo/a.ts'])).toEqual([
      `${wrap('/repo/Screenshot\\ 1.png')} `,
      `${wrap('/repo/Screenshot\\ 2.png')} `,
      '/repo/a.ts ',
    ])
  })

  it('keeps shell-escaped input for mixed image and non-image drops', () => {
    expect(dropPathPayloads(['/repo/a.ts', '/repo/shot.png'])).toEqual(['/repo/a.ts ', wrap('/repo/shot.png')])
  })

  it('separates an image paste from a following non-image path', () => {
    expect(dropPathPayloads(['/repo/shot.png', '/repo/a.ts'])).toEqual([`${wrap('/repo/shot.png')} `, '/repo/a.ts '])
  })

  it('does not insert a separator between back-to-back image pastes', () => {
    expect(dropPathPayloads(['/repo/one.png', '/repo/two.png'])).toEqual([wrap('/repo/one.png'), wrap('/repo/two.png')])
  })

  it('pastes a shell-escaped image path with POSIX shell metacharacters', () => {
    expect(dropPathPayloads(['/repo/a.png; touch /tmp/pwned #.png'])).toEqual([wrap('/repo/a.png\\;\\ touch\\ /tmp/pwned\\ \\#.png')])
  })

  it('pastes an image filename with parentheses as a backslash-escaped path', () => {
    expect(dropPathPayloads(['/repo/.orca/drops/download (1).png'])).toEqual([wrap('/repo/.orca/drops/download\\ \\(1\\).png')])
  })

  it('keeps shell-escaped image pastes separate shell arguments from following images', () => {
    expect(dropPathPayloads(['/repo/download (1).png', "/repo/it's.png", '/repo/shot.png'])).toEqual([
      `${wrap('/repo/download\\ \\(1\\).png')} `,
      `${wrap("/repo/it\\'s.png")} `,
      wrap('/repo/shot.png'),
    ])
  })

  it('separates a shell-escaped image paste from a following non-image path', () => {
    expect(dropPathPayloads(['/repo/download (1).png', '/repo/a.ts'])).toEqual([`${wrap('/repo/download\\ \\(1\\).png')} `, '/repo/a.ts '])
  })

  it('separates an image paste from a following image path that must be shell escaped', () => {
    expect(dropPathPayloads(['/repo/shot.png', '/repo/a.png; touch /tmp/pwned #.png'])).toEqual([
      `${wrap('/repo/shot.png')} `,
      wrap('/repo/a.png\\;\\ touch\\ /tmp/pwned\\ \\#.png'),
    ])
  })

  it('types image paths with control bytes instead of pasting them', () => {
    expect(dropPathPayloads(['/repo/a\nb.png'])).toEqual(["'/repo/a\nb.png' "])
  })

  it('drop 상한은 220 과 같은 256 이다', () => {
    expect(FILE_DROP_MAX_PATHS).toBe(256)
  })
})

describe('⌘V 갈림 (220 terminal-clipboard-paste)', () => {
  it('텍스트가 있으면 텍스트 — 이미지를 찾지 않는다 (preserves the text fast path)', () => {
    expect(shouldPasteClipboardImage('hello')).toBe(false)
    expect(shouldPasteClipboardImage(' ')).toBe(false)
  })

  it('텍스트가 없을 때만 이미지를 찾는다 (image-only clipboard)', () => {
    expect(shouldPasteClipboardImage('')).toBe(true)
  })

  it('forces bracketed paste for generated image-only clipboard paths', () => {
    expect(clipboardImagePayload({ status: 'saved', path: '/var/folders/x/T/corral-paste/corral-paste-1-u.png' })).toBe(
      '\x1b[200~/var/folders/x/T/corral-paste/corral-paste-1-u.png\x1b[201~',
    )
  })

  it('빈 클립보드·실패면 아무것도 보내지 않는다 (reports image extraction failures without pasting)', () => {
    expect(clipboardImagePayload({ status: 'empty' })).toBeNull()
    expect(clipboardImagePayload({ status: 'failed', error: 'EACCES' })).toBeNull()
  })
})

// R1-03 — 생성 입력은 완료 순서가 아니라 접수 순서로 나간다.
describe('createOrderedSender', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    return { promise, resolve, reject }
  }

  it('두 번 연속 ⌘V 가 역순으로 끝나도 접수 순서대로 보낸다', async () => {
    const sent: string[] = []
    const enqueue = createOrderedSender<string>((item) => sent.push(item))
    const first = deferred<readonly string[]>()
    const second = deferred<readonly string[]>()
    enqueue(first.promise)
    const done = enqueue(second.promise)
    second.resolve(['B'])
    await Promise.resolve()
    expect(sent).toEqual([])
    first.resolve(['A'])
    await done
    expect(sent).toEqual(['A', 'B'])
  })

  it('⌘V 처리 중 들어온 드롭은 그 ⌘V 뒤에 나간다', async () => {
    const sent: string[] = []
    const enqueue = createOrderedSender<string>((item) => sent.push(item))
    const paste = deferred<readonly string[]>()
    enqueue(paste.promise)
    const done = enqueue(['drop-1', 'drop-2'])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(sent).toEqual([])
    paste.resolve(['paste'])
    await done
    expect(sent).toEqual(['paste', 'drop-1', 'drop-2'])
  })

  it('빈 결과·실패도 자리를 지키고 뒤를 막지 않는다', async () => {
    const sent: string[] = []
    const enqueue = createOrderedSender<string>((item) => sent.push(item))
    const empty = deferred<readonly string[]>()
    const failed = deferred<readonly string[]>()
    const last = deferred<readonly string[]>()
    enqueue(empty.promise)
    enqueue(failed.promise)
    const done = enqueue(last.promise)
    last.resolve(['C'])
    failed.reject(new Error('clipboard busy'))
    empty.resolve([])
    await done
    expect(sent).toEqual(['C'])
  })

  it('보내기 예외가 뒤 자리를 막지 않는다', async () => {
    const sent: string[] = []
    const enqueue = createOrderedSender<string>((item) => {
      if (item === 'boom') throw new Error('x')
      sent.push(item)
    })
    enqueue(['boom'])
    await enqueue(['ok'])
    expect(sent).toEqual(['ok'])
  })
})
