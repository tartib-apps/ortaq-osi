import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import type { WeeklySummary } from '@prisma/client'
import type { WeeklySummaryView } from '@ortaq/shared'
import { asSystem, ctx, runWithContext } from '../../common/context'
import { notFound } from '../../common/errors'
import { env } from '../../config/env'
import { PrismaService, type Tx } from '../../infra/prisma.service'
import type { SummaryFacts } from '../../integrations/ai/ai.provider'
import { AiService } from '../../integrations/ai/ai.service'
import { redact } from '../../integrations/ai/redactor'
import type { SummaryOut } from '../../integrations/ai/schemas'
import { AuditService } from '../audit/audit.service'
import { NotificationsService } from '../notifications/notifications.service'

/** Казахстан с 2024 года живёт в одном поясе UTC+5: неделя дома — с понедельника 00:00 по местному */
const OFFSET = '+05:00'
const DAY = 86_400_000
const TITLES = 8
const num = (v: unknown) => Number(v ?? 0)

/** Понедельник прошлой недели и воскресенье — по местному времени */
export function lastWeek(now = new Date()): { start: string; end: string } {
  const local = new Date(now.getTime() + 5 * 3600_000)
  const dow = (local.getUTCDay() + 6) % 7
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - (dow + 7) * DAY)
  const sunday = new Date(monday.getTime() + 6 * DAY)
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) }
}

/**
 * Еженедельная сводка (docs/11 §3.7). Вход — только агрегаты: категории, суммы, явка, названия
 * работ после обезличивания. Сводка про дом, а не про людей. Без модели — короткий текст по цифрам.
 */
