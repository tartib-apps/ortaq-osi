import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  AI_LIMITS, createComparisonBody, decideComparisonBody, ErrorCode,
  type ComparisonView, type CreateComparisonBody, type DecideComparisonBody, type ParsedProposal, type ProposalAnalysis,
} from '@ortaq/shared'
import { ctx } from '../../common/context'
import { AppError, notFound, unprocessable } from '../../common/errors'
import { PrismaService } from '../../infra/prisma.service'
import { AiService } from '../../integrations/ai/ai.service'
import { pdfText } from '../../integrations/ai/pdf-text'
import { STORAGE_PROVIDER, type StorageProvider } from '../../integrations/storage/storage.provider'
import { AuditService } from '../audit/audit.service'
import { FilesService } from '../files/files.service'

const include = { proposals: { orderBy: { order: 'asc' } } } satisfies Prisma.ProposalComparisonInclude
type Row = Prisma.ProposalComparisonGetPayload<{ include: typeof include }>

const NO_TEXT = '(в документе нет текстового слоя — вероятно, это скан. Значения нужно взять из документа вручную)'
/** Обязательное предупреждение (docs/11 §3.5): речь о миллионах тенге и PDF, которые модель могла прочитать неточно */
const MANUAL_CHECK = 'Проверьте цифры по самим документам: модель могла прочитать PDF неточно. Решение о подрядчике — за председателем и собранием.'

/**
 * Сравнение коммерческих предложений (docs/11 §3.5). Модель получает обезличенный текстовый слой,
 * а не файл. Выбор подрядчика — действие председателя; крупный расход дальше выносится на голосование.
 */
@Injectable()
export class ProposalsService {
  private readonly log = new Logger('Proposals')

