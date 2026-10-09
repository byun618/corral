// PairingError (A5–A9 공통 틀, design-handoff §2) — 빨간 점 10 · 제목 21/600 · 설명 14/1.6 · (확인 목록 / 버전 mono) · 주 버튼 · 보조 버튼.
import { Text, View } from 'react-native'
import { Button } from './Button'
import { mono } from './tokens'

export type PairingErrorProps = {
  title: string
  body: string
  list?: string[]
  monoText?: string
  primary: { label: string; onPress: () => void }
  secondary?: { label: string; onPress: () => void }
}

export function PairingError({ title, body, list, monoText, primary, secondary }: PairingErrorProps) {
  return (
    <View className="flex-1 justify-between px-padx pb-6 pt-10">
      <View className="gap-4">
        <View className="h-2.5 w-2.5 rounded-full bg-error" />
        <Text className="text-screen font-semibold text-fg">{title}</Text>
        <Text className="text-[14px] leading-[22px] text-fg-muted">{body}</Text>
        {list !== undefined ? (
          <View className="gap-2 rounded-card border border-line bg-window p-4">
            {list.map((item) => (
              <View key={item} className="flex-row gap-2">
                <Text className="text-[14px] text-fg-dim">·</Text>
                <Text className="flex-1 text-[14px] leading-[21px] text-fg">{item}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {monoText !== undefined ? (
          <View className="rounded-card border border-line bg-window p-4">
            <Text className="text-[13px] leading-[20px] text-fg" style={{ fontFamily: mono }}>
              {monoText}
            </Text>
          </View>
        ) : null}
      </View>
      <View className="gap-1">
        <Button label={primary.label} onPress={primary.onPress} />
        {secondary !== undefined ? <Button kind="secondary" label={secondary.label} onPress={secondary.onPress} /> : null}
      </View>
    </View>
  )
}
