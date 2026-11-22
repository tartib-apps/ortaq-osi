import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope'
import { Onest_400Regular, Onest_500Medium, Onest_600SemiBold } from '@expo-google-fonts/onest'
import { useFonts } from 'expo-font'
import { ApiError } from '../lib/api'
import { SessionProvider } from '../lib/session'
import { loadLocale, useLocale } from '../lib/i18n'
import { color } from '../theme'

void SplashScreen.preventAutoHideAsync()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx — ответ, а не сбой: повторять бессмысленно
      retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
    },
  },
})

export default function RootLayout() {
  const [loaded, failed] = useFonts({ Manrope_700Bold, Manrope_800ExtraBold, Onest_400Regular, Onest_500Medium, Onest_600SemiBold })
  const [localeReady, setLocaleReady] = useState(false)
  const locale = useLocale()

  useEffect(() => {
    void loadLocale().finally(() => setLocaleReady(true))
  }, [])

  useEffect(() => {
    // Шрифты не загрузились — показываем системные, но не держим заставку вечно
    if ((loaded || failed) && localeReady) void SplashScreen.hideAsync()
  }, [loaded, failed, localeReady])

  if ((!loaded && !failed) || !localeReady) return null
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style="dark" />
          {/* Смена языка перемонтирует экраны: строки переводятся при отрисовке */}
          <Stack key={locale} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}
