// A1 안내 — 첫 실행·해제 뒤 같은 화면. 해지·인증 실패로 왔으면 이유 한 줄(E4).
import { useRouter } from 'expo-router'
import { ActivityIndicator, Text, View } from 'react-native'
import type { ConnState, UnpairReason } from '../../src/core/connection'
import { connection, useConnection } from '../../src/runtime/connection'
import { Button } from '../../src/ui/Button'
import { Screen } from '../../src/ui/Screen'

const STEPS = [
  { n: '1', t: '맥에서 corral 열기', d: '설정 › Mobile 을 켜고 「QR 만들기」' },
  { n: '2', t: '이 폰으로 QR 찍기', d: '10분 동안 한 번만 쓰는 코드입니다' },
  { n: '3', t: '끝', d: '다음부터는 앱을 열면 바로 붙습니다' },
]

function reasonText(reason: UnpairReason | null): string | null {
  switch (reason) {
    case 'revoked':
      return '맥에서 이 폰의 연결을 해지했습니다. 다시 쓰려면 새 QR 을 찍어 주세요.'
    case 'unauthorized':
      return '맥이 이 폰을 알아보지 못합니다 — 해지되었거나 기기 목록에서 지워졌습니다. 다시 페어링해 주세요.'
    case 'user':
      return '이 폰의 페어링을 해제했습니다.'
    case null:
      return null
  }
}

/** 해제·해지 뒤 금고 삭제가 끝나기 전(삭제 중)·실패면 「해제했습니다」 대신 그 사실을 보인다(R1-A4). */
function VaultNotice({ conn }: { conn: ConnState }) {
  if (conn.kind === 'unpairing') {
    return (
      <View className="flex-row items-center gap-3 rounded-card border border-line bg-window p-4">
        <ActivityIndicator size="small" />
        <Text className="flex-1 text-[14px] leading-[21px] text-fg">이 폰에 저장된 기기 토큰을 지우는 중입니다</Text>
      </View>
    )
  }
  if (conn.kind === 'unpair_failed') {
    return (
      <View className="gap-3 rounded-card border border-error p-4">
        <Text className="text-[14px] font-semibold text-error">기기 토큰을 지우지 못했습니다</Text>
        <Text className="text-[14px] leading-[21px] text-fg-muted">
          연결은 닫았지만 폰의 보안 저장소에서 토큰을 지우지 못했습니다. 지우기 전에는 새로 페어링하지 않습니다 — 다시 시도해 주세요.
        </Text>
        <Button label="다시 지우기" onPress={() => void connection.retryUnpair()} />
      </View>
    )
  }
  return null
}

export default function PairIntro() {
  const router = useRouter()
  const { conn } = useConnection()
  const reason = reasonText(conn.kind === 'unpaired' || conn.kind === 'unpairing' || conn.kind === 'unpair_failed' ? conn.reason : null)
  const settled = conn.kind === 'unpaired'
  return (
    <Screen>
      <View className="flex-1 justify-between px-padx pb-6 pt-12">
        <View className="gap-8">
          <View className="gap-3">
            <View className="h-14 w-14 items-center justify-center rounded-[16px] border border-line bg-window">
              <Text className="text-[26px] font-semibold text-accent">c</Text>
            </View>
            <Text className="text-screen font-semibold text-fg">corral</Text>
            <Text className="text-[14px] leading-[22px] text-fg-muted">맥의 에이전트 세션을 폰에서 대화로 봅니다</Text>
          </View>
          <VaultNotice conn={conn} />
          {reason !== null && settled ? (
            <View className="rounded-card border border-line bg-window p-4">
              <Text className="text-[14px] leading-[21px] text-fg">{reason}</Text>
            </View>
          ) : null}
          <View className="gap-5">
            {STEPS.map((step) => (
              <View key={step.n} className="flex-row gap-4">
                <View className="h-7 w-7 items-center justify-center rounded-full bg-chip">
                  <Text className="text-[13px] font-semibold text-fg">{step.n}</Text>
                </View>
                <View className="flex-1 gap-1">
                  <Text className="text-body font-semibold text-fg">{step.t}</Text>
                  <Text className="text-preview text-fg-muted">{step.d}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
        <View className="gap-4">
          <Text className="text-small leading-[19px] text-fg-dim">계정·클라우드를 거치지 않습니다. 폰과 맥이 같은 Tailscale 망에 있어야 합니다.</Text>
          {settled ? (
            <Button
              label="QR 찍기"
              onPress={() => {
                connection.acknowledgeUnpair()
                router.push('/pair/scan')
              }}
            />
          ) : null}
        </View>
      </View>
    </Screen>
  )
}