@Injectable()
export class SummariesService {
  constructor(
    private readonly db: PrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async latest(): Promise<WeeklySummaryView | null> {
    const s = await this.db.run((tx) => tx.weeklySummary.findFirst({ orderBy: { weekStart: 'desc' } }))
    return s && view(s)
  }

  async list(): Promise<WeeklySummaryView[]> {
    return (await this.db.run((tx) => tx.weeklySummary.findMany({ orderBy: { weekStart: 'desc' }, take: 12 }))).map(view)
  }

  /** Ручной запуск председателем: пересобирает сводку прошлой недели */
  async generateNow(): Promise<WeeklySummaryView> {
    const s = await this.generate(ctx().houseId ?? '', lastWeek(), { manual: true })
    if (!s) throw notFound('Сводка')
    return view(s)
  }

  /** null — сводка за эту неделю уже есть (для планировщика), либо дом не найден */
  async generate(houseId: string, week: { start: string; end: string }, opts: { manual?: boolean } = {}): Promise<WeeklySummary | null> {
    const facts = await this.db.run((tx) => this.facts(tx, week))
    let content: SummaryOut
    let aiJobId: string | null = null
    try {
      const res = await this.ai.summary(houseId, week.start, facts)
      content = res.value
      aiJobId = res.jobId
    } catch {
      // Сводка пропускается только при полном отказе: без модели — текст по тем же цифрам
      content = fallback(facts)
    }
    const weekStart = new Date(week.start)
    const saved = await this.db.run(async (tx) => {
      const existing = await tx.weeklySummary.findFirst({ where: { weekStart } })
      if (existing && !opts.manual) return null
      const data = { weekEnd: new Date(week.end), content, facts, aiJobId, publishedAt: new Date() }
      const s = existing
        ? await tx.weeklySummary.update({ where: { id: existing.id }, data })
        : await tx.weeklySummary.create({ data: { houseId, weekStart, ...data } })
      await this.audit.append(tx, { action: 'summary.publish', entityType: 'WeeklySummary', entityId: s.id, after: { week: week.start, manual: !!opts.manual } })
      return s
    })
    if (saved && !opts.manual) {
      const members = await this.db.run((tx) => tx.houseMembership.findMany({ where: { status: 'ACTIVE' }, select: { userId: true } }))
      await this.notifications.notify({
        userIds: members.map((m) => m.userId), houseId, category: 'SUMMARY', priority: 'LOW',
        title: 'Сводка недели', body: content.summary_text.slice(0, 160), payload: { type: 'summary', id: saved.id },
      })
    }
    return saved
  }

  private async facts(tx: Tx, week: { start: string; end: string }): Promise<SummaryFacts> {
    const from = new Date(`${week.start}T00:00:00${OFFSET}`)
    const to = new Date(new Date(`${week.end}T00:00:00${OFFSET}`).getTime() + DAY)
    const range = { gte: from, lt: to }
    const names = (await tx.houseMembership.findMany({ where: { status: 'ACTIVE' }, select: { user: { select: { fullName: true } } } }))
      .map((m) => m.user.fullName).filter((n): n is string => !!n)
    // Названия пишут жильцы: обезличиваем, как любой текст для модели
    const clean = (t: string) => redact(t, names).text.slice(0, 120)

    const [created, done, critical, approved, overdue, money, active, closed, announcements] = await Promise.all([
      tx.request.count({ where: { createdAt: range, deletedAt: null } }),
      tx.request.findMany({ where: { doneAt: range, status: 'DONE', deletedAt: null }, select: { title: true, category: true } }),
      tx.request.count({ where: { priority: 'CRITICAL', status: { in: ['NEW', 'TRIAGE', 'ACCEPTED', 'IN_PROGRESS'] }, deletedAt: null } }),
      tx.taskCompletion.findMany({ where: { approvedAt: range }, select: { task: { select: { title: true } } } }),
      tx.task.count({ where: { dueAt: { lt: new Date() }, status: { in: ['ASSIGNED', 'IN_PROGRESS'] } } }),
      tx.transaction.groupBy({ by: ['categoryCode', 'direction'], where: { status: 'CONFIRMED', confirmedAt: range }, _sum: { amount: true } }),
      tx.vote.findMany({ where: { status: 'ACTIVE' }, select: { id: true, title: true, endsAt: true } }),
      tx.vote.findMany({ where: { closedAt: range, status: 'CLOSED' }, select: { title: true, protocol: { select: { results: true, quorumReached: true } } } }),
      tx.announcement.count({ where: { publishedAt: range, deletedAt: null } }),
    ])
    const categories = await tx.budgetCategory.findMany({ where: { code: { in: money.map((m) => m.categoryCode) } }, select: { code: true, shortName: true } })
    const byCategory: Record<string, number> = {}
    for (const m of money.filter((x) => x.direction === 'OUT')) {
      const name = categories.find((c) => c.code === m.categoryCode)?.shortName ?? m.categoryCode
      byCategory[name] = (byCategory[name] ?? 0) + num(m._sum.amount)
    }
    const doneByCategory: Record<string, number> = {}
    for (const r of done) doneByCategory[r.category] = (doneByCategory[r.category] ?? 0) + 1
    const turnout = await Promise.all(active.map(async (v) => {
      const w = await tx.ballot.aggregate({ where: { voteId: v.id }, _sum: { weight: true } })
      return { title: clean(v.title), ends_at: v.endsAt?.toISOString().slice(0, 10) ?? '', turnout_percent: Math.round(num(w._sum.weight) * 1000) / 10 }
    }))
    const period = week.end.slice(0, 7)
    const charged = await tx.charge.aggregate({ where: { period, status: { not: 'CANCELLED' } }, _sum: { amount: true, paidAmount: true } })
    const due = num(charged._sum.amount)

    return {
      week,
      requests: { created, done: done.length, open_critical: critical, done_by_category: doneByCategory, done_titles: done.slice(0, TITLES).map((r) => clean(r.title)) },
      tasks: { approved: approved.length, approved_titles: approved.slice(0, TITLES).map((c) => clean(c.task.title)), overdue },
      finance: {
        expenses_total: Object.values(byCategory).reduce((s, v) => s + v, 0),
        expenses_by_category: byCategory,
        income_total: money.filter((m) => m.direction === 'IN').reduce((s, m) => s + num(m._sum.amount), 0),
        collection_rate_percent: due > 0 ? Math.round((num(charged._sum.paidAmount) / due) * 1000) / 10 : null,
      },
      votes: {
        active: turnout,
        closed: closed.map((v) => ({ title: clean(v.title), decided: !!v.protocol?.quorumReached })),
      },
      announcements,
    }
  }
}

/**
 * Понедельник утром — сводка за прошлую неделю для каждого дома. Повторный запуск безопасен:
 * сводка уникальна по дому и неделе
 */
@Injectable()
export class SummariesScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Summaries')
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly db: PrismaService,
    private readonly summaries: SummariesService,
  ) {}

  onApplicationBootstrap() {
    if (env().NODE_ENV === 'test') return
    this.timer = setInterval(() => void this.tick(), 30 * 60_000)
    this.timer.unref()
  }

  onModuleDestroy() {
    clearInterval(this.timer)
  }

  async tick(now = new Date()) {
    const local = new Date(now.getTime() + 5 * 3600_000)
    // Понедельник с 9 утра: к началу рабочей недели жильцы видят итоги прошлой
    if (local.getUTCDay() !== 1 || local.getUTCHours() < 9 || this.running) return
    this.running = true
    try {
      const week = lastWeek(now)
      const houses = await asSystem(() => this.db.run((tx) => tx.house.findMany({
        where: { memberships: { some: { status: 'ACTIVE' } }, summaries: { none: { weekStart: new Date(week.start) } } }, select: { id: true },
      })))
      for (const h of houses) {
        await runWithContext({ houseId: h.id }, () => this.summaries.generate(h.id, week))
          .catch((e: unknown) => this.log.error(`Сводка дома ${h.id}: ${e instanceof Error ? e.message : String(e)}`))
      }
    } finally {
      this.running = false
    }
  }
}

function fallback(f: SummaryFacts): SummaryOut {
  const parts = [
    f.requests.done ? `закрыто заявок — ${f.requests.done}` : null,
    f.tasks.approved ? `выполнено работ — ${f.tasks.approved}` : null,
    f.finance.expenses_total ? `расходы дома — ${Math.round(f.finance.expenses_total).toLocaleString('ru-RU')} ₸` : null,
  ].filter(Boolean)
  return {
    summary_text: parts.length ? `За неделю ${parts.join(', ')}.` : 'За неделю заметных событий не было.',
    highlights: [...f.tasks.approved_titles, ...f.requests.done_titles].slice(0, 5),
    needs_attention: f.votes.active.map((v) => `Идёт голосование «${v.title}», явка ${v.turnout_percent}%`).slice(0, 5),
  }
}

function view(s: WeeklySummary): WeeklySummaryView {
  const c = s.content as SummaryOut
  return {
    id: s.id, week_start: s.weekStart.toISOString().slice(0, 10), week_end: s.weekEnd.toISOString().slice(0, 10),
    summary_text: c.summary_text, highlights: c.highlights, needs_attention: c.needs_attention, published_at: s.publishedAt.toISOString(),
  }
}
