import type { Tone } from '../shared/ui/kit'
import { tr, intlLocale } from '../shared/i18n'

export const SPECIALIZATION_LABELS: Record<string, string> = tr({
  PLUMBER: 'сантехник', ELECTRICIAN: 'электрик', CLEANER: 'уборка', YARD_KEEPER: 'дворник',
  HANDYMAN: 'мастер', SECURITY: 'охрана', ELEVATOR: 'лифты', OTHER: 'другое',
})

export const CATEGORY_LABELS: Record<string, string> = tr({
  PLUMBING: 'Сантехника', ELECTRICITY: 'Электрика', HEATING: 'Отопление', ELEVATOR: 'Лифт', CLEANING: 'Уборка', YARD: 'Двор',
  FACADE: 'Фасад', ROOF: 'Кровля', BASEMENT: 'Подвал', TRASH: 'Мусор', SECURITY: 'Безопасность', OTHER: 'Другое',
})

export const PRIORITY_LABELS: Record<string, string> = tr({ CRITICAL: 'Критично', HIGH: 'Высокий', NORMAL: 'Обычный', LOW: 'Низкий' })

export const REQUEST_STATUS_LABELS: Record<string, string> = tr({
  NEW: 'Новая', TRIAGE: 'Ждёт решения', ACCEPTED: 'Принята', IN_PROGRESS: 'В работе', DONE: 'Выполнена', REJECTED: 'Отклонена', CANCELLED: 'Отменена',
})

export const TASK_STATUS_LABELS: Record<string, string> = tr({
  ASSIGNED: 'Назначена', IN_PROGRESS: 'В работе', SUBMITTED: 'Ждёт проверки', APPROVED: 'Принята', REJECTED: 'На доработке', CANCELLED: 'Отменена', EXPIRED: 'Просрочена',
})

export const FLAG_LABELS: Record<string, string> = tr({
  NEEDS_CLARIFICATION: 'нужно уточнить', SUSPICIOUS: 'подозрительная', POSSIBLE_DUPLICATE: 'возможный дубликат', NO_AUTOCHECK: 'без автопроверки',
})

export const PRIORITY_TONE: Record<string, Tone> = { CRITICAL: 'crit', HIGH: 'warn', NORMAL: 'brand', LOW: 'mute' }

/* ───────── финансы ───────── */

export const DOC_KIND: Record<string, string> = tr({
  RECEIPT: 'Чек', PAYMENT_ORDER: 'Платёжное поручение', WORK_ACT: 'Акт выполненных работ', DEFECT_ACT: 'Дефектный акт',
  CONTRACT: 'Договор', PROTOCOL: 'Протокол собрания', OTHER: 'Другой документ',
})
/** Чего не хватает: «чек» в списке недостающих означает «чек или платёжное поручение» */
export const MISSING_DOC: Record<string, string> = tr({ ...DOC_KIND, RECEIPT: 'чек или платёжка', WORK_ACT: 'акт работ', DEFECT_ACT: 'дефектный акт', PROTOCOL: 'протокол собрания' })
export const TX_STATUS: Record<string, string> = tr({ DRAFT: 'Черновик', CONFIRMED: 'Проведена', VOIDED: 'Аннулирована' })
export const ACCOUNT_TYPE: Record<string, string> = tr({ CURRENT: 'Текущий счёт', SAVINGS: 'Сберегательный счёт' })

// Форматтеры создаются при вызове: язык интерфейса меняется на лету
export const money = (n: number) => `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(n)} ₸`

export const CHARGE_TYPE: Record<string, string> = tr({
  MAINTENANCE: 'Взнос на управление', CAPITAL_REPAIR: 'Взнос на капремонт', PARKING: 'Парковка и кладовки', TARGETED: 'Целевой взнос', OTHER: 'Прочее',
})
export const CHARGE_STATUS: Record<string, string> = tr({ PENDING: 'Ожидает оплаты', PARTIALLY_PAID: 'Оплачено частично', PAID: 'Оплачено', OVERDUE: 'Просрочено', CANCELLED: 'Отменено' })
export const PAYMENT_STATUS: Record<string, string> = tr({ PENDING_REVIEW: 'На проверке', FLAGGED: 'Есть замечания', CONFIRMED: 'Подтверждена', REJECTED: 'Отклонена' })
export const PAYMENT_METHOD: Record<string, string> = tr({ KASPI_LINK: 'Kaspi', RECEIPT_UPLOAD: 'Чек', KASPI_API: 'Kaspi Pay', CASH: 'Наличные', BANK_TRANSFER: 'Перевод' })
export const DEBT_LEVEL: Record<string, string> = tr({ REMIND: '1 месяц', REPEAT: '2–3 месяца', PRETRIAL: 'больше 3 месяцев' })
export const REPORT_STATUS: Record<string, string> = tr({ DRAFT: 'Черновик', SIGNED: 'Подписан', PUBLISHED: 'Опубликован' })
export const UNIT_TYPE: Record<string, string> = tr({ APARTMENT: 'Квартиры', COMMERCIAL: 'Нежилые', PARKING: 'Парковочные места', STORAGE: 'Кладовки' })

/** «2026-10» → «Октябрь 2026» */
export const monthLabel = (p: string) => { const s = new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${p}-01T00:00:00Z`)).replace(' г.', '').replace(' ж.', ''); return s[0]!.toUpperCase() + s.slice(1) }
/** Последние n отчётных месяцев от текущего по Алматы */
export function recentMonths(n = 12): string[] {
  const now = new Date(Date.now() + 5 * 3600_000)
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7))
}

export const VOTE_STATUS: Record<string, string> = tr({
  DRAFT: 'Черновик',
  NOTICE_SENT: 'Уведомление разослано',
  ACTIVE: 'Идёт голосование',
  CLOSED: 'Завершено',
  CANCELLED: 'Отменено',
})

export const PROTOCOL_STATUS: Record<string, string> = tr({
  AWAITING_SIGNATURES: 'Ждёт подписей',
  SIGNED: 'Подписан',
  PUBLISHED: 'Опубликован',
})

export const QUESTION_TYPE: Record<string, string> = tr({
  YES_NO: 'За / против / воздержался',
  SINGLE_CHOICE: 'Один вариант из списка',
  MULTI_CHOICE: 'Несколько вариантов',
})

export const area = (m2: number) => `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 2 }).format(m2)} м²`
export const pct = (p: number) => `${new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 2 }).format(p)}%`
