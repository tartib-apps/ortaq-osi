/**
 * Демо-дом для показа: ЖК New City Life в Астане с жильцами, персоналом, заявками, задачами, финансами и голосованием.
 * Каркас (организация, дом, помещения, учётные записи, членство) пишется в базу напрямую, как это делает админ-панель;
 * всё остальное проходит через работающий API от имени председателя, жильцов и работника — с аудитом и проверками.
 *
 *   API должен быть запущен (pnpm --filter @ortaq/api dev), затем:
 *   pnpm --filter @ortaq/api exec tsx prisma/demo-astana.ts
 *
 * Пароль председателя и секрет 2FA печатаются в конце. Только для локальной разработки.
 */
import { randomBytes, randomInt } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import * as argon2 from 'argon2'
import { ARGON } from '../src/modules/auth/password.service'
import { CryptoService } from '../src/infra/crypto.service'
import { TotpService } from '../src/modules/auth/totp.service'
import { generateUnits } from '../src/modules/admin/units.generator'

process.loadEnvFile('.env')
if (process.env.NODE_ENV === 'production') throw new Error('Демо-данные в продакшене запрещены')

const API = `http://localhost:${process.env.PORT ?? 3000}/v1`
const db = new PrismaClient({ datasourceUrl: process.env.MIGRATE_DATABASE_URL })
const crypto = new CryptoService()
const totp = new TotpService()

const CHAIRMAN_EMAIL = 'chairman@newcitylife.kz'
const WORKER_PHONE = '+77015550101'
const RESIDENT_PHONE = '+77015550001'
const DAY = 86_400_000

/* ───────── синтетические данные ───────── */

const SURNAMES_M = ['Ахметов', 'Сейткали', 'Жумабаев', 'Нургалиев', 'Касымов', 'Иванов', 'Ким', 'Оспанов', 'Абдрахманов', 'Байжанов', 'Смагулов', 'Петров', 'Тулегенов', 'Есенов', 'Кенжебеков', 'Мусин', 'Садыков', 'Омаров', 'Рахимов', 'Шарипов']
const SURNAMES_F = ['Ахметова', 'Сейткали', 'Жумабаева', 'Нургалиева', 'Касымова', 'Иванова', 'Ким', 'Оспанова', 'Абдрахманова', 'Байжанова', 'Смагулова', 'Петрова', 'Тулегенова', 'Есенова', 'Кенжебекова', 'Мусина', 'Садыкова', 'Омарова', 'Рахимова', 'Шарипова']
const NAMES_M = ['Ерлан', 'Даурен', 'Азамат', 'Нурлан', 'Арман', 'Алексей', 'Тимур', 'Бекзат', 'Санжар', 'Руслан', 'Дмитрий', 'Канат', 'Асхат', 'Ильяс', 'Мирас']
const NAMES_F = ['Айгерим', 'Динара', 'Мадина', 'Алия', 'Жанар', 'Елена', 'Сауле', 'Гульнара', 'Камила', 'Асель', 'Ольга', 'Аружан', 'Дана', 'Томирис', 'Зарина']

let state = 7
const rnd = () => ((state = (state * 16807) % 2147483647) - 1) / 2147483646
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!
const person = (female: boolean) => (female ? `${pick(SURNAMES_F)} ${pick(NAMES_F)}` : `${pick(SURNAMES_M)} ${pick(NAMES_M)}`)

/** Контрольный разряд ИИН/БИН; null — такой номер не выдаётся */
function control(base: string): number | null {
  const d = [...base].map(Number)
  let c = d.reduce((s, v, i) => s + v * (i + 1), 0) % 11
  if (c === 10) c = d.reduce((s, v, i) => s + v * ([3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2][i] ?? 0), 0) % 11
  return c === 10 ? null : c
}

