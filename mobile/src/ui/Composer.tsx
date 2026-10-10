// 입력창 (LIFE-582 — 579 Composer 8행 · C14 붙여넣기 칩 · C17 재연결 잠금) — design-handoff §2 Composer. 상태 규칙은 `core/input.ts composerMode`.
// 엔터 = 줄바꿈(보내기는 버튼만). 1,000자 넘게 한 번에 들어온 글은 칩으로 접는다(본문은 그대로 보낸다). 상한을 넘으면 보내기를 잠그고 넘친 바이트를 보인다.
// 잠겨도(재연결 등) 쓴 글은 남긴다 — 자동으로 보내지 않는다.
import { useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { PASTE_CHIP_CHARS, sendGate, type ComposerMode } from '../core/input'
import { color, font } from './tokens'

export type ComposerProps = {
  mode: ComposerMode
  /** 보냈으면 true — 그때만 글을 비운다(못 보냈으면 그대로). */
  onSubmit: (text: string) => boolean
}

export function Composer({ mode, onSubmit }: ComposerProps) {
  const [text, setText] = useState('')
  const [pasted, setPasted] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  if (mode.kind === 'closed') return null
  const body = pasted === null ? text : text.trim().length === 0 ? pasted : `${pasted}\n${text}`
  const gate = sendGate({ mode, body })
  const locked = mode.kind === 'locked'
  const note = gate.over > 0 ? `${gate.over.toLocaleString()}바이트 넘었습니다 — 65,536바이트까지 보낼 수 있습니다` : mode.note
  const submit = (): void => {
    if (!gate.enabled) return
    if (!onSubmit(body)) return
    setText('')
    setPasted(null)
  }
  const change = (next: string): void => {
    // 한 번에 1,000자 넘게 늘었다 = 붙여넣기(C14) — 칩으로 접는다. 칩이 이미 있으면 입력창 글로 둔다.
    if (pasted === null && next.length - text.length > PASTE_CHIP_CHARS) {
      setPasted(next)
      setText('')
      return
    }
    setText(next)
  }
  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6, borderTopWidth: 1, borderTopColor: color.line, backgroundColor: color.surface }}>
      {note !== null ? <Text style={{ fontSize: 12.5, color: gate.over > 0 ? color.error : color.fgMuted, fontFamily: font.regular, paddingHorizontal: 6 }}>{note}</Text> : null}
      {pasted !== null ? (
        <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, borderWidth: 1, borderColor: color.line, backgroundColor: color.window, paddingHorizontal: 12 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, color: color.fg, fontFamily: font.medium }}>{`붙여넣은 글 · ${pasted.length.toLocaleString()}자`}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="붙여넣은 글 빼기" onPress={() => setPasted(null)} className="active:opacity-60" style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 16, color: color.fgMuted }}>×</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <TextInput
          value={text}
          onChangeText={change}
          multiline
          editable={!locked || mode.keep}
          placeholder={mode.placeholder}
          placeholderTextColor={color.fgDim}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            minHeight: 46,
            // 6줄(16 × 1.4 × 6 ≈ 135) 뒤로는 안에서 스크롤.
            maxHeight: 46 + 22.4 * 5,
            borderRadius: 23,
            borderWidth: 1,
            borderColor: focused ? color.lineStrong : color.line,
            backgroundColor: color.window,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 12,
            fontSize: 16,
            lineHeight: 22.4,
            color: color.fg,
            fontFamily: font.regular,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="보내기"
          accessibilityState={{ disabled: !gate.enabled }}
          disabled={!gate.enabled}
          onPress={submit}
          className="active:opacity-80"
          style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: gate.enabled ? color.fg : color.chip }}
        >
          <Text style={{ fontSize: 18, color: gate.enabled ? color.surface : color.fgFaint, fontFamily: font.semibold }}>↑</Text>
        </Pressable>
      </View>
    </View>
  )
}
