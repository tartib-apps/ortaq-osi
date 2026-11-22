import { z } from 'zod'

/**
 * Конфигурация из окружения, проверяется при старте: без обязательного секрета
 * приложение не запускается, а не падает позже на первом запросе.
 */
const base64Key = (bytes: number) =>
  z.string().refine((v) => Buffer.from(v, 'base64').length === bytes, `ровно ${bytes} байта в base64`)

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.url(),
  WEB_ORIGIN: z.url(),
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: base64Key(32),
  HMAC_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length >= 32, 'не короче 32 байт в base64'),
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().min(3),
  PASSWORD_BREACH_CHECK: z.enum(['hibp', 'off']).default('hibp'),
  /** dev — заглушка SIGEX с тестовым сертификатом. В production подпись должна быть настоящей */
  SIGNATURE_PROVIDER: z.enum(['dev', 'sigex']).default('dev'),
  /** s3 — Yandex Object Storage или локальный SeaweedFS; memory — только для тестов */
  STORAGE_PROVIDER: z.enum(['s3', 'memory']).optional(),
  S3_ENDPOINT: z.url().optional(),
  /** Адрес хранилища для клиентов (presigned URL). В разработке с телефона это IP компьютера */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().default('ortaq'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  /** gemini — настоящая модель; rules — правила без внешних вызовов. По умолчанию gemini, если есть ключ (кроме тестов) */
  AI_PROVIDER: z.enum(['gemini', 'rules']).optional(),
  GEMINI_API_KEY: z.string().min(20).optional(),
  /** Цепочки моделей через запятую: при перегрузке первой вызов идёт во вторую */
  GEMINI_FAST_MODELS: z.string().default('gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash'),
  GEMINI_SMART_MODELS: z.string().default('gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite'),
  /** Лимиты дома (docs/11 §4): запросов в час и токенов в месяц */
  AI_HOURLY_CALLS: z.coerce.number().int().positive().default(20),
  AI_MONTHLY_TOKENS: z.coerce.number().int().positive().default(3_000_000),
}).refine((e) => !(e.NODE_ENV === 'production' && e.SIGNATURE_PROVIDER === 'dev'), {
  path: ['SIGNATURE_PROVIDER'],
  message: 'заглушка подписи запрещена в production',
}).refine((e) => !(e.NODE_ENV === 'production' && e.STORAGE_PROVIDER === 'memory'), {
  path: ['STORAGE_PROVIDER'],
  message: 'хранилище в памяти запрещено в production',
}).refine((e) => aiProvider(e) !== 'gemini' || !!e.GEMINI_API_KEY, {
  path: ['GEMINI_API_KEY'],
  message: 'для AI_PROVIDER=gemini нужен GEMINI_API_KEY',
}).refine((e) => storageProvider(e) !== 's3' || (e.S3_ENDPOINT && e.S3_ACCESS_KEY && e.S3_SECRET_KEY), {
  path: ['S3_ENDPOINT'],
  message: 'для S3 нужны S3_ENDPOINT, S3_ACCESS_KEY и S3_SECRET_KEY',
})

export function aiProvider(e: { NODE_ENV: string; AI_PROVIDER?: 'gemini' | 'rules'; GEMINI_API_KEY?: string }): 'gemini' | 'rules' {
  return e.AI_PROVIDER ?? (e.NODE_ENV !== 'test' && e.GEMINI_API_KEY ? 'gemini' : 'rules')
}

/** По умолчанию тесты работают с хранилищем в памяти, всё остальное — с S3 */
export function storageProvider(e: { NODE_ENV: string; STORAGE_PROVIDER?: 's3' | 'memory' }): 's3' | 'memory' {
  return e.STORAGE_PROVIDER ?? (e.NODE_ENV === 'test' ? 'memory' : 's3')
}

export type Env = z.infer<typeof schema>

let cached: Env | undefined

export function env(): Env {
  if (cached) return cached
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Некорректная конфигурация окружения: ${fields}`)
  }
  cached = parsed.data
  return cached
}
