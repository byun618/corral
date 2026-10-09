import { Redirect } from 'expo-router'
import { View } from 'react-native'
import { useConnection } from '../src/runtime/connection'

export default function Index() {
  const { conn } = useConnection()
  if (conn.kind === 'loading') return <View className="flex-1 bg-surface" />
  if (conn.kind === 'unpaired') return <Redirect href="/pair" />
  return <Redirect href="/home" />
}
