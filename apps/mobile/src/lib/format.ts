import { getLocale, intlLocale, t } from './i18n'
/** «1 жилец», «2 жильца», «5 жильцов» */
export function plural(n: number, forms: [string, string, string]): string {
  // В казахском после числа слово не склоняется
  if (getLocale() === 'kk') return forms[0]
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return forms[0]
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1]
  return forms[2]
}

const dateFmt = { format: (d: Date) => new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long' }).format(d) }
const timeFmt = { format: (d: Date) => new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(d) }

/** «сегодня, 14:05», «вчера», «12 сентября» */
export function when(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const days = Math.floor((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return t('сегодня, {time}', { time: timeFmt.format(d) })
  if (days === 1) return t('вчера')
  return dateFmt.format(d)
}

/** 10 цифр после +7 → «707 123 45 32» по мере ввода */
export function formatPhoneDigits(digits: string): string {
  const d = digits.slice(0, 10)
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join(' ')
}

/** «+77071234532» → «+7 707 123 45 32» */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return ''
  const m = e164.match(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/)
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '·'
}
