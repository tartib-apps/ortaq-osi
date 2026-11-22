import { Injectable } from '@nestjs/common'
import type { LegalQuestion } from '@prisma/client'
import { legalAskBody, type LegalAnswer, type LegalAskBody, type LegalCitation } from '@ortaq/shared'
import { randomUUID } from 'node:crypto'
import { ctx } from '../../common/context'
import { PrismaService, type Tx } from '../../infra/prisma.service'
import { AiService } from '../../integrations/ai/ai.service'
import { redact } from '../../integrations/ai/redactor'
import { AuditService } from '../audit/audit.service'
import { toVector } from './legal-corpus'

const TOP_K = 5
const CANDIDATES = 12
/** Длинные статьи (ст. 42 — десятки пунктов) режем: модели хватает предмета и ключевых пунктов */
const ARTICLE_CHARS = 9000
const RRF_K = 60
const DISCLAIMER = 'Не заменяет юридическую консультацию. Проверьте актуальную редакцию закона по ссылке.'
const NOT_FOUND = 'Не нашёл основания в законодательстве по этому вопросу. Попробуйте переформулировать или обратитесь к юристу.'

type Chunk = { id: string; article: string; title: string; content: string; document: string; source_url: string }

/**
 * Юридический помощник (docs/11 §3.6): поиск статей → ответ только по ним → проверка ссылок.
 * Жёсткое правило: нет статей или ни одной проверяемой цитаты — «не нашёл основания», а не текст
 * от себя. Председатель сошлётся на ответ на собрании; выдуманная норма хуже отсутствия ответа.
 */
@Injectable()
export class LegalService {
  constructor(
    private readonly db: PrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  async ask(input: LegalAskBody): Promise<LegalAnswer> {
    const { question } = legalAskBody.parse(input)
    const names = await this.db.run(async (tx) => (await tx.houseMembership.findMany({ where: { status: 'ACTIVE' }, select: { user: { select: { fullName: true } } } }))
      .map((m) => m.user.fullName).filter((n): n is string => !!n))
    const redacted = redact(question, names).text
    const chunks = await this.search(redacted)
    const houseId = ctx().houseId ?? ''

    let answer: Omit<LegalAnswer, 'id' | 'question' | 'created_at'> = { found: false, answer: NOT_FOUND, citations: [], confidence: 'LOW', suggested_action: null, disclaimer: DISCLAIMER }
    let jobId: string | null = null
    if (chunks.length) {
      const articles = chunks.map((c, i) => ({ ref: i + 1, document: c.document, article: c.article, title: c.title, content: c.content.slice(0, ARTICLE_CHARS) }))
      const res = await this.ai.legal(houseId, randomUUID(), { question: redacted, articles })
      jobId = res.jobId
      const citations = verify(res.value.citations, chunks)
      answer = res.value.found && citations.length
        ? {
          found: true, answer: res.value.answer, citations, confidence: res.value.confidence,
          suggested_action: res.value.suggested_vote_decision_type ? { type: 'CREATE_VOTE', decision_type: res.value.suggested_vote_decision_type } : null,
          disclaimer: DISCLAIMER,
        }
        // Без модели или без проверяемой цитаты — только статьи, ближе всего к вопросу
        : { ...answer, answer: this.ai.capable ? NOT_FOUND : res.value.answer, citations: this.ai.capable ? [] : citations, found: !this.ai.capable && citations.length > 0 }
    }
    const row = await this.db.run(async (tx) => {
      const q = await tx.legalQuestion.create({ data: { houseId, askedBy: ctx().userId ?? '', question, answer, aiJobId: jobId } })
      await this.audit.append(tx, { action: 'legal.ask', entityType: 'LegalQuestion', entityId: q.id, after: { found: answer.found, citations: answer.citations.map((c) => c.article) } })
      return q
    })
    return view(row)
  }

  async history(): Promise<LegalAnswer[]> {
    const rows = await this.db.run((tx) => tx.legalQuestion.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }))
    return rows.map(view)
  }

  /**
   * Гибридный поиск: полнотекстовый (работает всегда) и векторный (если есть эмбеддинги),
   * объединённые по рангу (RRF). Полнотекстовый ловит точные слова закона, векторный — смысл
   */
  private async search(question: string): Promise<Chunk[]> {
    const [vector] = (await this.ai.embed([question], 'query')) ?? []
    return this.db.run(async (tx) => {
      const text = await textSearch(tx, question)
      const semantic = vector ? await tx.$queryRaw<{ id: string }[]>`
        SELECT c.id FROM legal_chunks c JOIN legal_documents d ON d.id = c.document_id
        WHERE d.is_current AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${toVector(vector)}::vector LIMIT ${CANDIDATES}` : []
      const score = new Map<string, number>()
      text.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + i)))
      semantic.forEach((r, i) => score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + i)))
      const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_K).map(([id]) => id)
      if (!top.length) return []
      const rows = await tx.$queryRaw<Chunk[]>`
        SELECT c.id, c.article, c.title, c.content, d.short_title AS document, d.source_url
        FROM legal_chunks c JOIN legal_documents d ON d.id = c.document_id WHERE c.id = ANY(${top}::uuid[])`
      return top.map((id) => rows.find((r) => r.id === id)!).filter(Boolean)
    })
  }
}

