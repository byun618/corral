// 버전 불일치 안내(B8 · 579 Q10) — 목록·대화 화면이 같이 쓴다. 이 상태에서는 마지막 목록·채널 정보를 보이지 않는다(R1-A6).
import { Text, View } from 'react-native'
import { mono } from './tokens'

export function VersionMismatch({ appVersion, serverVersion, supported }: { appVersion: string; serverVersion: string | null; supported: readonly number[] }) {
  return (
    <View className="flex-1 gap-4 px-padx pt-10">
      <View className="h-2.5 w-2.5 rounded-full bg-error" />
      <Text className="text-screen font-semibold text-fg">버전이 맞지 않습니다</Text>
      <Text className="text-[14px] leading-[22px] text-fg-muted">맥의 corral 과 이 앱의 연결 방식(프로토콜)이 다릅니다. 오래된 쪽을 업데이트한 뒤 「다시 연결」 을 눌러 주세요. 마지막 목록은 버전이 다르면 잘못 읽힐 수 있어 보여 주지 않습니다.</Text>
      <View className="rounded-card border border-line bg-window p-4">
        <Text className="text-[13px] leading-[20px] text-fg" style={{ fontFamily: mono }}>
          {`이 앱 ${appVersion} · 프로토콜 1\n맥 corral ${serverVersion ?? ''} · 프로토콜 ${supported.length > 0 ? supported.join(', ') : '알 수 없음'}`}
        </Text>
      </View>
    </View>
  )
}
