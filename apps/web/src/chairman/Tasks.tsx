import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CalendarClock, ListTodo, Plus, Repeat, TriangleAlert } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router'
import type { RecurringTemplateBody } from '@ortaq/shared'
import { api } from '../shared/api/client'
import { cn, ease, formatDate, formatDateTime } from '../shared/lib/cn'
import { Btn, Card, CardHead, Empty, ErrorNote, Field, Input, PageHead, Segmented, Select, Skeleton, Tag } from '../shared/ui/kit'
import { PRIORITY_LABELS, PRIORITY_TONE, TASK_STATUS_LABELS } from './labels'
import { t } from '../shared/i18n'

type Task = {
  id: string; title: string; status: string; priority: string; due_at: string | null; recurring: boolean
  assignee: { name: string } | null; contractor: { name: string } | null; request: { id: string; number: number } | null
}
type Template = {
  id: string; title: string; rrule: string; lead_time_hours: number; requires_photo: boolean; is_active: boolean
  default_assignee: { id: string; name: string | null } | null; next: string[]; missed_in_row: number
}
type Assignees = { workers: { id: string; name: string; active_tasks: number }[] }

/* Конструктор расписания: председатель выбирает по-человечески, на сервер уходит RRULE */
const DAYS = [['MO', 'пн'], ['TU', 'вт'], ['WE', 'ср'], ['TH', 'чт'], ['FR', 'пт'], ['SA', 'сб'], ['SU', 'вс']] as const
type Kind = 'weekdays' | 'daily' | 'weekly' | 'monthly'

