import type { Priority, RequestCategory, RequestPlan, RequestTriage } from '@ortaq/shared'
import type { Specialization } from '@ortaq/shared'
import { AiUnavailableError, type AiOut, type AiProvider, type LegalInput, type ProposalsInput, type SuggestInput, type SummaryFacts, type TriageInput, type VoiceInput } from './ai.provider'
import type { LegalAnswerOut, ProposalAnalysisOut, SummaryOut, VoiceExtractionOut } from './schemas'

/*
 * Заглушка модели для разработки и тестов: правила по ключевым словам вместо Gemini.
 * Контракт тот же, поэтому весь путь — обезличивание, журнал AiJob, подсказка председателю —
 * работает до подключения настоящей модели. Ключевые слова — по-русски и по-казахски.
 */

const CATEGORY_WORDS: [RequestCategory, RegExp][] = [
  ['ELEVATOR', /лифт/i],
  ['HEATING', /отоплен|батаре|радиатор|холодно в|жылу/i],
  ['PLUMBING', /труб|теч[ьёе]|протека|капа|канализ|унитаз|кран|стояк|су ақ|вода/i],
  ['ELECTRICITY', /свет|ламп|электр|розетк|провод|искр|щиток|жарық/i],
  ['TRASH', /мусор|бак|контейнер|қоқыс/i],
  ['CLEANING', /уборк|грязн|убрать|мыть|пыль|тазала/i],
  ['ROOF', /крыш|кровл|сосульк/i],
  ['BASEMENT', /подвал|жертөле/i],
  ['FACADE', /фасад|стен[аы] дома|балкон/i],
  ['SECURITY', /домофон|двер|замок|камер|охран|посторонн/i],
  ['YARD', /двор|площадк|газон|парковк|аула/i],
]

const CRITICAL = /прорыв|затоп|потоп|пожар|дым|горит|искрит|запах газа|газом пахнет|застрял|кипят|обрушен|оборван|нет отопления/i
const HIGH = /не работает лифт|лифт не работает|нет воды|нет света|течь|теч[её]т|протека|не греет|холодно|сломан/i
const LOW = /покрас|царапин|косметич|некрасив|пожелание|предлагаю/i
/** Попытки командовать модели из текста заявки — признак спама или атаки (docs/11 §1, правило 2) */
export const INJECTION = /игнорир|ignore (all|previous)|system prompt|ты теперь|you are now|https?:\/\//i

const PLAN: Partial<Record<RequestCategory, { title: string; specialization: Specialization | null; urgency: RequestPlan['steps'][number]['urgency'] }[]>> = {
  PLUMBING: [
    { title: 'Перекрыть воду на участке', specialization: 'PLUMBER', urgency: 'IMMEDIATE' },
    { title: 'Осмотреть и определить объём работ', specialization: 'PLUMBER', urgency: 'TODAY' },
    { title: 'Закупить материалы', specialization: null, urgency: 'THIS_WEEK' },
    { title: 'Устранить неисправность', specialization: 'PLUMBER', urgency: 'THIS_WEEK' },
    { title: 'Проверить и составить акт', specialization: null, urgency: 'THIS_WEEK' },
  ],
  ELECTRICITY: [
    { title: 'Обесточить участок', specialization: 'ELECTRICIAN', urgency: 'IMMEDIATE' },
    { title: 'Найти причину неисправности', specialization: 'ELECTRICIAN', urgency: 'TODAY' },
    { title: 'Заменить неисправное оборудование', specialization: 'ELECTRICIAN', urgency: 'THIS_WEEK' },
    { title: 'Проверить работу', specialization: null, urgency: 'THIS_WEEK' },
  ],
  ELEVATOR: [
    { title: 'Вызвать обслуживающую организацию', specialization: 'ELEVATOR', urgency: 'IMMEDIATE' },
    { title: 'Диагностика и ремонт', specialization: 'ELEVATOR', urgency: 'TODAY' },
    { title: 'Получить акт о вводе в работу', specialization: null, urgency: 'THIS_WEEK' },
  ],
}

const DEFAULT_PLAN = [
  { title: 'Осмотреть на месте', specialization: 'HANDYMAN' as const, urgency: 'TODAY' as const },
  { title: 'Выполнить работы', specialization: 'HANDYMAN' as const, urgency: 'THIS_WEEK' as const },
  { title: 'Проверить результат', specialization: null, urgency: 'THIS_WEEK' as const },
]

const SPECIALIZATION: Partial<Record<RequestCategory, Specialization>> = {
  PLUMBING: 'PLUMBER', HEATING: 'PLUMBER', BASEMENT: 'PLUMBER', ELECTRICITY: 'ELECTRICIAN', ELEVATOR: 'ELEVATOR',
  CLEANING: 'CLEANER', TRASH: 'CLEANER', YARD: 'YARD_KEEPER', SECURITY: 'SECURITY',
}

