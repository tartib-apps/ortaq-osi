import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { getLocale, intlLocale } from '../i18n'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

export const ease = [0.22, 1, 0.36, 1] as const
export const spring = { type: 'spring', stiffness: 400, damping: 32 } as const

/** plural(5, ['дом', 'дома', 'домов']) → 'домов'. В казахском после числа слово не склоняется — форма одна */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  if (getLocale() === 'kk') return one
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

/** Время показываем в Asia/Almaty, хранится оно в UTC; язык названий месяцев — как у интерфейса */
export const formatDate = (iso: string) => new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', timeZone: 'Asia/Almaty' }).format(new Date(iso))
export const formatDateTime = (iso: string) => new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: getLocale() === 'kk' ? 'long' : 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' }).format(new Date(iso))

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')
