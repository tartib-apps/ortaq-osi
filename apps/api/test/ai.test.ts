import PDFDocument from 'pdfkit'
import { join } from 'node:path'
import type request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LegalInput, ProposalsInput, SummaryFacts, VoiceInput } from '../src/integrations/ai/ai.provider'
import { RulesAiProvider } from '../src/integrations/ai/rules-ai.provider'
import { loadCorpus } from '../src/modules/ai/legal-corpus'
import { matchStaff } from '../src/modules/ai/voice-notes.service'
import { addMember, createApp, login, makeHouse, makeUser, owner, phoneLogin, resetDb, type TestApp } from './helpers'

/**
 * «Модель» для тестов: правила плюс то, что правилами не сделать (речь, ответ по статьям).
 * Запоминает, что получила, — проверяем, что персональные данные до неё не дошли
 */
class FakeModel extends RulesAiProvider {
  override readonly name = 'fake'
  override readonly capable = true
  seen: { proposals?: ProposalsInput; legal?: LegalInput; summary?: SummaryFacts; voice?: VoiceInput } = {}

  override async extractVoiceTasks(i: VoiceInput) {
    this.seen.voice = i
    return {
      value: {
        transcript: 'Серёже — заменить лампу на пятом этаже третьего подъезда сегодня. И проверить давление в отоплении во втором подъезде',
        tasks: [
          { title: 'Заменить лампу на 5 этаже', description: null, specialization: 'ELECTRICIAN' as const, priority: 'NORMAL' as const, location_type: 'ENTRANCE' as const, entrance: 3, floor: 5, location_detail: null, mentioned_assignee: 'Серёже', due_hint: 'сегодня' },
          { title: 'Проверить давление в системе отопления', description: 'жалобы на холодные батареи', specialization: 'PLUMBER' as const, priority: 'HIGH' as const, location_type: 'ENTRANCE' as const, entrance: 2, floor: null, location_detail: null, mentioned_assignee: null, due_hint: null },
        ],
      },
      tokensIn: 900, tokensOut: 200, model: 'fake-1',
    }
  }

  override async compareProposals(i: ProposalsInput) {
    this.seen.proposals = i
    const out = await super.compareProposals(i)
    return { ...out, value: { ...out.value, recommendation: { ...out.value.recommendation, proposal_index: 1 } }, tokensIn: 5000, tokensOut: 800 }
  }

  override async answerLegal(i: LegalInput) {
    this.seen.legal = i
    const first = i.articles[0]!
    return {
      value: {
        found: true,
        answer: 'Да, при соблюдении порядка созыва и кворума.',
        citations: [
          { ref: 1, quote: first.content.split('\n')[0]!.slice(0, 120) },
          // Выдуманная статья и выдуманная цитата не должны дойти до председателя
          { ref: 42, quote: 'Председатель вправе тратить любые суммы без собрания' },
          { ref: 2, quote: 'Этой фразы нет ни в одной статье закона о жилищных отношениях' },
        ],
        confidence: 'HIGH' as const,
        suggested_vote_decision_type: 'CAPITAL_REPAIR' as const,
      },
      tokensIn: 3000, tokensOut: 150,
    }
  }

  override async weeklySummary(f: SummaryFacts) {
    this.seen.summary = f
    return super.weeklySummary(f)
  }
}

const fake = new FakeModel()
let t: TestApp
let plain: TestApp

beforeAll(async () => {
  t = await createApp({ ai: fake })
  plain = await createApp()
  await loadCorpus(owner)
})
afterAll(async () => {
  await t.app.close()
  await plain.app.close()
})
beforeEach(async () => {
  await resetDb()
  t.limiter.reset()
  plain.limiter.reset()
  t.storage.objects.clear()
  plain.storage.objects.clear()
  fake.seen = {}
})

async function setup(app: TestApp = t) {
  const chairman = await makeUser({ fullName: 'Кенжебаев Бауыржан' })
  const { house } = await makeHouse({ chairman })
  const chair = await login(app, chairman)
  const w = await phoneLogin(app, '+77071230003')
  await owner.user.update({ where: { id: w.body.user.id }, data: { fullName: 'Петров Сергей' } })
  await addMember(house.id, w.body.user.id, 'WORKER')
  const r = await phoneLogin(app, '+77071230001')
  await owner.user.update({ where: { id: r.body.user.id }, data: { fullName: 'Асанова Динара' } })
  await addMember(house.id, r.body.user.id, 'RESIDENT')
  return { house, chair, base: `/v1/houses/${house.id}`, worker: { id: w.body.user.id as string }, resident: { agent: r.agent, id: r.body.user.id as string } }
}

type Agent = ReturnType<typeof request.agent>

