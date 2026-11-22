import type { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Корпус законодательства для юрпомощника (docs/11 §3.6). Одна статья — один фрагмент, чтобы
 * ссылка указывала на статью. Загружается сидом под ролью-владельцем: приложению корпус только читать.
 */
export type CorpusFile = {
  title: string
  short: string
  type: 'LAW' | 'RULES' | 'ORDER'
  source_url: string
  version_date: string
  language: string
  articles: { article: string; title: string; content: string }[]
}

export const CORPUS_FILES = ['housing-law.ru.json']
/** gemini-embedding-001 принимает около 2 000 токенов: начало статьи несёт её предмет */
const EMBED_CHARS = 4500
const EMBED_PORTION = 20

export function readCorpus(name: string): CorpusFile {
  return JSON.parse(readFileSync(join(__dirname, '../../../prisma/legal', name), 'utf8')) as CorpusFile
}

export type Embedder = (texts: string[]) => Promise<number[][] | null>

/**
 * Идемпотентно: документ по коду, статьи по номеру. Эмбеддинги — только для статей без них,
 * повторный сид не тратит квоту модели
 */
export async function loadCorpus(db: PrismaClient, embed?: Embedder, log: (m: string) => void = () => undefined): Promise<void> {
  for (const name of CORPUS_FILES) {
    const file = readCorpus(name)
    const code = name.replace(/\.json$/, '')
    const doc = await db.legalDocument.upsert({
      where: { code },
      create: { code, title: file.title, shortTitle: file.short, type: file.type, sourceUrl: file.source_url, versionDate: new Date(file.version_date), language: file.language },
      update: { title: file.title, shortTitle: file.short, sourceUrl: file.source_url, versionDate: new Date(file.version_date), isCurrent: true },
    })
    for (const [order, a] of file.articles.entries()) {
      await db.legalChunk.upsert({
        where: { documentId_article: { documentId: doc.id, article: a.article } },
        create: { documentId: doc.id, order, article: a.article, title: a.title, content: a.content },
        update: { order, title: a.title, content: a.content },
      })
    }
    log(`${file.short}: ${file.articles.length} статей`)
    if (!embed) continue

    const missing = await db.$queryRaw<{ id: string; title: string; content: string }[]>`
      SELECT id, title, content FROM legal_chunks WHERE document_id = ${doc.id}::uuid AND embedding IS NULL ORDER BY "order"`
    if (!missing.length) continue
    // Порциями с сохранением: оборванная загрузка продолжится с того же места
    let done = 0
    for (let i = 0; i < missing.length; i += EMBED_PORTION) {
      const part = missing.slice(i, i + EMBED_PORTION)
      const vectors = await embed(part.map((c) => `${c.title}\n${c.content.slice(0, EMBED_CHARS)}`)).catch((e: unknown) => {
        log(`Эмбеддинги прерваны: ${e instanceof Error ? e.message : String(e)}. Повторите сид позже`)
        return null
      })
      if (!vectors) break
      for (const [j, c] of part.entries()) {
        await db.$executeRaw`UPDATE legal_chunks SET embedding = ${toVector(vectors[j]!)}::vector WHERE id = ${c.id}::uuid`
      }
      done += part.length
    }
    log(done ? `Эмбеддинги: ${done} из ${missing.length} статей` : 'Эмбеддинги недоступны: поиск по статьям будет полнотекстовым')
  }
}

export function toVector(v: number[]): string {
  return `[${v.map((x) => x.toFixed(7)).join(',')}]`
}
