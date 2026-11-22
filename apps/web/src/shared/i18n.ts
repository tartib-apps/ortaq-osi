import { useSyncExternalStore } from 'react'
import type { Locale } from '@ortaq/shared'
import kk from './i18n/kk.json'

/**
 * Локализация интерфейса: русский и казахский (обязателен к публичному релизу, docs/15).
 *
 * Ключ — сама русская строка: t('Заявки'). Перевода нет — показывается русский текст, поэтому
 * недопереведённый экран остаётся рабочим. Переменные — в фигурных скобках: t('Задач: {n}', { n }).
 * Строки переводятся в момент отрисовки: смена языка перемонтирует приложение (main.tsx).
 */
const KEY = 'ortaq.locale'
const dictionaries: Record<Locale, Record<string, string>> = { ru: {}, kk }

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'kk' || v === 'ru' ? v : null
  } catch {
    return null
  }
}

let current: Locale = stored() ?? 'ru'
const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return current
}

/** explicit — выбор человека на этом устройстве: он важнее языка из профиля */
export function setLocale(next: Locale, explicit = true) {
  if (explicit) {
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // Приватный режим: язык продержится до перезагрузки
    }
  }
  if (next === current) return
  current = next
  document.documentElement.lang = next
  listeners.forEach((l) => l())
}

/** Язык из профиля применяется, если на этом устройстве его ещё не выбирали */
export function adoptProfileLocale(locale: Locale | undefined) {
  if (locale && !stored()) setLocale(locale, false)
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

/** Локаль Intl для дат и чисел */
export function intlLocale(): string {
  return current === 'kk' ? 'kk-KZ' : 'ru-RU'
}

if (typeof document !== 'undefined') document.documentElement.lang = current