/** ИИН с правдоподобной датой рождения и верным контрольным разрядом */
function iin(female: boolean): string {
  for (;;) {
    const y = 1960 + Math.floor(rnd() * 40)
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    const base = `${pad(y % 100)}${pad(1 + Math.floor(rnd() * 12))}${pad(1 + Math.floor(rnd() * 28))}${female ? 4 : 3}${pad(Math.floor(rnd() * 1e4), 4)}`
    const c = control(base)
    if (c !== null) return base + c
  }
}

function bin(): string {
  for (let i = 0; ; i++) {
    const base = `2103400${String(1234 + i).padStart(4, '0')}`
    const c = control(base)
    if (c !== null) return base + c
  }
}

/* ───────── HTTP ───────── */

type Session = { cookie?: string; bearer?: string; secret?: string; stepUp?: { token: string; at: number } }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call<T = any>(s: Session | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { ...extra }
  if (s?.cookie) headers.cookie = s.cookie
  if (s?.bearer) { headers.authorization = `Bearer ${s.bearer}`; headers['x-client'] = 'mobile' }
  let payload: FormData | string | undefined
  if (body instanceof FormData) payload = body
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { method, headers, body: payload })
    // Лимит записи — 60 в минуту на маршрут: при массовых оплатах ждём окно
    if (res.status === 429 && attempt < 10) { await sleep(10_000); continue }
    const set = res.headers.getSetCookie()
    if (s && set.length) {
      const jar = new Map((s.cookie ?? '').split('; ').filter(Boolean).map((c) => [c.split('=')[0]!, c]))
      for (const c of set) { const kv = c.split(';')[0]!; jar.set(kv.split('=')[0]!, kv) }
      s.cookie = [...jar.values()].join('; ')
    }
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 400)}`)
    return json as T
  }
}

/** Подтверждение кодом для чувствительных действий. Один код TOTP принимается один раз — при отказе ждём новое окно */
async function stepUp(s: Session): Promise<Record<string, string>> {
  if (!s.stepUp || Date.now() - s.stepUp.at > 3 * 60_000) {
    for (let i = 0; ; i++) {
      try {
        const r = await call(s, 'POST', '/auth/step-up', { code: totp.generate(s.secret!) })
        s.stepUp = { token: r.step_up_token, at: Date.now() }
        break
      } catch (e) {
        if (i > 3) throw e
        await sleep(31_000)
      }
    }
  }
  return { 'x-step-up-token': s.stepUp!.token }
}

async function step<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  process.stdout.write(`• ${title}… `)
  try {
    const r = await fn()
    console.log('готово')
    return r
  } catch (e) {
    console.log(`ошибка\n  ${(e as Error).message}`)
    return undefined
  }
}

/* ───────── вход ───────── */

async function chairmanLogin(email: string, password: string, secret: string): Promise<Session> {
  const s: Session = { secret }
  const first = await call(s, 'POST', '/auth/password/login', { email, password })
  await call(s, 'POST', '/auth/2fa/verify', { challenge: first.challenge, code: totp.generate(secret) })
  return s
}

/** Вход по телефону: код кладём в базу, как его получил бы человек по SMS, и проверяем через API */
async function phoneLogin(phone: string): Promise<Session> {
  const code = String(randomInt(100000, 1000000))
  await db.otpCode.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } })
  await db.otpCode.create({ data: { phone, codeHash: Buffer.from(crypto.hmac(`otp:${phone}:${code}`)), ip: '127.0.0.1', expiresAt: new Date(Date.now() + 5 * 60_000) } })
  const r = await call(null, 'POST', '/auth/otp/verify', { phone, code }, { 'x-client': 'mobile' })
  return { bearer: r.access_token }
}

/* ───────── файлы ───────── */

async function upload(s: Session, houseId: string, purpose: string, mime: string, name: string, body: Buffer): Promise<string> {
  const r = await call(s, 'POST', `/houses/${houseId}/files/upload-url`, { purpose, mime_type: mime, size_bytes: body.length, name })
  const put = await fetch(r.upload_url, { method: r.method ?? 'PUT', body, headers: r.headers ?? { 'content-type': mime } })
  if (!put.ok) throw new Error(`Загрузка в хранилище: ${put.status}`)
  await call(s, 'POST', `/houses/${houseId}/files/${r.file_id}/finalize`)
  return r.file_id
}

async function receiptPdf(title: string, amount: number, date: string, counterparty: string): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default
  const doc = new PDFDocument({ size: 'A5', margin: 40 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((r) => doc.on('end', () => r()))
  doc.font('assets/fonts/NotoSans-Bold.ttf').fontSize(14).text('Платёжное поручение')
  doc.moveDown().font('assets/fonts/NotoSans-Regular.ttf').fontSize(11)
  doc.text('Плательщик: ОСИ «New City Life»').text(`Получатель: ${counterparty}`).text(`Назначение: ${title}`)
  doc.text(`Сумма: ${amount.toLocaleString('ru-RU')} ₸`).text(`Дата: ${date}`)
  doc.end()
  await done
  return Buffer.concat(chunks)
}

/* ───────── каркас в базе ───────── */

type Resident = { id: string; name: string; phone: string; unitNumber: string }

async function skeleton() {
  if (await db.user.findUnique({ where: { email: CHAIRMAN_EMAIL } })) throw new Error('ЖК New City Life уже создан')

  const org = await db.organization.create({
    data: { name: 'ОСИ «New City Life»', bin: bin(), managementForm: 'OSI', legalAddress: 'г. Астана, р-н Есиль, пр. Туран, 55' },
  })
  const house = await db.house.create({
    data: {
      organizationId: org.id, address: 'г. Астана, р-н Есиль, пр. Туран, 55', displayName: 'ЖК New City Life, блок 2',
      entranceCount: 2, unitCount: 72, floorCount: 9, builtYear: 2021,
    },
  })
  await db.unit.createMany({
    data: generateUnits([
      { entrance: 1, from: 1, to: 36, floors: 9 },
      { entrance: 2, from: 37, to: 72, floors: 9 },
    ]).map((u) => ({ ...u, houseId: house.id })),
  })
  const units = (await db.unit.findMany({ where: { houseId: house.id } })).sort((a, b) => Number(a.number) - Number(b.number))

  // Председатель: пароль и 2FA подключены, дом сразу рабочий
  const password = `Ncl-${randomBytes(6).toString('base64url')}-2026`
  const secret = totp.generateSecret()
  const chairman = await db.user.create({
    data: {
      email: CHAIRMAN_EMAIL, fullName: 'Сарсенбаев Ерболат', passwordHash: await argon2.hash(password, ARGON), status: 'ACTIVE',
      totpSecretEncrypted: Buffer.from(crypto.encrypt(secret)), totpEnabledAt: new Date(),
    },
  })
  await db.houseMembership.create({ data: { houseId: house.id, userId: chairman.id, role: 'CHAIRMAN', joinedVia: 'ADMIN_PROVISION' } })

  const worker = await db.user.create({ data: { fullName: 'Жаксылыков Нурлан', phone: WORKER_PHONE, status: 'ACTIVE' } })
  await db.houseMembership.create({ data: { houseId: house.id, userId: worker.id, role: 'WORKER', joinedVia: 'CHAIRMAN_ADD' } })

  // Собственники всех 72 квартир идут в реестр; 30 из них пользуются приложением
  const owners = units.map((u, i) => {
    const female = i === 0 || rnd() < 0.5
    return { unit: u, name: i === 0 ? 'Мухамеджанова Айгерим' : person(female), iin: iin(female) }
  })
  const chosen = new Set<number>([0])
  while (chosen.size < 30) chosen.add(Math.floor(rnd() * owners.length))
  const residents: Resident[] = []
  let n = 2
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const o = owners[i]!
    const phone = i === 0 ? RESIDENT_PHONE : `+770155500${String(n++).padStart(2, '0')}`
    const user = await db.user.create({ data: { fullName: o.name, phone, status: 'ACTIVE', identityVerifiedAt: new Date() } })
    await db.houseMembership.create({ data: { houseId: house.id, userId: user.id, role: 'RESIDENT', joinedVia: 'INVITE_LINK' } })
    await db.unitOwnership.create({
      data: {
        houseId: house.id, unitId: o.unit.id, userId: user.id, relation: 'OWNER', verificationStatus: 'VERIFIED',
        verificationMethod: 'EDS_REGISTRY_MATCH', verifiedAt: new Date(), isVotingRepresentative: true,
      },
    })
    residents.push({ id: user.id, name: o.name, phone, unitNumber: o.unit.number })
  }

  // Двое ждут решения председателя: арендатор и новый собственник
  for (const a of [
    { fullName: 'Бекова Дана', phone: '+77015559001', unit: '14', relation: 'TENANT' as const, comment: 'Снимаю квартиру с октября, договор на год' },
    { fullName: 'Тлеуов Санжар', phone: '+77015559002', unit: '58', relation: 'OWNER' as const, comment: 'Купил квартиру в ноябре, документы на руках' },
  ]) {
    const user = await db.user.create({ data: { fullName: a.fullName, phone: a.phone, status: 'ACTIVE' } })
    await db.joinRequest.create({ data: { houseId: house.id, userId: user.id, claimedUnitNumber: a.unit, claimedRelation: a.relation, comment: a.comment } })
  }

  return { house, owners, residents, worker, password, secret }
}

/* ───────── наполнение через API ───────── */

async function main() {
  const k = await skeleton()
  const H = k.house.id
  console.log(`Дом создан: ${k.house.displayName} (${H})`)
  const ch = await chairmanLogin(CHAIRMAN_EMAIL, k.password, k.secret)

  await step('Реестр собственников с площадями', async () => {
    const areas = [48.6, 62.3, 78.9, 95.4]
    const rows = ['№ п/п;Номер помещения;ФИО собственника;ИИН;Площадь, м²',
      ...k.owners.map((o, i) => `${i + 1};${o.unit.number};${o.name};${o.iin};${String(areas[i % 4]).replace('.', ',')}`)]
    const form = new FormData()
    form.append('file', new Blob([rows.join('\n')], { type: 'text/csv' }), 'Реестр New City Life.csv')
    const preview = await call(ch, 'POST', `/houses/${H}/registry/imports`, form)
    await call(ch, 'POST', `/houses/${H}/registry/imports/${preview.import_id}/apply`, { areas: 'overwrite' }, await stepUp(ch))
  })

  const staff = await step('Персонал и подрядчики', async () => {
    const list = [
      { full_name: 'Жаксылыков Нурлан', position: 'Сантехник', specializations: ['PLUMBER', 'HANDYMAN'], phone_public: WORKER_PHONE, work_schedule: 'Пн–Пт 9:00–18:00, аварийные круглосуточно' },
      { full_name: 'Ибраев Мурат', position: 'Электрик', specializations: ['ELECTRICIAN'], phone_public: '+77015550102', work_schedule: 'Пн–Пт 9:00–18:00' },
      { full_name: 'Нуржанова Гульмира', position: 'Уборщица', specializations: ['CLEANER'], work_schedule: 'Ежедневно 8:00–14:00' },
      { full_name: 'Петренко Виктор', position: 'Дворник', specializations: ['YARD_KEEPER'], work_schedule: 'Ежедневно 6:00–12:00' },
      { full_name: 'Аманжолов Берик', position: 'Охранник', specializations: ['SECURITY'], phone_public: '+77015550105', work_schedule: 'Сутки через трое' },
    ]
    const made: any[] = []
    for (const s of list) made.push(await call(ch, 'POST', `/houses/${H}/staff`, s))
    await call(ch, 'PATCH', `/houses/${H}/staff/${made[0].id}`, { user_id: k.worker.id })
    await call(ch, 'POST', `/houses/${H}/contractors`, { name: 'ТОО «Астана Лифт Сервис»', specializations: ['ELEVATOR'], contact_person: 'Сериков Данияр', phone: '+77172555010', contract_from: '2026-01-01', contract_to: '2026-12-31' })
    await call(ch, 'POST', `/houses/${H}/contractors`, { name: 'ТОО «ЧистоГрад»', specializations: ['CLEANER', 'YARD_KEEPER'], contact_person: 'Ахметова Сауле', phone: '+77172555020', contract_from: '2026-03-01' })
    return made
  })

  const accounts = await step('Счета дома и реквизиты Kaspi', async () => {
    const current = await call(ch, 'POST', `/houses/${H}/accounts`, { type: 'CURRENT', bank_name: 'Halyk Bank', account_number: '4821', opening_balance: 1_240_000, opened_on: '2026-09-30' }, await stepUp(ch))
    const savings = await call(ch, 'POST', `/houses/${H}/accounts`, { type: 'SAVINGS', bank_name: 'Halyk Bank', account_number: '7310', opening_balance: 3_860_000, opened_on: '2026-09-30' }, await stepUp(ch))
    await call(ch, 'PUT', `/houses/${H}/payment-settings`, { pay_url: 'https://kaspi.kz/pay/NewCityLife', recipient_name: 'ОСИ New City Life' }, await stepUp(ch))
    return { current, savings }
  })

  await tariffsAndPayments(ch, H, k.owners.map((o) => o.unit.number))
  await rest(ch, H, k, staff, accounts)

  console.log(`