  constructor(
    private readonly db: PrismaService,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async create(input: CreateComparisonBody): Promise<ComparisonView> {
    const b = createComparisonBody.parse(input)
    const userId = ctx().userId ?? ''
    const ids = [...new Set(b.file_ids)]
    if (ids.length < 2) throw unprocessable(ErrorCode.VALIDATION, 'Нужно хотя бы два разных предложения')
    const comparison = await this.db.run(async (tx) => {
      const c = await tx.proposalComparison.create({ data: { houseId: ctx().houseId ?? '', title: b.title, subject: b.subject ?? null, createdBy: userId } })
      await this.files.attach(tx, ids, 'COMPARISON', c.id, userId, 'PROPOSAL')
      await tx.commercialProposal.createMany({ data: ids.map((fileId, order) => ({ houseId: c.houseId, comparisonId: c.id, order, fileId })) })
      await this.audit.append(tx, { action: 'comparison.create', entityType: 'ProposalComparison', entityId: c.id, after: { title: c.title, proposals: ids.length } })
      return tx.proposalComparison.findFirstOrThrow({ where: { id: c.id }, include })
    })
    void this.process(comparison.id)
    return this.view(comparison)
  }

  async retry(id: string): Promise<ComparisonView> {
    const c = await this.find(id)
    if (c.status !== 'FAILED') throw new AppError(409, ErrorCode.AI_STATE, 'Повторить можно только неудавшееся сравнение')
    await this.db.run((tx) => tx.proposalComparison.update({ where: { id }, data: { status: 'PROCESSING', error: null } }))
    void this.process(id)
    return this.view(await this.find(id))
  }

  async list(): Promise<ComparisonView[]> {
    const rows = await this.db.run((tx) => tx.proposalComparison.findMany({ include, orderBy: { createdAt: 'desc' }, take: 30 }))
    return Promise.all(rows.map((r) => this.view(r)))
  }

  async detail(id: string): Promise<ComparisonView> {
    return this.view(await this.find(id))
  }

  /** Выбор председателя. Совпал с рекомендацией — подсказка принята, иначе — исправлена */
  async decide(id: string, input: DecideComparisonBody): Promise<ComparisonView> {
    const b = decideComparisonBody.parse(input)
    const c = await this.find(id)
    if (c.status !== 'DONE' && c.status !== 'FAILED') throw new AppError(409, ErrorCode.AI_STATE, c.status === 'DECIDED' ? 'Подрядчик уже выбран' : 'Сравнение ещё не готово')
    const chosen = c.proposals.find((p) => p.id === b.proposal_id)
    if (!chosen) throw unprocessable(ErrorCode.VALIDATION, 'Предложение не из этого сравнения')
    await this.db.run(async (tx) => {
      await tx.proposalComparison.update({ where: { id }, data: { status: 'DECIDED', decidedProposalId: chosen.id, decidedBy: ctx().userId ?? null, decidedAt: new Date(), decisionNote: b.note ?? null } })
      await this.audit.append(tx, { action: 'comparison.decide', entityType: 'ProposalComparison', entityId: id, after: { proposal: chosen.order + 1, contractor: chosen.contractorName, recommended: c.recommendedIndex === null ? null : c.recommendedIndex + 1 } })
    })
    if (c.recommendedIndex !== null) await this.ai.decide(c.aiJobId, chosen.order === c.recommendedIndex ? 'ACCEPTED' : 'MODIFIED')
    return this.view(await this.find(id))
  }

  private async process(id: string): Promise<void> {
    try {
      const { c, files, names } = await this.db.run(async (tx) => {
        const c = await tx.proposalComparison.findFirstOrThrow({ where: { id }, include })
        const files = await tx.file.findMany({ where: { id: { in: c.proposals.map((p) => p.fileId) } } })
        const members = await tx.houseMembership.findMany({ where: { status: 'ACTIVE' }, select: { user: { select: { fullName: true } } } })
        return { c, files, names: members.map((m) => m.user.fullName).filter((n): n is string => !!n) }
      })
      const perDoc = Math.floor(AI_LIMITS.inputChars / c.proposals.length)
      const documents = await Promise.all(c.proposals.map(async (p) => {
        const file = files.find((f) => f.id === p.fileId)
        const body = file && (await this.storage.read(file.storageKey, AI_LIMITS.proposalFileBytes))
        const text = body ? await pdfText(body, perDoc).catch((e: unknown) => {
          this.log.warn(`Текст КП не извлечён: ${e instanceof Error ? e.message : String(e)}`)
          return ''
        }) : ''
        return { index: p.order, text: text || NO_TEXT }
      }))
      const res = await this.ai.proposals(c.houseId, c.id, { subject: c.subject, documents }, names)
      const analysis = normalize(res.value, c.proposals.length, documents.filter((d) => d.text === NO_TEXT).map((d) => d.index))
      await this.db.run(async (tx) => {
        for (const p of c.proposals) {
          const parsed = analysis.proposals[p.order]!
          await tx.commercialProposal.update({ where: { id: p.id }, data: { parsed, contractorName: parsed.contractor_name } })
        }
        await tx.proposalComparison.update({
          where: { id },
          data: { status: 'DONE', analysis, recommendedIndex: analysis.recommendation.proposal_index, aiJobId: res.jobId },
        })
      })
    } catch (e) {
      const message = e instanceof AppError ? e.message : 'Не удалось разобрать предложения. Повторите позже или сравните вручную'
      if (!(e instanceof AppError)) this.log.error(e instanceof Error ? e.stack : String(e))
      await this.db.run((tx) => tx.proposalComparison.update({ where: { id }, data: { status: 'FAILED', error: message } })).catch(() => undefined)
    }
  }

  private async find(id: string): Promise<Row> {
    const c = await this.db.run((tx) => tx.proposalComparison.findFirst({ where: { id }, include }))
    if (!c) throw notFound('Сравнение')
    return c
  }

  private async view(c: Row): Promise<ComparisonView> {
    const files = await this.db.run((tx) => tx.file.findMany({ where: { id: { in: c.proposals.map((p) => p.fileId) } }, select: { id: true, originalName: true } }))
    const byOrder = (i: number | null) => (i === null ? null : c.proposals.find((p) => p.order === i)?.id ?? null)
    return {
      id: c.id, title: c.title, subject: c.subject, status: c.status, error: c.error,
      analysis: c.analysis as ProposalAnalysis | null,
      recommended_proposal_id: byOrder(c.recommendedIndex), decided_proposal_id: c.decidedProposalId,
      decided_at: c.decidedAt?.toISOString() ?? null, decision_note: c.decisionNote,
      proposals: c.proposals.map((p) => ({
        id: p.id, order: p.order, file_id: p.fileId, file_name: files.find((f) => f.id === p.fileId)?.originalName ?? 'КП.pdf',
        contractor_name: p.contractorName, parsed: p.parsed as ParsedProposal | null,
      })),
      created_at: c.createdAt.toISOString(),
    }
  }
}

/**
 * Ответ модели к виду, на который можно положиться: ровно по одному разбору на документ в порядке
 * загрузки, индексы рекомендации и «лучших» значений — только существующие
 */
function normalize(out: Awaited<ReturnType<AiService['proposals']>>['value'], count: number, unreadable: number[]): ProposalAnalysis {
  const valid = (i: number | null) => (i !== null && i >= 0 && i < count ? i : null)
  const proposals: ParsedProposal[] = Array.from({ length: count }, (_, index) => {
    const p = out.proposals.find((x) => x.index === index)
    return {
      contractor_name: p?.contractor_name ?? null, total_price: p?.total_price ?? null, currency: !p?.currency || /тенге|тг|₸|kzt/i.test(p.currency) ? 'KZT' : p.currency,
      duration_days: p?.duration_days ?? null, warranty_months: p?.warranty_months ?? null, prepayment_percent: p?.prepayment_percent ?? null,
      includes: p?.includes ?? [], excludes: p?.excludes ?? [], hidden_costs: p?.hidden_costs ?? [], payment_terms: p?.payment_terms ?? null,
    }
  })
  return {
    proposals,
    comparison: out.comparison.map((row) => ({ criterion: row.criterion, values: Array.from({ length: count }, (_, i) => row.values[i] ?? '—'), best_index: valid(row.best_index) })),
    recommendation: { ...out.recommendation, proposal_index: valid(out.recommendation.proposal_index) },
    warnings: [
      ...unreadable.map((i) => `Предложение №${i + 1}: текст не извлечён (скан). Сверьте его вручную`),
      ...out.warnings,
      MANUAL_CHECK,
    ],
  }
}