/** Слова вопроса через OR: «кворум собрание капремонт» находит статьи, где есть хотя бы часть слов */
async function textSearch(tx: Tx, question: string): Promise<{ id: string }[]> {
  const terms = [...new Set(question.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 20)
  if (!terms.length) return []
  return tx.$queryRaw<{ id: string }[]>`
    SELECT c.id FROM legal_chunks c JOIN legal_documents d ON d.id = c.document_id,
      to_tsquery('russian', ${terms.map((t) => `'${t.replace(/'/g, '')}'`).join(' | ')}) q
    WHERE d.is_current AND c.tsv @@ q
    ORDER BY ts_rank_cd(c.tsv, q) DESC LIMIT ${CANDIDATES}`
}

/**
 * Ссылка — только на переданную статью; цитата — только дословный текст статьи. Модель часто
 * пересказывает норму: тогда подставляем фразу статьи, ближе всего совпадающую со словами модели.
 * Нет такой фразы — ссылка отбрасывается.
 */
export function verify(citations: { ref: number; quote: string }[], chunks: Chunk[]): LegalCitation[] {
  const seen = new Set<string>()
  const out: LegalCitation[] = []
  for (const c of citations) {
    const chunk = chunks[c.ref - 1]
    if (!chunk || seen.has(chunk.id)) continue
    const quote = verbatim(c.quote, chunk.content)
    if (!quote) continue
    seen.add(chunk.id)
    out.push({ document: chunk.document, article: chunk.article, title: chunk.title, quote, source_url: chunk.source_url })
  }
  return out
}

const MIN_OVERLAP = 0.6
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function verbatim(quote: string, content: string): string | null {
  const q = quote.replace(/^[.…\s]+|[.…\s]+$/g, '')
  if (q.length < 10) return null
  if (norm(content).includes(norm(q))) return q
  const want = new Set(norm(q).split(' ').filter((w) => w.length > 3).map((w) => w.slice(0, 6)))
  if (want.size < 3) return null
  let best: { sentence: string; score: number } | null = null
  for (const sentence of content.split(/(?<=[.;:])\s+|\n/).map((x) => x.trim()).filter((x) => x.length >= 20)) {
    const have = new Set(norm(sentence).split(' ').map((w) => w.slice(0, 6)))
    const score = [...want].filter((w) => have.has(w)).length / want.size
    if (!best || score > best.score) best = { sentence, score }
  }
  return best && best.score >= MIN_OVERLAP ? best.sentence.slice(0, 600) : null
}

function view(q: LegalQuestion): LegalAnswer {
  const a = q.answer as Omit<LegalAnswer, 'id' | 'question' | 'created_at'>
  return { id: q.id, question: q.question, ...a, created_at: q.createdAt.toISOString() }
}