Готово: ЖК New City Life, блок 2 (${H})
Председатель: ${CHAIRMAN_EMAIL} / ${k.password} / секрет 2FA ${k.secret}
Работник:     ${WORKER_PHONE} (Жаксылыков Нурлан, сантехник)
Жилец:        ${RESIDENT_PHONE} (Мухамеджанова Айгерим, кв. ${k.residents[0]!.unitNumber})
Код по телефону — в Mailpit: http://localhost:8035`)
}

/** Тариф вводится только с текущего месяца: начисления и оплаты — за него */
async function tariffsAndPayments(ch: Session, H: string, unitNumbers: string[]) {
  const now = new Date()
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  await step(`Тарифы и начисления за ${period}`, async () => {
    const note = 'Протокол собрания №3 от 12.09.2026'
    await call(ch, 'POST', `/houses/${H}/tariffs`, { type: 'MAINTENANCE', basis: 'PER_SQM', rate: 95, effective_from: period, decision_note: note }, await stepUp(ch))
    await call(ch, 'POST', `/houses/${H}/tariffs`, { type: 'CAPITAL_REPAIR', basis: 'PER_SQM', rate: 25, effective_from: period, decision_note: note }, await stepUp(ch))
    await call(ch, 'POST', `/houses/${H}/charges/generate`, { period }, await stepUp(ch))
  })

  await step('Оплаты: около 70% квартир уже заплатили', async () => {
    const res: any = await call(ch, 'GET', `/houses/${H}/charges?status=all`)
    const list: any[] = Array.isArray(res) ? res : res.items
    const payers = new Set(unitNumbers.filter((n) => !['7', '23', '41', '66', '70'].includes(n) && rnd() < 0.75))
    let paid = 0
    for (const c of list) {
      if (!payers.has(c.unit.number)) continue
      const day = 1 + Math.floor(rnd() * Math.max(1, now.getDate() - 1))
      await call(ch, 'POST', `/houses/${H}/payments`, {
        charge_id: c.id, amount: c.amount, method: rnd() < 0.85 ? 'BANK_TRANSFER' : 'CASH', paid_on: `${c.period}-${String(day).padStart(2, '0')}`,
      }, await stepUp(ch))
      paid++
    }
    process.stdout.write(`${paid} оплат, `)
  })
}