async function upload(app: TestApp, agent: Agent, houseId: string, purpose: string, mime: string, body: Buffer, name: string) {
  const res = await agent.post(`/v1/houses/${houseId}/files/upload-url`).send({ purpose, mime_type: mime, size_bytes: body.length, name })
  if (res.status !== 201) return { id: null, status: res.status, body: res.body }
  app.storage.putAsClient(res.body.upload_url, body)
  const fin = await agent.post(`/v1/houses/${houseId}/files/${res.body.file_id}/finalize`)
  return { id: res.body.file_id as string, status: fin.status, body: fin.body }
}

/** Заголовок EBML — сервер узнаёт WebM по сигнатуре, а не по заявленному типу */
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)])

/** КП с текстовым слоем, как его сохраняет Word */
function proposalPdf(lines: string[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.font(join(__dirname, '../assets/fonts/NotoSans-Regular.ttf'))
    for (const l of lines) doc.text(l)
    doc.end()
  })
}

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (done(v) || Date.now() - start > ms) return v
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('voice tasks', () => {
  it('extracts candidates, matches the named worker, creates tasks only on confirmation', async () => {
    const s = await setup()
    const audio = await upload(t, s.chair, s.house.id, 'VOICE_NOTE', 'audio/webm', webm(), 'voice.webm')
    expect(audio.status).toBe(200)
    expect(audio.body.mime_type).toBe('audio/webm')

    const created = await s.chair.post(`${s.base}/voice-notes`).send({ audio_file_id: audio.id, duration_sec: 42 })
    expect(created.status).toBe(201)
    const note = await until(() => s.chair.get(`${s.base}/voice-notes/${created.body.id}`), (r) => r.body.status !== 'PROCESSING')
    expect(note.body.status).toBe('EXTRACTED')
    expect(note.body.tasks).toHaveLength(2)
    // «Серёже» → Петров Сергей; модель справочник людей не получала
    expect(note.body.tasks[0].suggested_assignee_id).toBe(s.worker.id)
    expect(JSON.stringify(fake.seen.voice)).not.toContain('Петров')
    expect(await owner.task.count({ where: { houseId: s.house.id } })).toBe(0)

    const confirm = await s.chair.post(`${s.base}/voice-notes/${created.body.id}/confirm-tasks`).send({
      tasks: [{ title: 'Заменить лампу на 5 этаже', specialization: 'ELECTRICIAN', priority: 'NORMAL', assignee_id: s.worker.id }],
    })
    expect(confirm.status).toBe(200)
    expect(confirm.body.status).toBe('REVIEWED')
    const tasks = await owner.task.findMany({ where: { houseId: s.house.id } })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ source: 'FROM_VOICE', voiceNoteId: created.body.id, assigneeId: s.worker.id })
    expect(await owner.notification.findFirst({ where: { userId: s.worker.id, title: 'Новая задача' } })).not.toBeNull()

    // Председатель убрал одну задачу — подсказка исправлена, а не принята
    const job = await owner.aiJob.findFirstOrThrow({ where: { houseId: s.house.id, type: 'VOICE_EXTRACT' } })
    expect(job).toMatchObject({ humanDecision: 'MODIFIED', tokensIn: 900, tokensOut: 200, provider: 'fake' })
    expect((await s.chair.post(`${s.base}/voice-notes/${created.body.id}/confirm-tasks`).send({ tasks: [{ title: 'Ещё раз' }] })).status).toBe(409)
  })

  it('without a model the note is kept and can be retried', async () => {
    const s = await setup(plain)
    const audio = await upload(plain, s.chair, s.house.id, 'VOICE_NOTE', 'audio/webm', webm(), 'voice.webm')
    const created = await s.chair.post(`${s.base}/voice-notes`).send({ audio_file_id: audio.id, duration_sec: 30 })
    const note = await until(() => s.chair.get(`${s.base}/voice-notes/${created.body.id}`), (r) => r.body.status !== 'PROCESSING')
    expect(note.body.status).toBe('FAILED')
    expect(note.body.error).toContain('Запись сохранена')
    expect((await s.chair.post(`${s.base}/voice-notes/${created.body.id}/retry`)).status).toBe(200)
  })

  it('accepts audio only as a chairman voice note and only real audio', async () => {
    const s = await setup()
    expect((await upload(t, s.chair, s.house.id, 'REQUEST_PHOTO', 'audio/webm', webm(), 'x.webm')).status).toBe(400)
    expect((await upload(t, s.resident.agent, s.house.id, 'VOICE_NOTE', 'audio/webm', webm(), 'x.webm')).status).toBe(403)
    const fakeAudio = await upload(t, s.chair, s.house.id, 'VOICE_NOTE', 'audio/webm', Buffer.from('<html>не аудио</html>'.padEnd(64, ' ')), 'x.webm')
    expect(fakeAudio.status).toBe(422)
    expect((await s.chair.post(`${s.base}/voice-notes`).send({ audio_file_id: fakeAudio.id, duration_sec: 601 })).status).toBe(400)
  })

  it('matches a spoken name only when it is unambiguous', () => {
    const staff = [{ id: 'a', name: 'Петров Сергей' }, { id: 'b', name: 'Ерланов Ерлан' }, { id: 'c', name: 'Сергеев Иван' }]
    expect(matchStaff('Ерлан ага', staff)).toBe('b')
    // «Серёже» подходит и Сергею Петрову, и Сергееву — не угадываем
    expect(matchStaff('Серёже', staff)).toBeNull()
    expect(matchStaff('Айгуль', staff)).toBeNull()
  })
})

