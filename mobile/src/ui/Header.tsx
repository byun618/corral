import { Pressable, Text, View } from 'react-native'

/** 뒤로 44 + 제목 — 설정·기록·QR 화면 머리. */
export function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View className="h-14 flex-row items-center gap-1 px-2">
      <Pressable accessibilityRole="button" accessibilityLabel="뒤로" onPress={onBack} className="h-11 w-11 items-center justify-center active:opacity-60">
        <Text className="text-[22px] text-fg">←</Text>
      </Pressable>
      <Text className="text-title font-semibold text-fg">{title}</Text>
    </View>
  )
}
