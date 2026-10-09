import { Pressable, Text } from 'react-native'

type Props = { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'dangerOutline'; disabled?: boolean }

/** 주 버튼 52(`--fg` 바탕) · 보조 48 글자 버튼 · 해제 52(`--st-error` 바탕) · 해제 진입(빨간 테두리) — design-handoff §2. */
export function Button({ label, onPress, kind = 'primary', disabled = false }: Props) {
  switch (kind) {
    case 'primary':
      return (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} className="h-[52px] items-center justify-center rounded-pill bg-fg active:opacity-80">
          <Text className="text-body font-semibold text-surface">{label}</Text>
        </Pressable>
      )
    case 'secondary':
      return (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} className="h-12 items-center justify-center active:opacity-60">
          <Text className="text-body text-fg-muted">{label}</Text>
        </Pressable>
      )
    case 'danger':
      return (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} className="h-[52px] items-center justify-center rounded-pill bg-error active:opacity-80">
          <Text className="text-body font-semibold text-surface">{label}</Text>
        </Pressable>
      )
    case 'dangerOutline':
      return (
        <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} className="h-[52px] items-center justify-center rounded-pill border border-error active:opacity-70">
          <Text className="text-body font-semibold text-error">{label}</Text>
        </Pressable>
      )
  }
}
