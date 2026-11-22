import { useSyncExternalStore } from 'react'
import type { Locale } from '@ortaq/shared'
import kk from './i18n/kk.json'
import { localeStore } from './tokens'

/**
 * Локализация приложения жильца: русский и казахский (docs/15). Ключ — сама русская строка:
 * t('Заявки'). Перевода нет — остаётся русский текст. Переменные: t('Задач: {n}', { n }).
 * Строки переводятся при отрисовке: смена языка перемонтирует навигацию (_layout.tsx).
 */
const dictionaries: Record<Locale, Record<string, string>> = { ru: {}, kk }

let current: Locale = 'ru'
let chosen = false
const listeners = new Set<() => void>()

/** Язык с прошлого запуска — до первой отрисовки, чтобы экран не мигал русским */
export async function loadLocale(): Promise<void> {
  const v = await localeStore.get().catch(() => null)
  if (v === 'ru' || v === 'kk') {
    chosen = true
    current = v
  }
}

export function getLocale(): Locale {
  return current
}

export function setLocale(next: Locale, explicit = true) {
  if (explicit) {
    chosen = true
    void localeStore.set(next).catch(() => undefined)
  }
  if (next === current) return
  current = next
  listeners.forEach((l) => l())
}

/** Язык профиля — если на этом устройстве язык ещё не выбирали */
export function adoptProfileLocale(locale: Locale | undefined) {
  if (locale && !chosen) setLocale(locale, false)
}

export function useLocale(): Locale {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb) }, getLocale, getLocale)
}

export function t(ru: string, vars?: Record<string, string | number>): string {
  const s = dictionaries[current][ru] ?? ru
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

/**
 * Словарь меток с переводом при чтении: PRIORITY_LABELS[p] вернёт строку на языке интерфейса.
 * Метки объявлены по-русски один раз, места использования не меняются
 */
export function tr<T extends Record<string, string>>(map: T): T {
  return new Proxy(map, { get: (o, k) => (typeof k === 'string' && typeof o[k] === 'string' ? t(o[k] as string) : Reflect.get(o, k)) })
}

export function intlLocale(): string {
  return current === 'kk' ? 'kk-KZ' : 'ru-RU'
}
