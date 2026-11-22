import { useQueryClient } from '@tanstack/react-query'
import type { Locale, MeResponse } from '@ortaq/shared'
import { api } from '../lib/api'
import { setLocale, useLocale } from '../lib/i18n'
import { Segmented } from './kit'

/**
 * Язык приложения. Выбор хранится на телефоне и в профиле: уведомления и веб-кабинет
 * говорят на том же языке
 */
export function LangSwitch({ signedIn = false }: { signedIn?: boolean }) {
  const locale = useLocale()
  const qc = useQueryClient()
  const pick = (v: Locale) => {
    setLocale(v)
    if (signedIn) {
      void api<MeResponse>('/me', { method: 'PATCH', body: { locale: v } }).then((me) => qc.setQueryData(['me'], me)).catch(() => undefined)
    }
  }
  return <Segmented label="Язык · Тіл" value={locale} onChange={pick} options={[{ v: 'kk', label: 'Қазақша' }, { v: 'ru', label: 'Русский' }]} />
}
