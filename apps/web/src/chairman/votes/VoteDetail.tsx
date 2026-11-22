import { useState } from 'react'
import { BellRing, CalendarClock, CircleX, FileText, Paperclip, Pencil, Play, Send, Users } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router'
import {
  DECISION_LABEL, LEGAL_BASIS_LABEL, NOTICE_DAYS, RECOMMENDED_NOTICE_DAYS, THRESHOLD_LABEL,
  type VoteResults, type VoteView,
} from '@ortaq/shared'
import { api, ApiError } from '../../shared/api/client'
import { openFile } from '../../shared/api/upload'
import { useMe } from '../../shared/hooks'
import { cn, formatDateTime, plural } from '../../shared/lib/cn'
import { Btn, Card, CardHead, ErrorNote, Field, fieldCls, Input, PageHead, Skeleton, Tag } from '../../shared/ui/kit'
import { area, pct, VOTE_STATUS } from '../labels'
import { PaperBallot } from './PaperBallot'
import { ProtocolPanel } from './ProtocolPanel'
import { voteTone } from './VotesPage'
import { t } from '../../shared/i18n'

const DAY = 86_400_000
/** Значение для <input type="datetime-local"> в часовом поясе браузера */
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
const at = (days: number, hour: number) => {
  const d = new Date(Date.now() + days * DAY)
  d.setHours(hour, 0, 0, 0)
  return d
}

export function VoteDetail() {
  const { houseId = '', voteId = '' } = useParams()
  const navigate = useNavigate()
  const me = useMe()
  const chairman = me.data?.memberships.find((m) => m.house_id === houseId)?.role === 'CHAIRMAN'
  const q = useQuery({ queryKey: ['house', houseId, 'vote', voteId], queryFn: () => api<VoteView>(`/houses/${houseId}/votes/${voteId}`) })
  if (q.isPending) return <Skeleton rows={6} />
  if (!q.data) return <ErrorNote>{q.error?.message}</ErrorNote>
  const v = q.data
  const dates = v.starts_at && v.ends_at ? `${formatDateTime(v.starts_at)} — ${formatDateTime(v.ends_at)}` : t('сроки ещё не назначены')
  return (
    <div className="flex flex-col gap-5">
      <PageHead title={v.title} sub={`${t(LEGAL_BASIS_LABEL[v.legal_basis])} · ${dates}`}
        back={{ label: t('Голосования'), onClick: () => navigate(`/h/${houseId}/votes`) }}
        actions={<Tag tone={voteTone(v.status)}>{VOTE_STATUS[v.status]}</Tag>} />

      {v.status === 'CANCELLED' && (
        <Card className="bg-danger-soft"><CardHead icon={CircleX} title={t('Голосование отменено')} sub={`${v.cancelled_at ? formatDateTime(v.cancelled_at) : ''}. ${t('Причина: {reason}', { reason: v.cancel_reason ?? '' })}`} /></Card>
      )}
      {chairman && v.status === 'DRAFT' && <NoticePanel houseId={houseId} vote={v} />}
      {v.status === 'NOTICE_SENT' && <Scheduled houseId={houseId} vote={v} chairman={chairman} />}
      {(v.status === 'ACTIVE' || v.status === 'CLOSED') && <Progress houseId={houseId} vote={v} chairman={chairman} />}
      {chairman && v.status === 'ACTIVE' && v.legal_basis === 'ART_43_WRITTEN_SURVEY' && <PaperBallot houseId={houseId} vote={v} />}
      {(v.status === 'ACTIVE' || v.status === 'CLOSED') && <Results houseId={houseId} vote={v} />}
      {v.status === 'CLOSED' && v.protocol && <ProtocolPanel houseId={houseId} vote={v} chairman={chairman} />}

      <Card>
        <CardHead icon={FileText} title={t('Повестка')} sub={t('{decision}: требуется {threshold} от участвующих по площади. Кворум — более 50% площади', { decision: t(DECISION_LABEL[v.decision_type]), threshold: t(THRESHOLD_LABEL[v.threshold]) })}
          aside={chairman && v.status === 'DRAFT' ? <Btn variant="soft" icon={Pencil} onClick={() => navigate(`/h/${houseId}/votes/${v.id}/edit`)}>{t('Изменить')}</Btn> : undefined} />
        {v.description && <p className="mb-4 whitespace-pre-line text-[14.5px] text-ink">{v.description}</p>}
        <ol className="flex flex-col gap-3">
          {v.questions.map((qn) => (
            <li key={qn.id} className="rounded-[18px] bg-surface-2 px-5 py-3.5">
              <p className="text-[15px] font-medium text-ink">{qn.order}. {qn.text}</p>
              <p className="mt-1 text-[13px] text-ink-2">{qn.options.map((o) => o.text).join(' · ')}</p>
            </li>
          ))}
        </ol>
        {v.materials.length > 0 && <Materials houseId={houseId} vote={v} />}
        <p className="mt-4 text-[13.5px] text-ink-2">{t('Секретарь:')} {v.secretary ? v.secretary.name : <span className="text-warning">{t('не назначен — без него протокол не подписать')}</span>}</p>
      </Card>

      {chairman && ['DRAFT', 'NOTICE_SENT', 'ACTIVE'].includes(v.status) && <Cancel houseId={houseId} vote={v} />}
    </div>
  )
}