type Skeleton = Awaited<ReturnType<typeof skeleton>>
type Accounts = { current: { id: string }; savings: { id: string } } | undefined

/** Расходы, объявления, заявки, задачи, голосование и сводка */
async function rest(ch: Session, H: string, k: Skeleton, staff: any[] | undefined, accounts: Accounts) {
  await step('Расходы с платёжками', async () => {
    if (!accounts) throw new Error('нет счетов')
    const items = [
      ['2026-10-05', '7.1.1', 180_000, 'Бухгалтерское сопровождение, октябрь', 'ИП Касымова А.'],
      ['2026-10-07', '7.2.1.10', 145_000, 'Техобслуживание лифтов, октябрь', 'ТОО «Астана Лифт Сервис»'],
      ['2026-10-10', '7.2.1.6', 210_000, 'Уборка подъездов, октябрь', 'ТОО «ЧистоГрад»'],
      ['2026-10-15', '7.2.1.3', 96_400, 'Электроэнергия мест общего пользования, октябрь', 'АО «Астана-ЕРЦ»'],
      ['2026-10-21', '7.3.3', 74_500, 'Замена задвижки в тепловом узле', 'ТОО «ТеплоМонтаж»'],
      ['2026-10-28', '7.2.1.5', 160_000, 'Промывка системы отопления перед сезоном', 'ТОО «ТеплоМонтаж»'],
      ['2026-11-05', '7.1.1', 180_000, 'Бухгалтерское сопровождение, ноябрь', 'ИП Касымова А.'],
      ['2026-11-07', '7.2.1.10', 145_000, 'Техобслуживание лифтов, ноябрь', 'ТОО «Астана Лифт Сервис»'],
      ['2026-11-10', '7.2.1.6', 210_000, 'Уборка подъездов, ноябрь', 'ТОО «ЧистоГрад»'],
      ['2026-11-14', '7.2.1.8', 85_000, 'Вывоз снега после снегопада', 'ТОО «СнегТранс»'],
      ['2026-11-18', '7.5', 32_800, 'Хозинвентарь: лопаты, реагент, лампы', 'ТОО «Строймаркет»'],
    ] as const
    for (const [date, code, amount, description, counterparty] of items) {
      const file = await upload(ch, H, 'FINANCE_DOCUMENT', 'application/pdf', `Платёжка ${date}.pdf`, await receiptPdf(description, amount, date, counterparty))
      await call(ch, 'POST', `/houses/${H}/transactions`, {
        idempotency_key: `demo-${randomBytes(6).toString('hex')}`, account_id: accounts.current.id, category_code: code, amount, occurred_on: date,
        description, counterparty, documents: [{ file_id: file, kind: 'PAYMENT_ORDER' }], confirm: true,
      }, await stepUp(ch))
    }
  })

  await step('Объявления', async () => {
    const post = (b: Record<string, unknown>) => call(ch, 'POST', `/houses/${H}/announcements`, { audience: 'ALL', push: false, ...b })
    await post({ title: 'Отключение горячей воды 26 ноября', pinned: true, body: 'В среду, 26 ноября, с 10:00 до 16:00 горячей воды не будет: меняем задвижку в тепловом узле. Просим заранее набрать воду. Спасибо за понимание!' })
    await post({ title: 'Уборка снега во дворе', body: 'В ночь с 23 на 24 ноября техника будет вывозить снег. Пожалуйста, переставьте машины с внутренней парковки к южной стороне двора до 23:00.' })
    await post({ title: 'Голосование за ремонт детской площадки', body: 'Готовим электронное голосование за ремонт детской площадки. Предложения трёх подрядчиков уже собраны, вопросы и даты — в разделе «Голосования».' })
    await post({ title: 'Проверка лифта во втором подъезде', audience: 'ENTRANCE', entrances: [2], body: 'Плановая проверка лифта 25 ноября с 11:00 до 13:00. Лифт будет недоступен около двух часов.' })
  })

  const r = k.residents
  const reqs = [
    { who: r[0]!, body: { title: 'Течёт кран в ванной', description: 'Под раковиной в ванной течёт соединение, подставили таз. Прошу посмотреть сантехника.', category: 'PLUMBING', location_type: 'APARTMENT' } },
    { who: r[3]!, body: { title: 'Не горит свет на 5 этаже', description: 'Во втором подъезде на пятом этаже не горит лампа у лифта уже третий день, вечером очень темно.', category: 'ELECTRICITY', location_type: 'ENTRANCE', location_entrance: 2, location_floor: 5 } },
    { who: r[7]!, body: { title: 'Холодные батареи', description: 'В квартире батареи еле тёплые, в спальне +18. У соседей сверху так же.', category: 'HEATING', location_type: 'APARTMENT' } },
    { who: r[12]!, body: { title: 'Сломан доводчик двери', description: 'Входная дверь первого подъезда хлопает, доводчик сломан. Дует в подъезд.', category: 'OTHER', location_type: 'ENTRANCE', location_entrance: 1 } },
    { who: r[18]!, body: { title: 'Мусор у контейнеров', description: 'Возле мусорных контейнеров уже два дня лежат мешки, контейнеры переполнены.', category: 'TRASH', location_type: 'YARD' } },
    { who: r[22]!, body: { title: 'Наледь у входа', description: 'Перед вторым подъездом наледь, утром поскользнулась пожилая соседка. Посыпьте, пожалуйста, реагентом.', category: 'YARD', location_type: 'ENTRANCE', location_entrance: 2 } },
    { who: r[25]!, body: { title: 'Лифт застревает между этажами', description: 'Лифт в первом подъезде дважды за неделю останавливался между 6 и 7 этажом, потом ехал дальше.', category: 'ELEVATOR', location_type: 'ENTRANCE', location_entrance: 1 } },
  ]
  const created: { id: string; s: Session }[] = []
  await step('Заявки жильцов из приложения', async () => {
    for (const q of reqs) {
      const s = await phoneLogin(q.who.phone)
      created.push({ id: (await call(s, 'POST', `/houses/${H}/requests`, q.body)).id, s })
    }
    // ИИ разбирает заявки в фоне: ждём, пока все уйдут из статуса NEW
    for (let i = 0; i < 40; i++) {
      const res: any = await call(ch, 'GET', `/houses/${H}/requests?status=open`)
      const list: any[] = Array.isArray(res) ? res : res.items
      if (list.every((x) => x.status !== 'NEW')) break
      await sleep(2000)
    }
  })

  await step('Задачи и работа по заявкам', async () => {
    const ws = await phoneLogin(WORKER_PHONE)
    const assignee = staff?.[0]?.user_id ?? k.worker.id
    const [leak, light, heat, door, trash] = created
    for (const c of [leak, light, heat, door, trash]) if (c) await call(ch, 'POST', `/houses/${H}/requests/${c.id}/accept`, {})
    if (leak) await call(ch, 'PATCH', `/houses/${H}/requests/${leak.id}`, { priority: 'HIGH' })

    // Кран: сантехник сделал, председатель принял работу, жилец оценил
    const t1 = await call(ch, 'POST', `/houses/${H}/tasks`, { title: 'Заменить соединение под раковиной', request_id: leak?.id, assignee_id: assignee, specialization: 'PLUMBER', priority: 'HIGH', requires_photo: false, due_at: new Date(Date.now() + DAY).toISOString() })
    await call(ws, 'POST', `/houses/${H}/tasks/${t1.id}/start`, {})
    await call(ws, 'POST', `/houses/${H}/tasks/${t1.id}/complete`, { note: 'Заменил гибкую подводку и прокладку, течи нет.' })
    await call(ch, 'POST', `/houses/${H}/tasks/${t1.id}/approve`, {})
    if (leak) await closeAndRate(ch, H, leak)

    // Батареи: в работе у сантехника
    const t2 = await call(ch, 'POST', `/houses/${H}/tasks`, { title: 'Стравить воздух из стояка, проверить давление', request_id: heat?.id, assignee_id: assignee, specialization: 'PLUMBER', priority: 'HIGH', requires_photo: false, due_at: new Date(Date.now() + 2 * DAY).toISOString() })
    await call(ws, 'POST', `/houses/${H}/tasks/${t2.id}/start`, {})
    if (heat) await call(ch, 'POST', `/houses/${H}/requests/${heat.id}/comments`, { text: 'Сантехник придёт сегодня после 15:00, будьте, пожалуйста, дома.' })

    // Дверь и плановый осмотр — назначены и ждут; мусор — комментарий председателя
    await call(ch, 'POST', `/houses/${H}/tasks`, { title: 'Заменить доводчик входной двери, подъезд 1', request_id: door?.id, assignee_id: assignee, specialization: 'HANDYMAN', due_at: new Date(Date.now() + 3 * DAY).toISOString() })
    await call(ch, 'POST', `/houses/${H}/tasks`, { title: 'Проверить манометры в тепловом узле', description: 'Ежемесячный осмотр: давление в подаче и обратке, записать показания.', assignee_id: assignee, specialization: 'PLUMBER', requires_photo: false, due_at: new Date(Date.now() + 5 * DAY).toISOString() })
    if (trash) await call(ch, 'POST', `/houses/${H}/requests/${trash.id}/comments`, { text: 'Связались с ТОО «ЧистоГрад», вывоз сегодня до 18:00.' })
  })

  await step('Голосование за ремонт детской площадки', async () => {
    const v = await call(ch, 'POST', `/houses/${H}/votes`, {
      title: 'Ремонт детской площадки во дворе', legal_basis: 'ART_44_ELECTRONIC', decision_type: 'CURRENT_REPAIR',
      description: 'Покрытие площадки износилось, двое качелей сломаны. Предлагаем ремонт весной 2027 года за счёт взносов на содержание.',
      questions: [
        { text: 'Провести ремонт детской площадки весной 2027 года', type: 'YES_NO' },
        { text: 'Выбрать подрядчика для ремонта', type: 'SINGLE_CHOICE', options: ['ТОО «ДетствоСтрой» — 2 450 000 ₸', 'ТОО «Игровой двор» — 2 780 000 ₸', 'ИП Садыков — 2 190 000 ₸'] },
      ],
    }, await stepUp(ch))
    const starts = new Date(Date.now() + 8 * DAY)
    starts.setUTCHours(4, 0, 0, 0)
    const ends = new Date(starts.getTime() + 14 * DAY)
    await call(ch, 'POST', `/houses/${H}/votes/${v.id}/send-notice`, { starts_at: starts.toISOString(), ends_at: ends.toISOString() }, await stepUp(ch))
  })

  await step('Недельная сводка', () => call(ch, 'POST', `/houses/${H}/summary/generate`, {}))
}

/** Работа принята — председатель закрывает заявку, жилец ставит оценку */
async function closeAndRate(ch: Session, H: string, req: { id: string; s: Session }) {
  await call(ch, 'POST', `/houses/${H}/requests/${req.id}/close`, {})
  await call(req.s, 'POST', `/houses/${H}/requests/${req.id}/rate`, { rating: 5, comment: 'Пришли в тот же день, спасибо!' })
}

/**
 * Начисления и оплаты для уже созданного дома (например, в новом месяце):
 *   DEMO_PASSWORD=… DEMO_TOTP=… tsx prisma/demo-astana.ts --billing
 */
async function billing() {
  const house = await db.house.findFirstOrThrow({ where: { displayName: 'ЖК New City Life, блок 2' } })
  const units = await db.unit.findMany({ where: { houseId: house.id }, select: { number: true } })
  const ch = await chairmanLogin(CHAIRMAN_EMAIL, process.env.DEMO_PASSWORD ?? '', process.env.DEMO_TOTP ?? '')
  await tariffsAndPayments(ch, house.id, units.map((u) => u.number))
}

;(process.argv.includes('--billing') ? billing() : main())
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
