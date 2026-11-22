import { useRef, useState } from 'react'
import { Award, Check, FileText, Plus, RotateCcw, Scale, TriangleAlert, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AI_LIMITS, type ComparisonView } from '@ortaq/shared'
import { api } from '../../shared/api/client'
import { openFile, uploadFile } from '../../shared/api/upload'
import { cn, formatDate } from '../../shared/lib/cn'
import { Btn, Card, CardHead, Empty, ErrorNote, Field, Input, Skeleton, Tag } from '../../shared/ui/kit'
import { money } from '../labels'
import { t } from '../../shared/i18n'

const STATUS: Record<ComparisonView['status'], { label: string; tone: 'brand' | 'warn' | 'crit' | 'mute' | 'solid' }> = {
  PROCESSING: { label: 'Анализируется', tone: 'warn' },
  DONE: { label: 'Готово', tone: 'brand' },
  FAILED: { label: 'Не удалось', tone: 'crit' },
  DECIDED: { label: 'Подрядчик выбран', tone: 'solid' },
}

export function ProposalsPanel({ houseId, canDecide }: { houseId: string; canDecide: boolean }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const list = useQuery({
    queryKey: ['house', houseId, 'comparisons'],
    queryFn: () => api<ComparisonView[]>(`/houses/${houseId}/comparisons`),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'PROCESSING') ? 3000 : false),
  })
  const current = list.data?.find((c) => c.id === selected) ?? list.data?.[0] ?? null

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <Card>
        <CardHead icon={Scale} title={t('Сравнения')} sub={t('Загрузите 2–10 КП в PDF: ИИ сведёт цены, сроки и гарантии и найдёт, что не включено в цену.')} aside={canDecide && <Btn variant="soft" icon={Plus} onClick={() => setCreating(true)}>{t('Новое')}</Btn>} />
        {list.isPending ? <Skeleton rows={3} /> : !list.data?.length ? (
          <Empty icon={Scale} title={t('Сравнений пока нет')} text={t('Когда подрядчики пришлют предложения, загрузите их сюда.')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {list.data.map((c) => (
              <li key={c.id}>
                <button onClick={() => { setSelected(c.id); setCreating(false) }} className={cn('flex w-full items-center justify-between gap-3 rounded-[18px] px-4 py-3 text-left transition-colors', !creating && current?.id === c.id ? 'bg-brand-50' : 'bg-surface-2 hover:bg-surface-3')}>
                  <span className="min-w-0">
                    <span className="block truncate text-[14.5px] font-medium text-ink">{c.title}</span>
                    <span className="block text-[12.5px] text-ink-2">{formatDate(c.created_at)} · {t('КП: {n}', { n: c.proposals.length })}</span>
                  </span>
                  <Tag tone={STATUS[c.status].tone}>{t(STATUS[c.status].label)}</Tag>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating ? <CreateComparison houseId={houseId} onDone={(id) => { setCreating(false); setSelected(id) }} onCancel={() => setCreating(false)} />
        : current ? <ComparisonDetail houseId={houseId} c={current} canDecide={canDecide} />
        : <Card><Empty icon={FileText} title={t('Выберите сравнение')} text={t('Или создайте новое из предложений подрядчиков.')} /></Card>}
    </div>
  )
}

function CreateComparison({ houseId, onDone, onCancel }: { houseId: string; onDone: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const input = useRef<HTMLInputElement>(null)
  const create = useMutation({
    mutationFn: async () => {
      const ids: string[] = []
      for (const f of files) ids.push((await uploadFile(houseId, f, 'PROPOSAL')).id)
      return api<ComparisonView>(`/houses/${houseId}/proposals/compare`, { method: 'POST', body: { title: title.trim(), subject: subject.trim() || null, file_ids: ids } })
    },
    onSuccess: async (c) => { await qc.invalidateQueries({ queryKey: ['house', houseId, 'comparisons'] }); void qc.invalidateQueries({ queryKey: ['house', houseId, 'ai-usage'] }); onDone(c.id) },
  })
  return (
    <Card>
      <CardHead icon={Plus} title={t('Новое сравнение')} sub={t('Нужен PDF с текстом (из Word или 1С). Скан-фотографию ИИ не прочитает — её сверьте вручную.')} />
      <div className="flex flex-col gap-4">
        <Field label={t('Что закупаем')}>{(id) => <Input id={id} value={title} onChange={setTitle} placeholder={t('Замена лифта, 2 подъезд')} maxLength={200} />}</Field>
        <Field label={t('Требования')} hint={t('Необязательно: что важно сравнить — объём работ, сроки, гарантия')}>{(id) => <Input id={id} value={subject} onChange={setSubject} maxLength={1000} />}</Field>
        <div>
          <p className="mb-2 text-[13.5px] font-semibold text-ink">{t('Предложения ({n} из {max})', { n: files.length, max: AI_LIMITS.proposalFiles })}</p>
          <ul className="mb-3 flex flex-col gap-2">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-[15px] bg-surface-2 px-4 py-2.5 text-[14px]">
                <span className="flex min-w-0 items-center gap-2"><FileText size={16} className="shrink-0 text-ink-2" /><span className="truncate">{f.name}</span></span>
                <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} aria-label={t('Убрать файл')} className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-surface-3"><X size={16} /></button>
              </li>
            ))}
          </ul>
          <Btn variant="soft" icon={Plus} disabled={files.length >= AI_LIMITS.proposalFiles} onClick={() => input.current?.click()}>{t('Добавить PDF')}</Btn>
          <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => {
            const picked = [...(e.target.files ?? [])]
            e.target.value = ''
            setFiles((x) => [...x, ...picked].slice(0, AI_LIMITS.proposalFiles))
          }} />
        </div>
        <ErrorNote>{create.error?.message}</ErrorNote>
        <div className="flex gap-2">
          <Btn loading={create.isPending} disabled={files.length < 2 || title.trim().length < 3} onClick={() => create.mutate()}>{t('Сравнить')}</Btn>
          <Btn variant="ghost" onClick={onCancel}>{t('Отмена')}</Btn>
        </div>
      </div>
    </Card>
  )
}