function buildRule(kind: Kind, days: string[], hour: number): string {
  const at = `;BYHOUR=${hour};BYMINUTE=0`
  if (kind === 'daily') return `FREQ=DAILY${at}`
  if (kind === 'weekdays') return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR${at}`
  if (kind === 'monthly') return `FREQ=MONTHLY;BYDAY=1${days[0] ?? 'MO'}${at}`
  return `FREQ=WEEKLY;BYDAY=${(days.length ? days : ['MO']).join(',')}${at}`
}

function describeRule(rule: string): string {
  const day = (code: string) => { const d = DAYS.find(([c]) => c === code)?.[1]; return d ? t(d) : code }
  const hour = rule.match(/BYHOUR=(\d+)/)?.[1] ?? '9'
  const by = rule.match(/BYDAY=([^;]+)/)?.[1]
  if (rule.includes('FREQ=DAILY')) return t('ежедневно в {hour}:00', { hour })
  if (by === 'MO,TU,WE,TH,FR') return t('по будням в {hour}:00', { hour })
  if (rule.includes('FREQ=MONTHLY') && by) return t('первый {day} месяца в {hour}:00', { day: day(by.replace(/^\d/, '')), hour })
  return t('{days} в {hour}:00', { days: by?.split(',').map(day).join(', ') ?? t('еженедельно'), hour })
}

function TemplateForm({ houseId, onClose }: { houseId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<Kind>('weekdays')
  const [days, setDays] = useState<string[]>(['FR'])
  const [hour, setHour] = useState('9')
  const [who, setWho] = useState('')
  const [photo, setPhoto] = useState(false)
  const rule = buildRule(kind, days, Number(hour))
  const assignees = useQuery({ queryKey: ['house', houseId, 'assignees'], queryFn: () => api<Assignees>(`/houses/${houseId}/tasks/assignees`) })
  const preview = useQuery({ queryKey: ['rrule-preview', houseId, rule], queryFn: () => api<{ next: string[] }>(`/houses/${houseId}/recurring/preview`, { method: 'POST', body: { rrule: rule } }) })
  const create = useMutation({
    mutationFn: (body: RecurringTemplateBody) => api(`/houses/${houseId}/recurring`, { method: 'POST', body }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['house', houseId, 'recurring'] }); onClose() },
  })
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
      <div className="mb-5 flex flex-col gap-4 rounded-[20px] bg-surface-2 p-4">
        <Field label={t('Что делать')}>{(id) => <Input id={id} value={title} onChange={setTitle} placeholder={t('Уборка двора')} autoFocus />}</Field>
        <div className="flex flex-col gap-2">
          <span className="text-[13.5px] font-semibold text-ink">{t('Как часто')}</span>
          <Segmented id="rr-kind" label={t('Как часто')} value={kind} onChange={setKind} options={[
            { v: 'weekdays', label: t('По будням') }, { v: 'daily', label: t('Каждый день') }, { v: 'weekly', label: t('По дням недели') }, { v: 'monthly', label: t('Раз в месяц') },
          ]} />
          {(kind === 'weekly' || kind === 'monthly') && (
            <div role="group" aria-label={t('Дни недели')} className="flex flex-wrap gap-1.5">
              {DAYS.map(([code, label]) => {
                const on = days.includes(code)
                return (
                  <button key={code} type="button" aria-pressed={on} onClick={() => setDays((d) => (kind === 'monthly' ? [code] : on ? d.filter((x) => x !== code) : [...d, code]))}
                    className={cn('h-11 min-w-11 rounded-full px-3 text-[14px] font-semibold transition-colors', on ? 'bg-brand-600 text-white' : 'bg-surface text-ink hover:bg-surface-3')}>{t(label)}</button>
                )
              })}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Во сколько')}>{(id) => <Select id={id} value={hour} onChange={setHour} options={Array.from({ length: 15 }, (_, i) => ({ v: String(i + 6), label: `${i + 6}:00` }))} />}</Field>
          <Field label={t('Исполнитель')}>{(id) => <Select id={id} value={who} onChange={setWho} placeholder={t('Выберите')} options={(assignees.data?.workers ?? []).map((w) => ({ v: w.id, label: w.name }))} />}</Field>
        </div>
        <label className="flex min-h-11 items-center gap-3 text-[14px] text-ink"><input type="checkbox" className="size-4 accent-[var(--color-brand-600)]" checked={photo} onChange={() => setPhoto((v) => !v)} /> {t('Нужна фотофиксация')}</label>
        {preview.data && <p className="nums text-[13px] text-ink-2">{t('Ближайшие: {dates}', { dates: preview.data.next.slice(0, 4).map((d) => formatDateTime(d)).join(' · ') })}</p>}
        <ErrorNote>{create.error?.message}</ErrorNote>
        <div className="flex gap-2">
          <Btn icon={Plus} disabled={title.trim().length < 3 || !who} loading={create.isPending}
            onClick={() => create.mutate({ title, rrule: rule, default_assignee_id: who, requires_photo: photo, lead_time_hours: 12 })}>{t('Создать')}</Btn>
          <Btn variant="soft" onClick={onClose}>{t('Отмена')}</Btn>
        </div>
      </div>
    </motion.div>
  )
}

function Routine({ houseId }: { houseId: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const q = useQuery({ queryKey: ['house', houseId, 'recurring'], queryFn: () => api<Template[]>(`/houses/${houseId}/recurring`) })
  const toggle = useMutation({
    mutationFn: (tpl: Template) => api(`/houses/${houseId}/recurring/${tpl.id}`, { method: 'PATCH', body: { is_active: !tpl.is_active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['house', houseId, 'recurring'] }),
  })
  return (
    <Card>
      <CardHead icon={Repeat} title={t('Рутина по расписанию')} sub={t('Задача появляется у работника заранее. Невыполненная не копится — закрывается как просроченная')}
        aside={!adding && <Btn variant="soft" icon={Plus} onClick={() => setAdding(true)}>{t('Шаблон')}</Btn>} />
      <AnimatePresence>{adding && <TemplateForm houseId={houseId} onClose={() => setAdding(false)} />}</AnimatePresence>
      {q.isPending && <Skeleton rows={2} />}
      {q.data?.length === 0 && !adding && <Empty icon={CalendarClock} title={t('Шаблонов нет')} text={t('Уборка двора по будням, обход техпомещений по пятницам — задайте один раз, дальше задачи появятся сами.')} />}
      <ul className="flex flex-col gap-2">
        {q.data?.map((tpl) => (
          <li key={tpl.id} className={cn('flex flex-wrap items-center gap-3 rounded-[18px] bg-surface-2 px-4 py-3', !tpl.is_active && 'opacity-60')}>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-ink">{tpl.title}</p>
              <p className="text-[13px] text-ink-2">{describeRule(tpl.rrule)} · {tpl.default_assignee?.name ?? t('без исполнителя')}{tpl.next[0] && ` · ${t('следующая {date}', { date: formatDate(tpl.next[0]) })}`}</p>
            </div>
            {tpl.missed_in_row >= 3 && <Tag tone="crit" icon={TriangleAlert}>{t('пропущено {n} раза подряд', { n: tpl.missed_in_row })}</Tag>}
            <Btn variant="ghost" loading={toggle.isPending && toggle.variables?.id === tpl.id} onClick={() => toggle.mutate(tpl)}>{tpl.is_active ? t('Приостановить') : t('Возобновить')}</Btn>
          </li>
        ))}
      </ul>
      <ErrorNote>{toggle.error?.message}</ErrorNote>
    </Card>
  )
}

export function Tasks() {
  const { houseId = '' } = useParams()
  const navigate = useNavigate()
  const q = useQuery({ queryKey: ['house', houseId, 'tasks', 'active'], queryFn: () => api<Task[]>(`/houses/${houseId}/tasks?scope=active`) })
  const review = q.data?.filter((t) => t.status === 'SUBMITTED') ?? []
  return (
    <>
      <PageHead title={t('Задачи')} sub={review.length ? t('{n} ждут вашего подтверждения', { n: review.length }) : t('Что сейчас в работе у персонала и подрядчиков')} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card>
          <CardHead icon={ListTodo} title={t('В работе')} />
          {q.isPending && <Skeleton rows={3} />}
          {q.data?.length === 0 && <Empty icon={ListTodo} title={t('Активных задач нет')} text={t('Задачи назначаются из заявок или порождаются рутиной по расписанию.')} />}
          <ul className="flex flex-col gap-2">
            {q.data?.map((task) => (
              <li key={task.id}>
                <button type="button" disabled={!task.request} onClick={() => task.request && navigate(`/h/${houseId}/requests/${task.request.id}`)}
                  className="flex w-full flex-wrap items-center gap-3 rounded-[18px] bg-surface-2 px-4 py-3 text-left transition-colors enabled:hover:bg-surface-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-semibold text-ink">{task.recurring && <Repeat size={14} className="mr-1 inline text-ink-2" />}{task.title}</p>
                    <p className="text-[13px] text-ink-2">
                      {task.assignee?.name ?? task.contractor?.name ?? t('без исполнителя')}{task.request && ` · ${t('заявка №{number}', { number: task.request.number })}`}{task.due_at && ` · ${t('до {date}', { date: formatDateTime(task.due_at) })}`}
                    </p>
                  </div>
                  {task.priority !== 'NORMAL' && <Tag tone={PRIORITY_TONE[task.priority] ?? 'mute'}>{PRIORITY_LABELS[task.priority]}</Tag>}
                  <Tag tone={task.status === 'SUBMITTED' ? 'warn' : 'mute'}>{TASK_STATUS_LABELS[task.status]}</Tag>
                </button>
              </li>
            ))}
          </ul>
          <ErrorNote>{q.error?.message}</ErrorNote>
        </Card>
        <Routine houseId={houseId} />
      </div>
    </>
  )
}