function Materials({ houseId, vote }: { houseId: string; vote: VoteView }) {
  const open = useMutation({ mutationFn: (id: string) => openFile(houseId, id) })
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {vote.materials.map((m, i) => (
        <Btn key={m.id} variant="soft" icon={Paperclip} loading={open.isPending && open.variables === m.id} onClick={() => open.mutate(m.id)}>
          {t('Материал {n}', { n: i + 1 })} · {m.mime_type === 'application/pdf' ? 'PDF' : t('фото')}
        </Btn>
      ))}
      <ErrorNote>{open.error?.message}</ErrorNote>
    </div>
  )
}

function useRefresh(houseId: string, voteId: string) {
  const qc = useQueryClient()
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['house', houseId, 'vote', voteId] }),
    qc.invalidateQueries({ queryKey: ['house', houseId, 'votes'] }),
    qc.invalidateQueries({ queryKey: ['house', houseId, 'vote-results', voteId] }),
  ])
}

/** Шаг 3: сроки и рассылка. Раньше чем через 5 дней начало выбрать нельзя — и сервер это перепроверит */
function NoticePanel({ houseId, vote }: { houseId: string; vote: VoteView }) {
  const refresh = useRefresh(houseId, vote.id)
  const [starts, setStarts] = useState(() => local(at(RECOMMENDED_NOTICE_DAYS, 10)))
  const [ends, setEnds] = useState(() => local(at(RECOMMENDED_NOTICE_DAYS + 10, 20)))
  const min = local(new Date(Date.now() + NOTICE_DAYS * DAY + 60_000))
  const send = useMutation({
    mutationFn: () => api(`/houses/${houseId}/votes/${vote.id}/send-notice`, { method: 'POST', body: { starts_at: new Date(starts).toISOString(), ends_at: new Date(ends).toISOString() } }),
    onSuccess: refresh,
  })
  const fields = send.error instanceof ApiError ? send.error.fields : {}
  return (
    <Card>
      <CardHead icon={CalendarClock} title={t('Сроки и уведомление')} sub={t('Закон требует уведомить собственников не позднее чем за {n} календарных дней. Рекомендуем {m}: запас дешевле спора', { n: NOTICE_DAYS, m: RECOMMENDED_NOTICE_DAYS })} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Начало голосования')} hint={t('Не раньше {date}', { date: formatDateTime(new Date(min).toISOString()) })} error={fields.starts_at}>
          {(id, d) => <input id={id} aria-describedby={d} type="datetime-local" min={min} value={starts} onChange={(e) => setStarts(e.target.value)} className={cn(fieldCls, 'h-12')} />}
        </Field>
        <Field label={t('Окончание')} hint={t('Закроется автоматически, продлить будет нельзя')} error={fields.ends_at}>
          {(id, d) => <input id={id} aria-describedby={d} type="datetime-local" min={starts} value={ends} onChange={(e) => setEnds(e.target.value)} className={cn(fieldCls, 'h-12')} />}
        </Field>
      </div>
      <p className="mt-4 text-[13.5px] text-ink-2">{t('Уведомление получат все члены дома, собственники — с SMS. После рассылки повестку и сроки изменить нельзя. Напоминания непроголосовавшим — за 3 дня, сутки и 4 часа до конца.')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Btn icon={Send} loading={send.isPending} disabled={!vote.secretary} onClick={() => send.mutate()}>{t('Разослать уведомление')}</Btn>
        {!vote.secretary && <span className="text-[13px] text-warning">{t('Сначала назначьте секретаря')}</span>}
      </div>
      <ErrorNote>{send.error && !fields.starts_at && !fields.ends_at ? send.error.message : null}</ErrorNote>
    </Card>
  )
}

function Scheduled({ houseId, vote, chairman }: { houseId: string; vote: VoteView; chairman: boolean }) {
  const refresh = useRefresh(houseId, vote.id)
  const activate = useMutation({ mutationFn: () => api(`/houses/${houseId}/votes/${vote.id}/activate`, { method: 'POST' }), onSuccess: refresh })
  const started = Date.parse(vote.starts_at!) <= Date.now()
  return (
    <Card>
      <CardHead icon={CalendarClock} title={t('Начнётся {date}', { date: formatDateTime(vote.starts_at!) })}
        sub={t('Уведомление разослано {date}{recipients}. Голосование стартует само в указанное время', { date: formatDateTime(vote.notice_sent_at!), recipients: vote.notified !== null ? `: ${vote.notified} ${t(plural(vote.notified, ['получатель', 'получателя', 'получателей']))}` : '' })} />
      {chairman && started && <Btn icon={Play} loading={activate.isPending} onClick={() => activate.mutate()}>{t('Начать сейчас')}</Btn>}
      <ErrorNote>{activate.error?.message}</ErrorNote>
    </Card>
  )
}

/** Явка по площади против отметки 50%. Распределение голосов здесь не показывается */
function Progress({ houseId, vote, chairman }: { houseId: string; vote: VoteView; chairman: boolean }) {
  const refresh = useRefresh(houseId, vote.id)
  const remind = useMutation({ mutationFn: () => api<{ sent: number }>(`/houses/${houseId}/votes/${vote.id}/remind`, { method: 'POST' }) })
  const close = useMutation({ mutationFn: () => api(`/houses/${houseId}/votes/${vote.id}/close`, { method: 'POST' }), onSuccess: refresh })
  const tn = vote.turnout!
  const ended = Date.parse(vote.ends_at!) <= Date.now()
  return (
    <Card>
      <CardHead icon={Users} title={vote.status === 'ACTIVE' ? t('Идёт до {date}', { date: formatDateTime(vote.ends_at!) }) : t('Завершено {date}', { date: formatDateTime(vote.closed_at!) })}
        sub={t('Проголосовало {cast} из {total} помещений · {castArea} из {totalArea}', { cast: tn.cast_units, total: tn.total_units, castArea: area(tn.cast_area), totalArea: area(tn.total_area) })} />
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-[28px] font-bold tabular-nums text-ink">{pct(tn.percent)}</span>
        <span className={cn('text-[14px] font-semibold', tn.quorum_reached ? 'text-brand-700' : 'text-warning')}>{tn.quorum_reached ? t('Кворум есть') : t('Кворум пока не набран: нужно больше 50%')}</span>
      </div>
      <div className="relative mt-2 h-3 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={tn.percent} aria-valuemin={0} aria-valuemax={100} aria-label={t('Явка по площади')}>
        <div className={cn('h-full rounded-full', tn.quorum_reached ? 'bg-brand-600' : 'bg-warning')} style={{ width: `${Math.min(100, tn.percent)}%` }} />
        <div className="absolute inset-y-0 left-1/2 w-0.5 bg-ink/40" />
      </div>
      {chairman && vote.status === 'ACTIVE' && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {!ended && <Btn variant="soft" icon={BellRing} loading={remind.isPending} onClick={() => remind.mutate()}>{t('Напомнить всем непроголосовавшим')}</Btn>}
          {ended && <Btn icon={FileText} loading={close.isPending} onClick={() => close.mutate()}>{t('Подвести итоги')}</Btn>}
          {remind.data && <span className="text-[13.5px] text-ink-2">{t('Отправлено: {sent}', { sent: remind.data.sent })}</span>}
        </div>
      )}
      <ErrorNote>{(remind.error ?? close.error)?.message}</ErrorNote>
    </Card>
  )
}

