#!/usr/bin/env node
/**
 * Проверка казахской локализации (веб и приложение жильца).
 *
 *   node scripts/i18n-check.mjs          — отчёт: ключи t('…') без перевода и расхождения плейсхолдеров
 *   node scripts/i18n-check.mjs --merge  — сначала влить словари из i18n/parts/*.json в kk.json
 *
 * Ключ перевода — русская строка в t('…'). Строки из tr({...}) и plural-формы попадают в словарь
 * вручную: статически их не найти.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const APPS = [
  { name: 'web', src: 'apps/web/src', dict: 'apps/web/src/shared/i18n/kk.json', parts: 'apps/web/src/shared/i18n/parts' },
  { name: 'mobile', src: 'apps/mobile/src', dict: 'apps/mobile/src/lib/i18n/kk.json', parts: 'apps/mobile/src/lib/i18n/parts' },
]
const merge = process.argv.includes('--merge')

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p)
    return /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f) ? [p] : []
  })
}

/** Аргумент t('…') или t("…") — строковый литерал без интерполяции */
function keysIn(code) {
  const out = new Set()
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g
  for (const m of code.matchAll(re)) out.add(m[2].replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n'))
  return out
}

let problems = 0
for (const app of APPS) {
  const dictPath = join(ROOT, app.dict)
  let dict = existsSync(dictPath) ? JSON.parse(readFileSync(dictPath, 'utf8')) : {}
  const partsDir = join(ROOT, app.parts)
  if (merge && existsSync(partsDir)) {
    for (const f of readdirSync(partsDir).filter((x) => x.endsWith('.json')).sort()) {
      const part = JSON.parse(readFileSync(join(partsDir, f), 'utf8'))
      for (const [k, v] of Object.entries(part)) if (typeof v === 'string' && v.trim() && !(k in dict)) dict[k] = v
    }
    dict = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b, 'ru')))
    writeFileSync(dictPath, `${JSON.stringify(dict, null, 2)}\n`)
    rmSync(partsDir, { recursive: true, force: true })
  }

  const used = new Map()
  for (const f of files(join(ROOT, app.src))) {
    for (const k of keysIn(readFileSync(f, 'utf8'))) if (!used.has(k)) used.set(k, relative(ROOT, f))
  }
  const missing = [...used].filter(([k]) => !(k in dict) && /[А-Яа-яЁё]/.test(k))
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  const placeholders = Object.entries(dict).filter(([k, v]) => ph(k) !== ph(v))
  console.log(`\n${app.name}: ключей в коде ${used.size}, переводов ${Object.keys(dict).length}, без перевода ${missing.length}`)
  for (const [k, f] of missing.slice(0, 50)) console.log(`  нет перевода: ${JSON.stringify(k)}  (${f})`)
  if (missing.length > 50) console.log(`  … и ещё ${missing.length - 50}`)
  for (const [k] of placeholders) console.log(`  плейсхолдеры не совпадают: ${JSON.stringify(k)}`)
  problems += missing.length + placeholders.length
}
process.exitCode = problems ? 1 : 0
