import { useState } from 'react'
import { CircleCheck, FileSignature, Printer, Send } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LEGAL_BASIS_LABEL, THRESHOLD_LABEL, type BallotSigningView, type ProtocolView, type VoteView } from '@ortaq/shared'
import { Download } from '../../shared/ui/Download'
import { api } from '../../shared/api/client'
import { formatDate, formatDateTime } from '../../shared/lib/cn'
import { Btn, Card, CardHead, ErrorNote, Skeleton, Tag } from '../../shared/ui/kit'
import { area, pct, PROTOCOL_STATUS } from '../labels'
import { t } from '../../shared/i18n'

/** Протокол (docs/09 §7): сформирован при закрытии, подписи председателя и секретаря, публикация */
export function ProtocolPanel({ houseId, vote, chairman }: { houseId: string; vote: VoteView; chairman: boolean }) {
  const qc = useQueryClient()
  const key = ['house', houseId, 'protocol', vote.id]
  const q = useQuery({ queryKey: key, queryFn: () => api<ProtocolView>(`/houses/${houseId}/votes/${vote.id}/protocol`) })
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ['house', houseId, 'vote', vote.id] }), qc.invalidateQueries({ queryKey: ['house', houseId, 'votes'] })])
  const publish = useMutation({ mutationFn: () => api(`/houses/${houseId}/protocols/${q.data!.id}/publish`, { method: 'POST' }), onSuccess: refresh })
  if (q.isPending) return <Card><Skeleton rows={4} /></Card>
  if (!q.data) return <ErrorNote>{q.error?.message}</ErrorNote>
  const p = q.data
  const c = p.content
  return (
    <Card>
      <CardHead icon={FileSignature} title={t('Протокол №{number}', { number: p.number })} sub={t('Хранится до {date}', { date: formatDate(p.retention_until) })}
        aside={<span className="flex items-center gap-2"><Tag tone={p.status === 'PUBLISHED' ? 'brand' : 'warn'}>{PROTOCOL_STATUS[p.status]}</Tag><Download kind="pdf" href={`/houses/${houseId}/votes/${vote.id}/protocol/pdf`}>PDF</Download><Btn variant="soft" icon={Printer} onClick={() => window.print()}>{t('Печать')}</Btn></span>} />
      <div className="flex flex-col gap-4 text-[14px] text-ink">
        <p className="text-[15px] font-semibold">{t('Протокол №{number} общего собрания собственников помещений', { number: c.number })}</p>
        <dl className="grid gap-x-6 gap-y-1.5 text-[13.5px] sm:grid-cols-2">
          <div><dt className="inline text-ink-2">{t('Объект:')} </dt><dd className="inline">{c.house.address}</dd></div>
          <div><dt className="inline text-ink-2">{t('Форма:')} </dt><dd className="inline">{t(LEGAL_BASIS_LABEL[c.vote.legal_basis])}</dd></div>
          <div><dt className="inline text-ink-2">{t('Уведомление:')} </dt><dd className="inline">{formatDateTime(c.dates.notice_sent_at)}</dd></div>
          <div><dt className="inline text-ink-2">{t('Голосование:')} </dt><dd className="inline">{formatDateTime(c.dates.starts_at)} — {formatDateTime(c.dates.ends_at)}</dd></div>
        </dl>
        <div className="rounded-[18px] bg-surface-2 px-5 py-3.5">
          <p className="font-semibold">{t('Кворум')}</p>
          <p className="mt-1 text-ink-2">{t('Общая площадь {total}. Приняли участие {n} помещений, {area}.', { total: area(c.quorum.total_area), n: c.quorum.cast_units, area: area(c.quorum.cast_area) })}</p>
          <p className="mt-1">{c.held ? t('Кворум {percent} — собрание правомочно', { percent: pct(c.quorum.percent) }) : t('Кворум {percent} — собрание не состоялось: нужно больше 50%', { percent: pct(c.quorum.percent) })}</p>
        </div>
        <div className="flex flex-col gap-3">
          <p className="font-semibold">{t('Результаты · требуется {threshold}', { threshold: t(THRESHOLD_LABEL[c.vote.threshold]) })}</p>
          {c.results.map((r) => (
            <div key={r.question_id}>
              <p>{t('Вопрос {n}.', { n: r.order })} {r.text}</p>
              <ul className="mt-1 text-ink-2">{r.options.map((o) => <li key={o.option_id}>{o.text}: {pct(o.percent)} ({area(o.area)})</li>)}</ul>
              <p className="mt-1 font-semibold">{r.adopted === null ? t('Решение не принималось') : r.adopted ? t('РЕШЕНИЕ ПРИНЯТО') : t('РЕШЕНИЕ НЕ ПРИНЯТО')}</p>
            </div>
          ))}
          {c.paper.note && <p className="text-warning">{c.paper.note}</p>}
        </div>
        <details className="rounded-[18px] bg-surface-2 px-5 py-3.5">
          <summary className="cursor-pointer font-semibold">{t('Участники голосования ({n})', { n: c.participants.length })}</summary>
          <ul className="mt-2 flex flex-col gap-1 text-[13px] text-ink-2">
            {c.participants.map((x, i) => <li key={i}>№{x.unit_number} · {area(x.area)} · {x.voter_name} · {x.channel === 'PAPER' ? t('бумажный, внесён председателем') : t('ЭЦП {serial}', { serial: x.cert_serial ?? '' })} · {formatDateTime(x.cast_at)}</li>)}
          </ul>
        </details>
        <p className="text-[13px] text-ink-2">{t('Уведомлено {n} членов дома; помещений без собственника в приложении — {m}: их собственников уведомляют на бумаге.', { n: c.notice.notified_users, m: c.notice.units_without_owner_in_app })}</p>
        <ul className="flex flex-col gap-1">
          <li>{t('Председатель:')} {p.signatures.chairman ? <span className="text-brand-700">{p.signatures.chairman.name}, {t('ЭЦП {date}', { date: formatDateTime(p.signatures.chairman.signed_at) })}</span> : <span className="text-ink-3">{t('не подписано')}</span>}</li>
          <li>{t('Секретарь')}{p.secretary ? ` (${p.secretary.name})` : ''}: {p.signatures.secretary ? <span className="text-brand-700">{p.signatures.secretary.name}, {t('ЭЦП {date}', { date: formatDateTime(p.signatures.secretary.signed_at) })}</span> : <span className="text-ink-3">{t('не подписано — секретарь подписывает в мобильном приложении')}</span>}</li>
        </ul>
        {chairman && p.status === 'AWAITING_SIGNATURES' && !p.signatures.chairman && <Signing houseId={houseId} protocolId={p.id} onDone={refresh} />}
        {chairman && p.status === 'SIGNED' && <div><Btn icon={Send} loading={publish.isPending} onClick={() => publish.mutate()}>{t('Опубликовать жильцам')}</Btn></div>}
        <ErrorNote>{publish.error?.message}</ErrorNote>
      </div>
    </Card>
  )
}