/** Слова текста для сравнения: нижний регистр, без коротких служебных */
export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4).map((w) => w.slice(0, 6)))
}

export function similarity(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  if (x.size === 0 || y.size === 0) return 0
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.min(x.size, y.size)
}

export class RulesAiProvider implements AiProvider {
  readonly name: string = 'rules'
  readonly model: string = 'ortaq-rules-1'
  readonly capable: boolean = false

  async triage(input: TriageInput): Promise<AiOut<RequestTriage>> {
    return { value: this.triageRules(input) }
  }

  private triageRules(input: TriageInput): RequestTriage {
    const text = input.text
    const letters = text.match(/\p{L}+/gu) ?? []
    const injection = INJECTION.test(text)
    const meaningful = letters.filter((w) => w.length >= 3).length >= 2 && !injection
    const detected = CATEGORY_WORDS.find(([, re]) => re.test(text))?.[0]
    const priority: Priority = CRITICAL.test(text) ? 'CRITICAL' : HIGH.test(text) ? 'HIGH' : LOW.test(text) ? 'LOW' : 'NORMAL'
    const best = input.candidates
      .map((c) => ({ c, score: similarity(text, c.text) }))
      .sort((a, b) => b.score - a.score)[0]
    const duplicate = best && best.score >= 0.5 ? best : null
    const vague = !detected && input.category === 'OTHER'

    return {
      is_meaningful: meaningful,
      category: detected ?? input.category,
      suggested_priority: priority,
      priority_reason: {
        CRITICAL: 'Риск аварии или ущерба имуществу — нужна реакция сразу',
        HIGH: 'Существенное неудобство для жильцов',
        NORMAL: 'Обычная бытовая неисправность',
        LOW: 'Косметический вопрос, можно запланировать',
      }[priority],
      duplicate_of: duplicate?.c.number ?? null,
      duplicate_confidence: duplicate ? Math.round(duplicate.score * 100) / 100 : 0,
      needs_clarification: meaningful && (vague || text.trim().length < 15),
      clarification_hint: vague ? 'Уточните, что именно сломалось и где' : text.trim().length < 15 ? 'Опишите проблему подробнее' : null,
      spam_likelihood: injection ? 0.9 : meaningful ? 0.05 : 0.6,
    }
  }

  async suggest(input: SuggestInput): Promise<AiOut<RequestPlan>> {
    const steps = PLAN[input.category] ?? DEFAULT_PLAN
    return { value: {
      steps: steps.map((s, i) => ({ order: i + 1, ...s })),
      estimated_specialization: SPECIALIZATION[input.category] ?? 'HANDYMAN',
      safety_notes: input.category === 'ELECTRICITY' ? ['Работы только при снятом напряжении'] : input.category === 'PLUMBING' ? ['Проверить, не подтоплена ли электрощитовая'] : [],
      requires_contractor: input.category === 'ELEVATOR',
    } }
  }

  /** Речь правилами не распознать: голосовое сохраняется и ждёт модели (docs/11 §4) */
  async extractVoiceTasks(_input: VoiceInput): Promise<AiOut<VoiceExtractionOut>> {
    throw new AiUnavailableError('Распознавание речи недоступно: модель не подключена')
  }

  /** Грубое извлечение цифр из текста КП — чтобы председатель видел таблицу и без модели */
  async compareProposals(input: ProposalsInput): Promise<AiOut<ProposalAnalysisOut>> {
    const proposals = input.documents.map((d) => parseProposal(d.index, d.text))
    const priced = proposals.filter((p) => p.total_price !== null)
    const cheapest = priced.sort((a, b) => (a.total_price ?? 0) - (b.total_price ?? 0))[0]
    const best = (pick: (p: (typeof proposals)[number]) => number | null, lower: boolean) => {
      const vals = proposals.map(pick)
      const known = vals.filter((v): v is number => v !== null)
      if (!known.length) return null
      const target = lower ? Math.min(...known) : Math.max(...known)
      return vals.indexOf(target)
    }
    const fmt = (v: number | null, unit: string) => (v === null ? '—' : `${v.toLocaleString('ru-RU')} ${unit}`)
    return { value: {
      proposals,
      comparison: [
        { criterion: 'Цена', values: proposals.map((p) => fmt(p.total_price, '₸')), best_index: best((p) => p.total_price, true) },
        { criterion: 'Срок', values: proposals.map((p) => fmt(p.duration_days, 'дн.')), best_index: best((p) => p.duration_days, true) },
        { criterion: 'Гарантия', values: proposals.map((p) => fmt(p.warranty_months, 'мес.')), best_index: best((p) => p.warranty_months, false) },
        { criterion: 'Предоплата', values: proposals.map((p) => fmt(p.prepayment_percent, '%')), best_index: best((p) => p.prepayment_percent, true) },
      ],
      recommendation: {
        proposal_index: cheapest ? cheapest.index : null,
        reasoning: cheapest ? 'Модель недоступна: показано предложение с наименьшей найденной ценой. Сравните объём работ вручную.' : 'Модель недоступна, цены в документах не найдены. Сравните предложения вручную.',
        risks: [],
      },
      warnings: ['Сравнение выполнено без модели — по найденным в тексте цифрам. Проверьте каждое предложение вручную.'],
    } }
  }