function ComparisonDetail({ houseId, c, canDecide }: { houseId: string; c: ComparisonView; canDecide: boolean }) {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: ['house', houseId, 'comparisons'] })
  const decide = useMutation({ mutationFn: (proposal_id: string) => api(`/houses/${houseId}/comparisons/${c.id}/decide`, { method: 'POST', body: { proposal_id } }), onSuccess: refresh })
  const retry = useMutation({ mutationFn: () => api(`/houses/${houseId}/comparisons/${c.id}/retry`, { method: 'POST' }), onSuccess: refresh })
  const a = c.analysis
  const name = (i: number) => c.proposals[i]?.contractor_name ?? c.proposals[i]?.file_name ?? t('КП №{n}', { n: i + 1 })
  const rec = a?.recommendation.proposal_index ?? null

  return (
    <Card>
      <CardHead icon={Scale} title={c.title} sub={c.subject ?? undefined} aside={<Tag tone={STATUS[c.status].tone}>{t(STATUS[c.status].label)}</Tag>} />
      {c.status === 'PROCESSING' && <Skeleton rows={5} />}
      {c.status === 'FAILED' && (
        <div className="flex flex-col items-start gap-3">
          <ErrorNote>{c.error}</ErrorNote>
          {canDecide && <Btn icon={RotateCcw} loading={retry.isPending} onClick={() => retry.mutate()}>{t('Повторить анализ')}</Btn>}
        </div>
      )}
      {a && (
        <div className="flex flex-col gap-5">
          {rec !== null && (
            <div className="rounded-[20px] bg-brand-50 p-4">
              <p className="flex items-center gap-2 text-[14.5px] font-semibold text-brand-700"><Award size={17} /> {t('ИИ рекомендует: {name}', { name: name(rec) })}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-ink">{a.recommendation.reasoning}</p>
              {a.recommendation.risks.length > 0 && <ul className="mt-2 list-disc pl-5 text-[13.5px] text-ink-2">{a.recommendation.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            </div>
          )}

          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[560px] border-separate border-spacing-y-1.5 text-left text-[14px]">
              <thead>
                <tr className="text-[13px] text-ink-2">
                  <th className="px-4 font-medium">{t('Критерий')}</th>
                  {c.proposals.map((p, i) => (
                    <th key={p.id} className="px-4 font-medium">
                      <button onClick={() => void openFile(houseId, p.file_id)} className="text-left font-semibold text-ink hover:text-brand-700">{name(i)}</button>
                      {i === rec && <span className="ml-1 text-brand-700">★</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.comparison.map((row) => (
                  <tr key={row.criterion} className="[&>td]:bg-surface-2 [&>td:first-child]:rounded-l-[15px] [&>td:last-child]:rounded-r-[15px]">
                    <td className="px-4 py-3 font-medium text-ink">{row.criterion}</td>
                    {row.values.map((v, i) => <td key={i} className={cn('px-4 py-3 text-ink', i === row.best_index && 'font-semibold text-brand-700')}>{v}</td>)}
                  </tr>
                ))}
                <tr className="[&>td]:bg-surface-2 [&>td:first-child]:rounded-l-[15px] [&>td:last-child]:rounded-r-[15px]">
                  <td className="px-4 py-3 font-medium text-ink">{t('Не включено')}</td>
                  {a.proposals.map((p, i) => <td key={i} className="px-4 py-3 text-[13px] text-ink-2">{[...p.excludes, ...p.hidden_costs].filter((x, j, all) => all.indexOf(x) === j).join(', ') || '—'}</td>)}
                </tr>
              </tbody>
            </table>
          </div>

          {a.warnings.length > 0 && (
            <ul className="flex flex-col gap-2">
              {a.warnings.map((w, i) => <li key={i} className="flex items-start gap-2 rounded-[15px] bg-warning-soft px-4 py-3 text-[13.5px] text-warning"><TriangleAlert size={16} className="mt-0.5 shrink-0" />{w}</li>)}
            </ul>
          )}

          {canDecide && c.status !== 'DECIDED' && (
            <div>
              <p className="mb-2 text-[13.5px] font-semibold text-ink">{t('Ваш выбор')}</p>
              <div className="flex flex-wrap gap-2">
                {c.proposals.map((p, i) => (
                  <Btn key={p.id} variant={i === rec ? 'solid' : 'soft'} icon={Check} loading={decide.isPending && decide.variables === p.id} onClick={() => decide.mutate(p.id)}>
                    {name(i)}{p.parsed?.total_price ? ` · ${money(p.parsed.total_price)}` : ''}
                  </Btn>
                ))}
              </div>
              <p className="mt-2 text-[12.5px] text-ink-2">{t('Крупный расход выносится на собрание: после выбора создайте голосование в разделе «Голосования».')}</p>
              <ErrorNote>{decide.error?.message}</ErrorNote>
            </div>
          )}
          {c.status === 'DECIDED' && <p className="text-[14px] text-ink">{t('Выбран:')} <b>{name(c.proposals.findIndex((p) => p.id === c.decided_proposal_id))}</b>{c.decided_at && `, ${formatDate(c.decided_at)}`}</p>}
        </div>
      )}
    </Card>
  )
}