function Results({ houseId, vote }: { houseId: string; vote: VoteView }) {
  const q = useQuery({ queryKey: ['house', houseId, 'vote-results', vote.id], queryFn: () => api<VoteResults>(`/houses/${houseId}/votes/${vote.id}/results`) })
  if (!q.data || q.data.hidden) return null
  const r = q.data
  return (
    <Card>
      <CardHead title={vote.status === 'CLOSED' ? t('Итоги') : t('Ход голосования')} sub={t('Проценты — от площади участвующих. Требуется {threshold}', { threshold: t(THRESHOLD_LABEL[r.threshold]) })} />
      <div className="flex flex-col gap-5">
        {r.questions.map((qn) => (
          <div key={qn.question_id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="text-[15px] font-medium text-ink">{qn.order}. {qn.text}</p>
              {vote.status === 'CLOSED' && <Tag tone={qn.adopted ? 'brand' : qn.adopted === null ? 'mute' : 'crit'}>{qn.adopted ? t('Принято') : qn.adopted === null ? t('Нет кворума') : t('Не принято')}</Tag>}
            </div>
            {qn.options.map((o) => (
              <div key={o.option_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[14px]">
                <span className={cn('text-ink', qn.adopted_option_ids.includes(o.option_id) && 'font-semibold')}>{o.text}</span>
                <span className="tabular-nums text-ink-2">{pct(o.percent)} · {area(o.area)}</span>
                <div className="col-span-2 h-2 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-brand-600" style={{ width: `${o.percent}%` }} /></div>
              </div>
            ))}
          </div>
        ))}
        {r.paper.units > 0 && <p className="text-[13.5px] text-ink-2">{t('Бумажных бюллетеней: {n}, {percent} голосов по площади', { n: r.paper.units, percent: pct(r.paper.percent_of_cast) })}</p>}
      </div>
    </Card>
  )
}

function Cancel({ houseId, vote }: { houseId: string; vote: VoteView }) {
  const refresh = useRefresh(houseId, vote.id)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const cancel = useMutation({ mutationFn: () => api(`/houses/${houseId}/votes/${vote.id}/cancel`, { method: 'POST', body: { reason } }), onSuccess: refresh })
  if (!open) return <div><Btn variant="ghost" icon={CircleX} onClick={() => setOpen(true)}>{t('Отменить голосование')}</Btn></div>
  return (
    <Card>
      <CardHead icon={CircleX} title={t('Отмена голосования')} sub={vote.status === 'DRAFT' ? t('Черновик никто, кроме правления, не видел') : t('Все уведомлённые получат сообщение с причиной. Поданные бюллетени сохранятся, итоги не будут раскрыты')} />
      <Field label={t('Причина')}>{(id) => <Input id={id} value={reason} onChange={setReason} placeholder={t('Ошибка в повестке')} maxLength={500} />}</Field>
      <div className="mt-3 flex gap-2">
        <Btn variant="danger" loading={cancel.isPending} disabled={reason.trim().length < 5} onClick={() => cancel.mutate()}>{t('Отменить голосование')}</Btn>
        <Btn variant="ghost" onClick={() => setOpen(false)}>{t('Не отменять')}</Btn>
      </div>
      <ErrorNote>{cancel.error?.message}</ErrorNote>
    </Card>
  )
}
