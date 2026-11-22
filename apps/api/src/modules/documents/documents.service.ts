import { Injectable } from '@nestjs/common'
import {
  DECISION_LABEL, ErrorCode, LEGAL_BASIS_LABEL, THRESHOLD_LABEL,
  type ProtocolView, type ReportRow, type ReportView,
} from '@ortaq/shared'
import ExcelJS from 'exceljs'
import { ctx } from '../../common/context'
import { notFound, unprocessable } from '../../common/errors'
import { PrismaService } from '../../infra/prisma.service'
import { AuditService } from '../audit/audit.service'
import { CategoriesService } from '../finance/categories.service'
import { DebtorsService } from '../finance/debtors.service'
import { num } from '../finance/finance.util'
import { buildReport, type TemplateSchema } from '../finance/report-builder'
import { ReportsService } from '../finance/reports.service'
import { ProtocolsService } from '../votes/protocols.service'
import { Pdf } from './pdf'

export type FileOut = { body: Buffer; name: string; type: string }

const PDF = 'application/pdf'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const tenge = (n: number) => money.format(n)
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' })
const dayTime = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const monthName = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`

export type AnnualView = Pick<ReportView, 'header' | 'rows' | 'work'> & { year: number; months: string[]; legal_source: string }

/**
 * Документы для печати и бухгалтерии (docs/10 §7, docs/09 §7): PDF отчёта и протокола,
 * годовой отчёт, выгрузки в Excel. Права — те же, что у самих данных: документ собирается
 * из ответа сервиса, который уже проверил роль и статус публикации.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: PrismaService,
    private readonly reports: ReportsService,
    private readonly protocols: ProtocolsService,
    private readonly categories: CategoriesService,
    private readonly debtors: DebtorsService,
    private readonly audit: AuditService,
  ) {}

  /* ───────── ежемесячный отчёт ───────── */

  async reportPdf(id: string): Promise<FileOut> {
    const r = await this.reports.detail(id)
    const hash = await this.reportHash(id)
    const pdf = new Pdf(`Отчёт за ${monthName(r.period)}`, `Ortaq · SHA-256 ${hash}`)
      .title('Отчёт об управлении объектом кондоминиума', `за ${monthName(r.period)} · ${r.legal_source}`)
    header(pdf, r.header)
    rowsTable(pdf, r.rows)
    workList(pdf, r.work)
    pdf.signatures([
      { role: 'Председатель', name: r.signatures.chairman?.name ?? null, signedAt: r.signatures.chairman ? dayTime(r.signatures.chairman.signed_at) : null },
      ...(r.signatures.accountant_required || r.signatures.accountant ? [{ role: 'Бухгалтер', name: r.signatures.accountant?.name ?? null, signedAt: r.signatures.accountant ? dayTime(r.signatures.accountant.signed_at) : null }] : []),
    ])
    if (r.status === 'DRAFT') pdf.text('Черновик: отчёт ещё не подписан и может измениться.', { muted: true })
    await this.log('report.pdf', 'Report', id)
    return { body: await pdf.end(), name: `Отчёт ОСИ ${r.period}.pdf`, type: PDF }
  }

  async reportXlsx(id: string): Promise<FileOut> {
    const r = await this.reports.detail(id)
    await this.log('report.xlsx', 'Report', id)
    return { body: await reportWorkbook(`Отчёт ${r.period}`, r.header, r.rows, r.work), name: `Отчёт ОСИ ${r.period}.xlsx`, type: XLSX }
  }

  /* ───────── годовой отчёт ───────── */

  /**
   * Годовой отчёт по той же форме: обороты за месяцы года, остатки и долги — на конец года
   * (или на конец последнего прошедшего месяца, если год идёт). Сдаётся до 1 апреля (docs/10 §7)
   */
  async annual(year: number): Promise<AnnualView> {
    const now = new Date()
    const current = now.getUTCFullYear()
    if (!Number.isInteger(year) || year < 2020 || year > current) throw unprocessable(ErrorCode.VALIDATION, 'Год отчёта — от 2020 до текущего')
    const lastMonth = year === current ? now.getUTCMonth() + 1 : 12
    const from = `${year}-01`
    const to = `${year}-${String(lastMonth).padStart(2, '0')}`
    const categories = await this.categories.all()
    const houseId = ctx().houseId ?? ''
    return this.db.run(async (tx) => {
      const template = await tx.reportTemplate.findFirst({ where: { formCode: 'MONTHLY_CONDOMINIUM', effectiveFrom: { lte: new Date(`${to}-28`) } }, orderBy: { effectiveFrom: 'desc' } })
      if (!template) throw notFound('Форма отчёта')
      const built = await buildReport(tx, houseId, to, template.schema as TemplateSchema, categories, from)
      return {
        year, months: Array.from({ length: lastMonth }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`),
        legal_source: template.legalSource, header: built.data.header, rows: built.data.rows, work: built.work,
      }
    })
  }

  async annualPdf(year: number): Promise<FileOut> {
    const a = await this.annual(year)
    const partial = a.months.length < 12 ? ` (январь — ${MONTHS[a.months.length - 1]})` : ''
    const pdf = new Pdf(`Годовой отчёт ${year}`, `Ortaq · сформирован ${dayTime(new Date().toISOString())}`)
      .title('Годовой отчёт об управлении объектом кондоминиума', `за ${year} год${partial} · ${a.legal_source}`)
    header(pdf, a.header)
    rowsTable(pdf, a.rows)
    workList(pdf, a.work)
    pdf.signatures([{ role: 'Председатель', name: null, signedAt: null }])
    pdf.text('Годовой отчёт собран из подписанных ежемесячных данных журнала. Представляется собранию собственников до 1 апреля следующего года.', { muted: true, size: 9 })
    await this.log('report.annual_pdf', 'House', houseIdOrEmpty())
    return { body: await pdf.end(), name: `Годовой отчёт ОСИ ${year}.pdf`, type: PDF }
  }

  async annualXlsx(year: number): Promise<FileOut> {
    const a = await this.annual(year)
    await this.log('report.annual_xlsx', 'House', houseIdOrEmpty())
    return { body: await reportWorkbook(`Годовой ${year}`, a.header, a.rows, a.work), name: `Годовой отчёт ОСИ ${year}.xlsx`, type: XLSX }
  }

  /* ───────── протокол собрания ───────── */

  async protocolPdf(voteId: string): Promise<FileOut> {
    const p = await this.protocols.byVote(voteId)
    const pdf = protocolDocument(p)
    await this.log('protocol.pdf', 'Protocol', p.id)
    return { body: await pdf.end(), name: `Протокол №${p.number}.pdf`, type: PDF }
  }

  /* ───────── выгрузки для бухгалтерии ───────── */

  /** Журнал операций за месяцы from..to: правлению — со всеми статусами, для сверки с банком */
  async transactionsXlsx(from: string, to: string): Promise<FileOut> {
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw unprocessable(ErrorCode.VALIDATION, 'Период — с YYYY-MM по YYYY-MM')
    const rows = await this.db.run((tx) => tx.transaction.findMany({
      where: { period: { gte: from, lte: to } },
      include: { account: { select: { type: true, bankName: true } }, category: { select: { shortName: true } }, contractor: { select: { name: true } }, documents: { where: { removedAt: null }, select: { kind: true } } },
      orderBy: [{ occurredOn: 'asc' }, { number: 'asc' }],
      take: 20_000,
    }))
    const wb = workbook()
    const ws = wb.addWorksheet('Журнал операций', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = [
      { header: '№', key: 'n', width: 7 }, { header: 'Дата', key: 'date', width: 12 }, { header: 'Месяц отчёта', key: 'period', width: 12 },
      { header: 'Счёт', key: 'account', width: 18 }, { header: 'Приход', key: 'in', width: 15, style: { numFmt: '#,##0.00' } },
      { header: 'Расход', key: 'out', width: 15, style: { numFmt: '#,##0.00' } }, { header: 'Строка формы', key: 'code', width: 12 },
      { header: 'Статья', key: 'category', width: 30 }, { header: 'Контрагент', key: 'who', width: 28 }, { header: 'Описание', key: 'desc', width: 40 },
      { header: 'Статус', key: 'status', width: 14 }, { header: 'Документы', key: 'docs', width: 20 },
    ]
    const STATUS = { DRAFT: 'черновик', CONFIRMED: 'проведена', VOIDED: 'аннулирована' } as const
    for (const t of rows) {
      ws.addRow({
        n: t.number, date: t.occurredOn, period: t.period, account: t.account.type === 'CURRENT' ? 'Текущий' : 'Сберегательный',
        in: t.direction === 'IN' ? num(t.amount) : null, out: t.direction === 'OUT' ? num(t.amount) : null,
        code: t.categoryCode, category: t.category.shortName, who: t.contractor?.name ?? t.counterparty ?? '', desc: t.description,
        status: STATUS[t.status], docs: t.documents.map((d) => d.kind).join(', '),
      })
    }
    ws.getColumn('date').numFmt = 'dd.mm.yyyy'
    styleHeader(ws)
    const confirmed = rows.filter((t) => t.status === 'CONFIRMED')
    const sum = (d: 'IN' | 'OUT') => confirmed.filter((t) => t.direction === d).reduce((s, t) => s + num(t.amount), 0)
    const total = ws.addRow({ desc: 'Итого проведено', in: sum('IN'), out: sum('OUT') })
    total.font = { bold: true }
    await this.log('finance.transactions_xlsx', 'House', houseIdOrEmpty(), { from, to, rows: rows.length })
    return { body: Buffer.from(await wb.xlsx.writeBuffer()), name: `Журнал операций ${from}—${to}.xlsx`, type: XLSX }
  }

  /** Должники — для работы бухгалтера с напоминаниями и претензиями. Персональные данные: только правлению */
  async debtorsXlsx(): Promise<FileOut> {
    const list = await this.debtors.list()
    const wb = workbook()
    const ws = wb.addWorksheet('Должники', { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = [
      { header: 'Помещение', key: 'unit', width: 12 }, { header: 'Подъезд', key: 'entrance', width: 10 }, { header: 'Собственники', key: 'owners', width: 36 },
      { header: 'Долг, ₸', key: 'debt', width: 15, style: { numFmt: '#,##0.00' } }, { header: 'Месяцев', key: 'months', width: 10 },
      { header: 'С какого месяца', key: 'oldest', width: 16 }, { header: 'Последнее напоминание', key: 'reminded', width: 22 },
    ]
    for (const d of list) {
      ws.addRow({ unit: d.unit.number, entrance: d.unit.entrance, owners: d.owners.map((o) => o.name).join(', '), debt: d.debt, months: d.months, oldest: d.oldest_period, reminded: d.last_reminded_at ? day(d.last_reminded_at) : '' })
    }
    styleHeader(ws)
    ws.addRow({ owners: 'Итого', debt: list.reduce((s, d) => s + d.debt, 0) }).font = { bold: true }
    return { body: Buffer.from(await wb.xlsx.writeBuffer()), name: `Должники ${new Date().toISOString().slice(0, 10)}.xlsx`, type: XLSX }
  }

  private async reportHash(id: string): Promise<string> {
    const r = await this.db.run((tx) => tx.report.findFirst({ where: { id }, select: { dataHash: true } }))
    return r ? Buffer.from(r.dataHash).toString('hex').slice(0, 16) : ''
  }

  private log(action: string, entityType: string, entityId: string | undefined, after?: object) {
    return this.db.run((tx) => this.audit.append(tx, { action, entityType, entityId, after }))
  }
}

const houseIdOrEmpty = () => ctx().houseId ?? ''

function header(pdf: Pdf, h: ReportView['header']) {
  pdf.fields([
    ['Адрес объекта кондоминиума', h.address],
    ['Форма управления', h.management_form],
    ['Наименование', h.organization],
    ['БИН', h.bin],
    ['Юридический адрес', h.legal_address],
    ['Отчётный период', `${day(h.period_from)} — ${day(h.period_to)}`],
    ['Текущий счёт', h.banks.CURRENT ?? '—'],
    ['Сберегательный счёт', h.banks.SAVINGS ?? '—'],
  ])
}

function rowsTable(pdf: Pdf, rows: ReportRow[]) {
  pdf.heading('Показатели')
  const out: { cells: string[]; bold?: boolean; indent?: number }[] = []
  for (const r of rows) {
    out.push({ cells: [r.code, r.label, tenge(r.amount)], bold: r.level === 0, indent: r.level * 10 })
    for (const l of r.lines ?? []) out.push({ cells: ['', `${l.service}: ${l.payee}`, tenge(l.amount)], indent: (r.level + 1) * 10 })
  }
  pdf.table([{ label: 'Код', width: 12 }, { label: 'Наименование показателя', width: 64 }, { label: 'Сумма, ₸', width: 24, align: 'right' }], out)
}

function workList(pdf: Pdf, work: ReportView['work']) {
  if (!work.length) return
  pdf.heading('Выполненные работы')
  pdf.table(
    [{ label: '№', width: 6 }, { label: 'Работа', width: 70 }, { label: 'Принята', width: 24 }],
    work.map((w, i) => ({ cells: [String(i + 1), `${w.title}${w.photo_file_ids.length ? ` (фото: ${w.photo_file_ids.length})` : ''}`, day(w.completed_at)] })),
  )
}

/** Протокол в порядке, который ждёт суд: созыв, кворум, повестка, итоги по каждому вопросу, подписи */
export function protocolDocument(p: ProtocolView): Pdf {
  const c = p.content
  const pdf = new Pdf(`Протокол №${p.number}`, `Ortaq · SHA-256 ${p.content_hash.slice(0, 16)} · хранить до ${day(p.retention_until)}`)
    .title(`Протокол №${p.number}`, `собрания собственников квартир и нежилых помещений · ${c.house.address}`)
  pdf.fields([
    ['Форма проведения', LEGAL_BASIS_LABEL[c.vote.legal_basis]],
    ['Вопрос', c.vote.title],
    ['Тип решения', `${DECISION_LABEL[c.vote.decision_type]} · порог: ${THRESHOLD_LABEL[c.vote.threshold]}`],
    ['Уведомление разослано', dayTime(c.dates.notice_sent_at)],
    ['Голосование', `${dayTime(c.dates.starts_at)} — ${dayTime(c.dates.ends_at)}`],
    ['Всего помещений / площадь', `${c.quorum.total_units} / ${c.quorum.total_area.toLocaleString('ru-RU')} м²`],
    ['Проголосовало', `${c.quorum.cast_units} помещений, ${c.quorum.cast_area.toLocaleString('ru-RU')} м² — ${c.quorum.percent}%`],
    ['Кворум', c.quorum.quorum_reached ? 'есть, собрание правомочно' : 'нет, решения не принимались'],
  ])
  if (c.vote.description) pdf.text(c.vote.description, { muted: true })
  pdf.heading('Итоги голосования')
  for (const q of c.results) {
    pdf.text(`${q.order}. ${q.text}`, { bold: true })
    pdf.table(
      [{ label: 'Вариант', width: 52 }, { label: 'Помещений', width: 14, align: 'right' }, { label: 'Площадь, м²', width: 17, align: 'right' }, { label: '%', width: 17, align: 'right' }],
      q.options.map((o) => ({ cells: [o.text, String(o.units), o.area.toLocaleString('ru-RU'), `${o.percent}%`] })),
    )
    pdf.text(q.adopted === null ? 'Решение не принималось: нет кворума' : q.adopted ? 'Решение принято' : 'Решение не принято', { bold: true, size: 9.5 })
  }
  if (c.paper.units) pdf.text(`Бумажных бюллетеней: ${c.paper.units} (${c.paper.percent_of_cast}% поданных), внесены председателем со сканами.${c.paper.note ? ` ${c.paper.note}` : ''}`, { muted: true, size: 9 })
  pdf.heading('Лист участников')
  pdf.table(
    [{ label: 'Помещение', width: 13 }, { label: 'Собственник', width: 37 }, { label: 'Площадь', width: 12, align: 'right' }, { label: 'Способ', width: 14 }, { label: 'Время', width: 24 }],
    c.participants.map((v) => ({ cells: [v.unit_number, v.voter_name, v.area.toLocaleString('ru-RU'), v.channel === 'PAPER' ? 'бумажный' : `ЭЦП${v.cert_serial ? ` ${v.cert_serial.slice(-6)}` : ''}`, dayTime(v.cast_at)] })),
  )
  pdf.text(`Уведомлено пользователей: ${c.notice.notified_users}; помещений собственников без приложения: ${c.notice.units_without_owner_in_app}. Снимок реестра: ${c.snapshot.entries_hash.slice(0, 16)}.`, { muted: true, size: 9 })
  pdf.signatures([
    { role: 'Председатель собрания', name: p.signatures.chairman?.name ?? null, signedAt: p.signatures.chairman ? dayTime(p.signatures.chairman.signed_at) : null },
    { role: 'Секретарь', name: p.signatures.secretary?.name ?? null, signedAt: p.signatures.secretary ? dayTime(p.signatures.secretary.signed_at) : null },
  ])
  return pdf
}

function workbook() {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Ortaq'
  wb.created = new Date()
  return wb
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const h = ws.getRow(1)
  h.font = { bold: true }
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEEB' } }
  h.alignment = { vertical: 'middle', wrapText: true }
}

async function reportWorkbook(title: string, h: ReportView['header'], rows: ReportRow[], work: ReportView['work']): Promise<Buffer> {
  const wb = workbook()
  const ws = wb.addWorksheet(title.slice(0, 31))
  ws.columns = [{ width: 12 }, { width: 70 }, { width: 18, style: { numFmt: '#,##0.00' } }]
  ws.addRow(['', 'Отчёт об управлении объектом кондоминиума']).font = { bold: true, size: 13 }
  for (const [k, v] of [['Адрес', h.address], ['Наименование', h.organization], ['БИН', h.bin], ['Период', `${day(h.period_from)} — ${day(h.period_to)}`]] as const) ws.addRow([k, v])
  ws.addRow([])
  const head = ws.addRow(['Код', 'Наименование показателя', 'Сумма, ₸'])
  head.font = { bold: true }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEEB' } }
  for (const r of rows) {
    const row = ws.addRow([r.code, r.label, r.amount])
    row.getCell(2).alignment = { indent: r.level * 2, wrapText: true }
    if (r.level === 0) row.font = { bold: true }
    for (const l of r.lines ?? []) ws.addRow(['', `${l.service}: ${l.payee}`, l.amount]).getCell(2).alignment = { indent: (r.level + 1) * 2, wrapText: true }
  }
  if (work.length) {
    const ws2 = wb.addWorksheet('Выполненные работы')
    ws2.columns = [{ header: 'Работа', key: 'title', width: 60 }, { header: 'Принята', key: 'at', width: 14 }, { header: 'Фото', key: 'photos', width: 8 }]
    for (const w of work) ws2.addRow({ title: w.title, at: day(w.completed_at), photos: w.photo_file_ids.length })
    styleHeader(ws2)
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
