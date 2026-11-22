/**
 * Текстовый слой PDF через pdf.js: коммерческие предложения из Word и 1С приходят со шрифтами
 * CID и картами ToUnicode, которые простой разбор потоков не читает. Модели уходит текст,
 * а не файл — так его можно обезличить (docs/11 §2).
 */
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

// pdf.js — только ESM. В сборке CommonJS tsc превращает import() в require(): Node 22 загружает ESM и так
let lib: Promise<PdfJs> | undefined

const MAX_PAGES = 40

export async function pdfText(body: Buffer, maxChars: number): Promise<string> {
  lib ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfjs = await lib
  // Без шрифтов и XFA: нужен только текст, активное содержимое документа не исполняется
  const task = pdfjs.getDocument({ data: new Uint8Array(body), disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0 })
  const doc = await task.promise
  try {
    const pages: string[] = []
    let length = 0
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES) && length < maxChars; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let line = ''
      const lines: string[] = []
      for (const item of content.items) {
        if (!('str' in item)) continue
        line += item.str
        if (item.hasEOL) {
          lines.push(line)
          line = ''
        }
      }
      if (line) lines.push(line)
      const text = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
      pages.push(text)
      length += text.length
    }
    return pages.join('\n\n').slice(0, maxChars).trim()
  } finally {
    await task.destroy()
  }
}
