import { useQueryClient } from '@tanstack/react-query'
import type { Locale, MeResponse } from '@ortaq/shared'
import { api } from '../api/client'
import { setLocale, useLocale } from '../i18n'
import { cn } from '../lib/cn'

const OPTIONS: { v: Locale; label: string; full: string }[] = [
  { v: 'kk', label: 'Қаз', full: 'Қазақша' },
  { v: 'ru', label: 'Рус', full: 'Русский' },
]

/**
 * Язык интерфейса. Выбор запоминается на устройстве и в профиле — чтобы приложение жильца
 * и уведомления говорили на том же языке
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
  return (
    <div role="radiogroup" aria-label="Язык · Тіл" className="flex rounded-full bg-surface p-1">
      {OPTIONS.map((o) => (
        <button
          key={o.v} type="button" role="radio" aria-checked={locale === o.v} aria-label={o.full} lang={o.v}
          onClick={() => pick(o.v)}
          className={cn('h-9 rounded-full px-3 text-[13px] font-semibold transition-colors', locale === o.v ? 'bg-brand-600 text-white' : 'text-ink-2 hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