  /** Без модели ответ не формулируется — только найденные статьи, чтобы председатель прочитал их сам */
  async answerLegal(input: LegalInput): Promise<AiOut<LegalAnswerOut>> {
    const top = input.articles.slice(0, 3)
    return { value: {
      found: top.length > 0,
      answer: top.length
        ? 'Модель сейчас недоступна, поэтому готового ответа нет. Ниже — статьи закона, которые ближе всего к вашему вопросу.'
        : 'Не нашёл основания в законодательстве по этому вопросу.',
      // Цитата — первая содержательная строка статьи: нумерация пунктов («1.») сама по себе не цитата
      citations: top.map((a) => ({ ref: a.ref, quote: (a.content.split('\n').find((l) => l.length >= 20) ?? a.content).slice(0, 300) })),
      confidence: 'LOW',
      suggested_vote_decision_type: null,
    } }
  }

  async weeklySummary(f: SummaryFacts): Promise<AiOut<SummaryOut>> {
    const parts = [
      f.requests.done ? `Закрыто заявок: ${f.requests.done}` : null,
      f.tasks.approved ? `выполнено работ: ${f.tasks.approved}` : null,
      f.finance.expenses_total ? `расходы дома — ${Math.round(f.finance.expenses_total).toLocaleString('ru-RU')} ₸` : null,
    ].filter(Boolean)
    return { value: {
      summary_text: parts.length ? `За неделю ${f.week.start} — ${f.week.end}. ${parts.join(', ')}.` : `За неделю ${f.week.start} — ${f.week.end} заметных событий не было.`,
      highlights: [...f.tasks.approved_titles, ...f.requests.done_titles].slice(0, 5),
      needs_attention: [
        ...f.votes.active.map((v) => `Идёт голосование «${v.title}», явка ${v.turnout_percent}%`),
        ...(f.requests.open_critical ? [`Открытых аварийных заявок: ${f.requests.open_critical}`] : []),
      ].slice(0, 5),
    } }
  }

  async embed(): Promise<null> {
    return null
  }

  async readReceipt(): Promise<null> {
    return null
  }
}

const num = (s: string) => Number(s.replace(/[\s\u00a0]/g, '').replace(',', '.'))

/** Цифры из текста КП: «Итого: 9 100 000 тенге», «гарантия 36 месяцев», «срок 30 дней», «предоплата 30%» */
export function parseProposal(index: number, text: string): ProposalAnalysisOut['proposals'][number] {
  const flat = text.replace(/\s+/g, ' ')
  const total = flat.match(/(?:итого|всего|общая стоимость|стоимость работ|сумма)[^\d]{0,40}(\d[\d\s\u00a0]{2,}(?:[.,]\d{1,2})?)/i)
  const anyPrice = [...flat.matchAll(/(\d[\d\s\u00a0]{3,}(?:[.,]\d{1,2})?)\s*(?:₸|тенге|тг\b|kzt)/gi)].map((m) => num(m[1]!)).sort((a, b) => b - a)[0]
  const warranty = flat.match(/гаранти\D{0,30}(\d+)\s*(мес|год|лет)/i)
  const duration = flat.match(/(?:срок|в течение)\D{0,30}(\d+)\s*(?:рабоч\S*\s*|календарн\S*\s*)?(дн|недел|мес)/i)
  const prepay = flat.match(/(?:предоплат|аванс)\D{0,30}(\d{1,3})\s*%/i)
  const company = flat.match(/(?:ТОО|ИП|АО)\s*[«"]?([^»",.\n]{2,60})[»"]?/)
  const months = warranty ? Number(warranty[1]) * (/год|лет/i.test(warranty[2]!) ? 12 : 1) : null
  const days = duration ? Number(duration[1]) * (/недел/i.test(duration[2]!) ? 7 : /мес/i.test(duration[2]!) ? 30 : 1) : null
  return {
    index,
    contractor_name: company ? company[0].trim() : null,
    total_price: total ? num(total[1]!) : anyPrice ?? null,
    currency: 'KZT',
    duration_days: days,
    warranty_months: months,
    prepayment_percent: prepay ? Math.min(100, Number(prepay[1])) : null,
    includes: [],
    excludes: [],
    hidden_costs: [],
    payment_terms: null,
  }
}
