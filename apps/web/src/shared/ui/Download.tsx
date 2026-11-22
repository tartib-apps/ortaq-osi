import { FileDown, FileSpreadsheet } from 'lucide-react'

/**
 * Скачивание документа API (PDF, Excel). Обычная ссылка: cookie сессии уходит сама, файл
 * отдаётся с Content-Disposition — браузер сохраняет его под русским именем
 */
export function Download({ href, kind, children }: { href: string; kind: 'pdf' | 'xlsx'; children: string }) {
  const Icon = kind === 'pdf' ? FileDown : FileSpreadsheet
  return (
    <a
      href={`/v1${href}`}
      download
      className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-surface-2 px-5 text-[14.5px] font-semibold text-ink transition-colors hover:bg-surface-3"
    >
      <Icon size={17} strokeWidth={2.1} />
      {children}
    </a>
  )
}
