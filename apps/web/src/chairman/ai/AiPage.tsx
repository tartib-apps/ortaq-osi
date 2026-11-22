import { useState } from 'react'
import { CalendarDays, Gauge, RefreshCw } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'react-router'
import type { AiUsage, WeeklySummaryView } from '@ortaq/shared'
import { api } from '../../shared/api/client'
import { useMe } from '../../shared/hooks'
import { formatDate } from '../../shared/lib/cn'
import { Btn, Card, CardHead, Empty, ErrorNote, PageHead, Segmented, Skeleton } from '../../shared/ui/kit'
import { LegalPanel } from './LegalPanel'
import { ProposalsPanel } from './ProposalsPanel'
import { VoicePanel } from './VoicePanel'
import { t } from '../../shared/i18n'

type Tab = 'voice' | 'proposals' | 'legal' | 'summary'

/**
 * Помощник председателя (docs/11). Каждая функция — черновик: задачи, выбор подрядчика и
 * голосование создаёт человек. Бухгалтеру — юрпомощник и сравнения на чтение
 */
export function AiPage() {
  const { houseId = '' } = useParams()
  const me = useMe()
  const chairman = me.data?.memberships.find((m) => m.house_id === houseId)?.role === 'CHAIRMAN'
  const [params, setParams] = useSearchParams()
  const tabs: { v: Tab; label: string }[] = [
    ...(chairman ? [{ v: 'voice' as const, label: t('Голосовые задачи') }] : []),
    { v: 'proposals', label: t('Сравнение КП') },
    { v: 'legal', label: t('Юрпомощник') },
    { v: 'summary', label: t('Сводки') },
  ]
  const tab = (tabs.find((t) => t.v === params.get('tab'))?.v ?? tabs[0]!.v)

  return (
    <div className="flex flex-col gap-5">
      <PageHead title={t('Помощник')} sub={t('ИИ готовит черновик — решаете вы. В модель не уходят ФИО, ИИН, телефоны и номера квартир.')} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented id="ai-tab" label={t('Раздел помощника')} options={tabs} value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} />
        {chairman && <UsageLine houseId={houseId} />}
      </div>
      {tab === 'voice' && <VoicePanel houseId={houseId} />}
      {tab === 'proposals' && <ProposalsPanel houseId={houseId} canDecide={chairman} />}
      {tab === 'legal' && <LegalPanel houseId={houseId} canVote={chairman} />}
      {tab === 'summary' && <SummaryPanel houseId={houseId} canGenerate={chairman} />}
    </div>
  )
}

function UsageLine({ houseId }: { houseId: string }) {
  const usage = useQuery({ queryKey: ['house', houseId, 'ai-usage'], queryFn: () => api<AiUsage>(`/houses/${houseId}/ai/usage`), refetchInterval: 60_000 })
  if (!usage.data) return null
  const u = usage.data
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-ink-2" title={t('Модель: {model}', { model: u.model })}>
      <Gauge size={15} />
      {u.enabled ? t('Запросов за час: {used} из {limit} · за месяц {percent}% квоты', { used: u.hour.used, limit: u.hour.limit, percent: Math.round((u.month.tokens / u.month.limit) * 100) }) : t('ИИ не подключён: работают простые правила')}
    </p>
  )
}

function SummaryPanel({ houseId, canGenerate }: { houseId: string; canGenerate: boolean }) {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['house', houseId, 'summaries'], queryFn: () => api<WeeklySummaryView[]>(`/houses/${houseId}/summaries`) })
  const [open, setOpen] = useState<string | null>(null)
  const generate = useMutation({
    mutationFn: () => api<WeeklySummaryView>(`/houses/${houseId}/summary/generate`, { method: 'POST' }),
    onSuccess: async (s) => { setOpen(s.id); await qc.invalidateQueries({ queryKey: ['house', houseId, 'summaries'] }); void qc.invalidateQueries({ queryKey: ['house', houseId, 'ai-usage'] }) },
  })
  const current = list.data?.find((s) => s.id === open) ?? list.data?.[0]

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
      <Card>
        <CardHead
          icon={CalendarDays}
          title={current ? t('Неделя {from} — {to}', { from: formatDate(current.week_start), to: formatDate(current.week_end) }) : t('Сводка недели')}
          sub={t('Публикуется жильцам по понедельникам. Собирается из цифр дома, без фамилий и номеров квартир.')}
          aside={canGenerate && <Btn variant="soft" icon={RefreshCw} loading={generate.isPending} onClick={() => generate.mutate()}>{t('Собрать за прошлую неделю')}</Btn>}
        />
        <ErrorNote>{generate.error?.message}</ErrorNote>
        {list.isPending ? <Skeleton rows={3} /> : !current ? (
          <Empty icon={CalendarDays} title={t('Сводок пока нет')} text={t('Первая появится в понедельник утром.')} />
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-[15.5px] leading-relaxed text-ink">{current.summary_text}</p>
            {current.highlights.length > 0 && (
              <div><p className="mb-2 text-[13.5px] font-semibold text-ink">{t('Сделано')}</p><ul className="list-disc pl-5 text-[14px] leading-relaxed text-ink-2">{current.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
            )}
            {current.needs_attention.length > 0 && (
              <div><p className="mb-2 text-[13.5px] font-semibold text-ink">{t('Требует внимания')}</p><ul className="list-disc pl-5 text-[14px] leading-relaxed text-ink-2">{current.needs_attention.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
            )}
          </div>
        )}
      </Card>
      <Card>
        <CardHead title={t('Прошлые недели')} />
        <ul className="flex flex-col gap-2">
          {list.data?.map((s) => (
            <li key={s.id}>
              <button onClick={() => setOpen(s.id)} className={`w-full rounded-[18px] px-4 py-3 text-left text-[14px] transition-colors ${current?.id === s.id ? 'bg-brand-50 text-ink' : 'bg-surface-2 text-ink hover:bg-surface-3'}`}>
                {formatDate(s.week_start)} — {formatDate(s.week_end)}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
