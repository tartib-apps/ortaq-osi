import PDFDocument from 'pdfkit'
import { join } from 'node:path'

/**
 * Вёрстка официальных документов в PDF (отчёт ОСИ, протокол собрания). Шрифт — Noto Sans:
 * кириллица и казахские буквы (ә, ғ, қ, ң, ө, ұ, ү, һ, і) без подмены. Документ — данные,
 * уже подписанные ЭЦП: PDF их только печатает и указывает хеш, по которому подпись проверяется.
 */
const FONTS = join(__dirname, '../../../assets/fonts')
const MARGIN = 48
const PAGE_BOTTOM = 842 - MARGIN - 28
const INK = '#1d2321'
const INK2 = '#5b6460'
const LINE = '#d9dedb'

export type Column = { label: string; width: number; align?: 'left' | 'right' | 'center' }

export class Pdf {
  private readonly doc: PDFKit.PDFDocument
  private readonly chunks: Buffer[] = []
  private readonly done: Promise<Buffer>
  readonly width: number

  constructor(title: string, private readonly footer: string) {
    this.doc = new PDFDocument({ size: 'A4', margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN }, bufferPages: true, info: { Title: title, Creator: 'Ortaq' } })
    this.doc.registerFont('regular', join(FONTS, 'NotoSans-Regular.ttf'))
    this.doc.registerFont('bold', join(FONTS, 'NotoSans-Bold.ttf'))
    this.doc.font('regular').fontSize(10).fillColor(INK)
    this.width = this.doc.page.width - MARGIN * 2
    this.done = new Promise((resolve) => {
      this.doc.on('data', (c: Buffer) => this.chunks.push(c))
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)))
    })
  }

  title(text: string, sub?: string): this {
    this.doc.font('bold').fontSize(15).fillColor(INK).text(text, { align: 'center' })
    if (sub) this.doc.moveDown(0.2).font('regular').fontSize(10).fillColor(INK2).text(sub, { align: 'center' })
    this.doc.moveDown(1).fillColor(INK)
    return this
  }

  heading(text: string): this {
    this.room(40)
    this.doc.moveDown(0.6).font('bold').fontSize(11.5).fillColor(INK).text(text, MARGIN, this.doc.y, { width: this.width }).moveDown(0.3)
    return this
  }

  text(text: string, opts: { muted?: boolean; size?: number; bold?: boolean } = {}): this {
    this.room(20)
    this.doc.font(opts.bold ? 'bold' : 'regular').fontSize(opts.size ?? 10).fillColor(opts.muted ? INK2 : INK).text(text, MARGIN, this.doc.y, { width: this.width }).fillColor(INK)
    return this
  }

  /** Пары «метка — значение» в две колонки: шапка отчёта и протокола */
  fields(pairs: [string, string][]): this {
    const labelW = 170
    for (const [label, value] of pairs) {
      this.room(18)
      const y = this.doc.y
      this.doc.font('regular').fontSize(9.5).fillColor(INK2).text(label, MARGIN, y, { width: labelW - 8 })
      const after = this.doc.y
      this.doc.font('regular').fontSize(10).fillColor(INK).text(value || '—', MARGIN + labelW, y, { width: this.width - labelW })
      this.doc.y = Math.max(this.doc.y, after) + 3
    }
    this.doc.x = MARGIN
    return this
  }

  /** Таблица с переносом строк и повтором шапки на новой странице */
  table(cols: Column[], rows: { cells: string[]; bold?: boolean; indent?: number }[]): this {
    const total = cols.reduce((s, c) => s + c.width, 0)
    const widths = cols.map((c) => (c.width / total) * this.width)
    const pad = 4
    const head = () => {
      const y = this.doc.y
      let x = MARGIN
      this.doc.font('bold').fontSize(8.5).fillColor(INK2)
      const h = Math.max(...cols.map((c, i) => this.doc.heightOfString(c.label, { width: widths[i]! - pad * 2 }))) + pad * 2
      cols.forEach((c, i) => { this.doc.text(c.label, x + pad, y + pad, { width: widths[i]! - pad * 2, align: c.align ?? 'left' }); x += widths[i]! })
      this.doc.moveTo(MARGIN, y + h).lineTo(MARGIN + this.width, y + h).strokeColor(LINE).lineWidth(0.8).stroke()
      this.doc.y = y + h
    }
    this.room(40)
    head()
    for (const r of rows) {
      const indentOf = (i: number) => (i === 1 ? r.indent ?? 0 : 0)
      this.doc.font(r.bold ? 'bold' : 'regular').fontSize(9).fillColor(INK)
      const h = Math.max(...r.cells.map((cell, i) => this.doc.heightOfString(cell, { width: widths[i]! - pad * 2 - indentOf(i) })), 10) + pad * 2
      if (this.doc.y + h > PAGE_BOTTOM) {
        this.doc.addPage()
        head()
        this.doc.font(r.bold ? 'bold' : 'regular').fontSize(9).fillColor(INK)
      }
      const y = this.doc.y
      let x = MARGIN
      r.cells.forEach((cell, i) => {
        this.doc.text(cell, x + pad + indentOf(i), y + pad, { width: widths[i]! - pad * 2 - indentOf(i), align: cols[i]!.align ?? 'left' })
        x += widths[i]!
      })
      this.doc.moveTo(MARGIN, y + h).lineTo(MARGIN + this.width, y + h).strokeColor(LINE).lineWidth(0.4).stroke()
      this.doc.y = y + h
    }
    this.doc.x = MARGIN
    this.doc.moveDown(0.5)
    return this
  }

  /** Подписи ЭЦП: кто и когда подписал, либо отметка, что подписи нет */
  signatures(items: { role: string; name: string | null; signedAt: string | null }[]): this {
    this.room(30 * items.length + 20)
    this.doc.moveDown(0.8)
    for (const s of items) {
      const y = this.doc.y
      this.doc.font('regular').fontSize(10).fillColor(INK2).text(s.role, MARGIN, y, { width: 160 })
      this.doc.font(s.name ? 'bold' : 'regular').fillColor(INK).text(
        s.name ? `${s.name} — подписано ЭЦП ${s.signedAt ?? ''}` : 'не подписано',
        MARGIN + 170, y, { width: this.width - 170 },
      )
      this.doc.moveDown(0.6)
    }
    this.doc.x = MARGIN
    return this
  }

  async end(): Promise<Buffer> {
    // Нумерация и служебная строка на каждой странице: хеш связывает бумагу с подписанной версией
    const range = this.doc.bufferedPageRange()
    for (let i = range.start; i < range.start + range.count; i++) {
      this.doc.switchToPage(i)
      const bottom = this.doc.page.margins.bottom
      // Нижнее поле временно снимаем: иначе текст в поле переносится на новую пустую страницу
      this.doc.page.margins.bottom = 0
      this.doc.font('regular').fontSize(7.5).fillColor(INK2)
        .text(`${this.footer} · стр. ${i + 1} из ${range.count}`, MARGIN, this.doc.page.height - MARGIN + 12, { width: this.width, align: 'center', lineBreak: false })
      this.doc.page.margins.bottom = bottom
    }
    this.doc.end()
    return this.done
  }

  private room(h: number) {
    if (this.doc.y + h > PAGE_BOTTOM) this.doc.addPage()
  }
}