describe('commercial proposals', () => {
  it('compares redacted text, recommends, and leaves the choice to the chairman', async () => {
    const s = await setup()
    const a = await upload(t, s.chair, s.house.id, 'PROPOSAL', 'application/pdf', await proposalPdf([
      'ТОО «ЛифтСервис»', 'Коммерческое предложение на замену лифта', 'Итого: 8 400 000 тенге', 'Срок выполнения 45 дней', 'Гарантия 12 месяцев', 'Предоплата 50%', 'Директор: +7 701 555 12 34',
    ]), 'kp-1.pdf')
    const b = await upload(t, s.chair, s.house.id, 'PROPOSAL', 'application/pdf', await proposalPdf([
      'ТОО «ОтисКЗ»', 'Итого: 9 100 000 тенге', 'Срок 30 дней', 'Гарантия 3 года', 'Предоплата 30%',
    ]), 'kp-2.pdf')
    expect([a.status, b.status]).toEqual([200, 200])

    const created = await s.chair.post(`${s.base}/proposals/compare`).send({ title: 'Замена лифта, 2 подъезд', file_ids: [a.id, b.id] })
    expect(created.status).toBe(201)
    const c = await until(() => s.chair.get(`${s.base}/comparisons/${created.body.id}`), (r) => r.body.status !== 'PROCESSING')
    expect(c.body.status).toBe('DONE')
    expect(c.body.proposals[0].parsed).toMatchObject({ total_price: 8_400_000, warranty_months: 12, duration_days: 45, prepayment_percent: 50 })
    expect(c.body.proposals[1].parsed).toMatchObject({ total_price: 9_100_000, warranty_months: 36 })
    expect(c.body.recommended_proposal_id).toBe(c.body.proposals[1].id)
    expect(c.body.analysis.warnings.at(-1)).toContain('Проверьте цифры')
    // Телефон из КП заменён плейсхолдером до модели
    const sent = JSON.stringify(fake.seen.proposals)
    expect(sent).toContain('8 400 000')
    expect(sent).not.toContain('555 12 34')

    const decided = await s.chair.post(`${s.base}/comparisons/${created.body.id}/decide`).send({ proposal_id: c.body.proposals[0].id, note: 'Дешевле, гарантию продлим договором' })
    expect(decided.body).toMatchObject({ status: 'DECIDED', decided_proposal_id: c.body.proposals[0].id })
    expect((await owner.aiJob.findFirstOrThrow({ where: { type: 'PROPOSAL_COMPARE' } })).humanDecision).toBe('MODIFIED')
    // Жилец сравнения не видит
    expect((await s.resident.agent.get(`${s.base}/comparisons/${created.body.id}`)).status).toBe(403)
  })

  it('accepts only PDF and at least two proposals', async () => {
    const s = await setup()
    expect((await s.chair.post(`/v1/houses/${s.house.id}/files/upload-url`).send({ purpose: 'PROPOSAL', mime_type: 'image/jpeg', size_bytes: 100, name: 'kp.jpg' })).status).toBe(400)
    const one = await upload(t, s.chair, s.house.id, 'PROPOSAL', 'application/pdf', await proposalPdf(['Итого 100 000 тенге']), 'kp.pdf')
    expect((await s.chair.post(`${s.base}/proposals/compare`).send({ title: 'Одно КП', file_ids: [one.id] })).status).toBe(400)
  })
})