function Signing({ houseId, protocolId, onDone }: { houseId: string; protocolId: string; onDone: () => Promise<unknown> }) {
  const [started, setStarted] = useState<BallotSigningView | null>(null)
  const base = `/houses/${houseId}/protocols/${protocolId}`
  const start = useMutation({ mutationFn: () => api<BallotSigningView>(`${base}/sign`, { method: 'POST' }), onSuccess: setStarted })
  const done = useMutation({
    mutationFn: () => api<ProtocolView | { status: 'PENDING' }>(`${base}/sign/complete`, { method: 'POST' }),
    onSuccess: async (r) => { if ('id' in r) { setStarted(null); await onDone() } },
  })
  return (
    <div className="flex flex-col gap-3 rounded-[20px] bg-surface-2 p-4">
      {started ? (
        <>
          <p className="text-[14px]">{t('Откройте eGov mobile, проверьте описание документа и подпишите своей ЭЦП. Потом вернитесь сюда.')}</p>
          <div className="flex flex-wrap gap-2">
            <a href={started.deeplink} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full bg-surface px-4 text-[14px] font-semibold text-brand-700 hover:bg-surface-3">{t('Открыть eGov mobile')}</a>
            <Btn icon={CircleCheck} loading={done.isPending} onClick={() => done.mutate()}>{t('Я подписал')}</Btn>
          </div>
          {done.data && !('id' in done.data) && <p className="text-[13px] text-ink-2">{t('Подпись ещё не получена. Завершите подписание в eGov mobile')}</p>}
        </>
      ) : <div><Btn icon={FileSignature} loading={start.isPending} onClick={() => start.mutate()}>{t('Подписать протокол ЭЦП')}</Btn></div>}
      <ErrorNote>{(start.error ?? done.error)?.message}</ErrorNote>
    </div>
  )
}
