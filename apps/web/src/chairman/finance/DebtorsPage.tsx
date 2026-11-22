import { useState } from 'react'
import { BellRing, HandCoins } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router'
import type { DebtorView } from '@ortaq/shared'
import { api } from '../../shared/api/client'
import { formatDate } from '../../shared/lib/cn'
import { Btn, Card, CardHead, Empty, ErrorNote, PageHead, Skeleton, Tag } from '../../shared/ui/kit'
import { Download } from '../../shared/ui/Download'
import { DEBT_LEVEL, money, monthLabel } from '../labels'
import { FinanceTabs } from './FinanceTabs'
import { t } from '../../shared/i18n'

/**
 * Должники (docs/10 §6). Поимённо — только правлению, и каждый просмотр в аудите; жильцы видят
 * лишь процент собираемости. Напоминание — личное уведомление собственнику, не публичный список.
 */
export function DebtorsPage() {
  const { houseId = '' } = useParams()
  const qc = useQueryClient()
  const [chosen, setChosen] = useState<string[]>([])
  const q = useQuery({ queryKey: ['house', houseId, 'debtors'], queryFn: () => api<DebtorView[]>(`/houses/${houseId}/debtors`), staleTime: 60_000 })
  const remind = useMutation({
    mutationFn: (unitIds: string[]) => api<{ sent: number; skipped: number }>(`/houses/${houseId}/debtors/remind`, { method: 'POST', body: { unit_ids: unitIds } }),
    onSuccess: async () => { setChosen([]); await qc.invalidateQueries({ queryKey: ['house', houseId, 'debtors'] }) },
  })
  const total = (q.data ?? []).reduce((s, d) => s + d.debt, 0)
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  return (
    <div className="flex flex-col gap-5">
      <PageHead title={t('Финансы')} sub={t('Просроченные взносы по помещениям')} actions={<Download kind="xlsx" href={`/houses/${houseId}/exports/debtors`}>{t('Должники в Excel')}</Download>} />
      <FinanceTabs />
      <Card>
        <CardHead icon={HandCoins} title={t('Должники')} sub={q.data?.length ? t('{n} помещений, долг {amount}. Список не публикуется жильцам', { n: q.data.length, amount: money(total) }) : t('Список не публикуется жильцам')}
          aside={chosen.length > 0 ? <Btn icon={BellRing} loading={remind.isPending} onClick={() => remind.mutate(chosen)}>{t('Напомнить ({n})', { n: chosen.length })}</Btn> : undefined} />
        {remind.data && <p className="mb-3 text-[13.5px] text-ink-2">{remind.data.skipped ? t('Отправлено: {sent}, пропущено {skipped} — напоминали меньше трёх дней назад или нет собственника в приложении', { sent: remind.data.sent, skipped: remind.data.skipped }) : t('Отправлено: {sent}', { sent: remind.data.sent })}</p>}
        <ErrorNote>{(q.error ?? remind.error)?.message}</ErrorNote>
        {q.isPending ? <Skeleton rows={4} /> : (q.data?.length ?? 0) === 0 ? (
          <Empty icon={HandCoins} title={t('Должников нет')} text={t('Неоплаченное после конца месяца появится здесь с глубиной долга.')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {q.data!.map((d) => (
              <li key={d.unit.id}>
                <label className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 rounded-[18px] bg-surface-2 px-5 py-3.5 transition-colors hover:bg-surface-3">
                  <input type="checkbox" checked={chosen.includes(d.unit.id)} onChange={() => toggle(d.unit.id)} className="size-5 accent-[var(--color-brand-600)]" aria-label={t('Выбрать №{number}', { number: d.unit.number })} />
                  <span className="w-14 shrink-0 text-[15px] font-semibold text-ink">№{d.unit.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] text-ink">{d.owners.length ? d.owners.map((o) => o.name).join(', ') : t('Собственник не в приложении')}</span>
                    <span className="block text-[12.5px] text-ink-2">{t('с {month}', { month: monthLabel(d.oldest_period).toLowerCase() })}{d.last_reminded_at ? ` · ${t('напоминали {date}', { date: formatDate(d.last_reminded_at) })}` : ''}</span>
                  </span>
                  <Tag tone={d.level === 'PRETRIAL' ? 'crit' : d.level === 'REPEAT' ? 'warn' : 'mute'}>{DEBT_LEVEL[d.level]}</Tag>
                  <span className="w-28 text-right text-[15px] font-semibold tabular-nums text-ink">{money(d.debt)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