describe('legal assistant', () => {
  it('answers only from articles and drops citations it cannot verify', async () => {
    const s = await setup()
    const res = await s.chair.post(`${s.base}/legal/ask`).send({ question: 'Какой кворум нужен для собрания собственников квартир? Звонил Кенжебаев 8 701 123 45 67' })
    expect(res.status).toBe(200)
    expect(res.body.found).toBe(true)
    expect(res.body.citations).toHaveLength(1)
    expect(res.body.citations[0]).toMatchObject({ document: 'Закон РК «О жилищных отношениях»', source_url: expect.stringContaining('adilet.zan.kz') })
    expect(res.body.suggested_action).toEqual({ type: 'CREATE_VOTE', decision_type: 'CAPITAL_REPAIR' })
    // В модель — обезличенный вопрос и статьи закона
    expect(fake.seen.legal!.question).not.toContain('Кенжебаев')
    expect(fake.seen.legal!.question).not.toContain('123 45 67')
    expect(fake.seen.legal!.articles.some((a) => a.article === '42')).toBe(true)

    const history = await s.chair.get(`${s.base}/legal/history`)
    expect(history.body).toHaveLength(1)
    // В истории — вопрос председателя как есть: это данные его дома
    expect(history.body[0].question).toContain('Кенжебаев')
  })

  it('says it found nothing instead of inventing an answer', async () => {
    const s = await setup()
    const res = await s.chair.post(`${s.base}/legal/ask`).send({ question: 'Щщщ ыыыы ъъъъ фффф' })
    expect(res.body).toMatchObject({ found: false, citations: [] })
    expect(await owner.aiJob.count({ where: { type: 'LEGAL_QA' } })).toBe(0)
  })

  it('without a model returns the closest articles to read', async () => {
    const s = await setup(plain)
    const res = await s.chair.post(`${s.base}/legal/ask`).send({ question: 'Как провести письменный опрос собственников?' })
    expect(res.body.found).toBe(true)
    expect(res.body.confidence).toBe('LOW')
    expect(res.body.citations.map((c: { article: string }) => c.article)).toContain('43')
  })

  it('is closed to residents', async () => {
    const s = await setup()
    expect((await s.resident.agent.post(`${s.base}/legal/ask`).send({ question: 'Можно ли не платить взносы?' })).status).toBe(403)
  })
})

describe('limits', () => {
  it('turns AI off for the house with a clear message when the hourly limit is spent', async () => {
    const s = await setup()
    await owner.aiJob.createMany({ data: Array.from({ length: 20 }, () => ({ houseId: s.house.id, type: 'LEGAL_QA' as const, provider: 'fake', model: 'fake', inputRef: {}, status: 'DONE' as const })) })
    const res = await s.chair.post(`${s.base}/legal/ask`).send({ question: 'Какой кворум нужен для собрания собственников?' })
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('AI_LIMIT')
    expect(await owner.aiJob.count({ where: { houseId: s.house.id, status: 'REJECTED' } })).toBe(1)

    // Основная работа идёт: заявка создаётся без автопроверки
    const req = await s.resident.agent.post(`${s.base}/requests`).send({ description: 'Не горит свет на 3 этаже', category: 'ELECTRICITY', location_type: 'ENTRANCE', location_entrance: 1 })
    expect(req.status).toBe(201)
    const usage = await s.chair.get(`${s.base}/ai/usage`)
    expect(usage.body.hour).toEqual({ used: 20, limit: 20 })
  })
})

describe('weekly summary', () => {
  it('is built from aggregates without names and shown to residents', async () => {
    const s = await setup()
    const req = await s.resident.agent.post(`${s.base}/requests`).send({ description: 'Асанова Динара сообщает: течёт кран в подвале', category: 'PLUMBING', location_type: 'BASEMENT' })
    const lastWeek = new Date(Date.now() - 7 * 86_400_000)
    await owner.request.update({ where: { id: req.body.id }, data: { status: 'DONE', doneAt: lastWeek, createdAt: lastWeek, title: 'Асанова Динара: течёт кран' } })

    const generated = await s.chair.post(`${s.base}/summary/generate`)
    expect(generated.status).toBe(200)
    expect(generated.body.summary_text).toBeTruthy()
    expect(fake.seen.summary!.requests.done).toBe(1)
    expect(JSON.stringify(fake.seen.summary)).not.toMatch(/Асанов|Динар/)

    const latest = await s.resident.agent.get(`${s.base}/summary/latest`)
    expect(latest.body.summary.id).toBe(generated.body.id)
    expect((await s.resident.agent.post(`${s.base}/summary/generate`)).status).toBe(403)
  })
})

describe('isolation', () => {
  it('another house cannot see voice notes or comparisons', async () => {
    const s = await setup()
    const audio = await upload(t, s.chair, s.house.id, 'VOICE_NOTE', 'audio/webm', webm(), 'voice.webm')
    const note = await s.chair.post(`${s.base}/voice-notes`).send({ audio_file_id: audio.id, duration_sec: 10 })
    const other = await makeUser({ email: 'other@ortaq.test' })
    const { house } = await makeHouse({ chairman: other })
    const agent = await login(t, other)
    expect((await agent.get(`/v1/houses/${house.id}/voice-notes/${note.body.id}`)).status).toBe(404)
    expect((await agent.get(`${s.base}/voice-notes/${note.body.id}`)).status).toBe(404)
  })
})
