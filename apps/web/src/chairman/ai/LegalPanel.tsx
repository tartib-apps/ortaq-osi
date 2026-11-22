import { useState } from 'react'
import { BookOpen, ExternalLink, Gavel, SearchX, Send, Vote } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import type { LegalAnswer } from '@ortaq/shared'
import { api } from '../../shared/api/client'
import { cn, formatDateTime } from '../../shared/lib/cn'
import { Btn, Card, CardHead, Empty, ErrorNote, fieldCls, Skeleton, Tag } from '../../shared/ui/kit'
import { t, tr } from '../../shared/i18n'

const EXAMPLES = [
  'Какой кворум нужен, чтобы собрание собственников было правомочным?',
  'Можно ли потратить деньги со сберегательного счёта без решения собрания?',
  'За сколько дней нужно уведомить жильцов о собрании?',
]
const CONFIDENCE = tr({ HIGH: 'уверенно', MEDIUM: 'с оговорками', LOW: 'неуверенно' } as const)

export function LegalPanel({ houseId, canVote }: { houseId: string; canVote: boolean }) {
  const qc = useQueryClient()
  const [question, setQuestion] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const history = useQuery({ queryKey: ['house', houseId, 'legal'], queryFn: () => api<LegalAnswer[]>(`/houses/${houseId}/legal/history`) })
  const ask = useMutation({
    mutationFn: (q: string) => api<LegalAnswer>(`/houses/${houseId}/legal/ask`, { method: 'POST', body: { question: q } }),
    onSuccess: async (a) => { setShown(a.id); setQuestion(''); await qc.invalidateQueries({ queryKey: ['house', houseId, 'legal'] }); void qc.invalidateQueries({ queryKey: ['house', houseId, 'ai-usage'] }) },
  })
  const current = history.data?.find((a) => a.id === shown) ?? (ask.data && ask.data.id === shown ? ask.data : null)

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card>
          <CardHead icon={Gavel} title={t('Спросите о законе')} sub={t('Ответ — только по статьям Закона РК «О жилищных отношениях», с цитатами. Если основания нет, помощник так и скажет.')} />
          <textarea
            value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} maxLength={1000}
            placeholder={t('Например: нужно ли собрание, чтобы поднять взносы на содержание?')}
            className={cn(fieldCls, 'resize-y py-3 leading-relaxed')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && question.trim().length >= 5) ask.mutate(question.trim()) }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn icon={Send} loading={ask.isPending} disabled={question.trim().length < 5} onClick={() => ask.mutate(question.trim())}>{t('Спросить')}</Btn>
            {ask.isPending && <span className="text-[13px] text-ink-2">{t('Ищу статьи и готовлю ответ — до минуты')}</span>}
          </div>
          {!history.data?.length && !ask.isPending && (
            <div className="mt-4 flex flex-wrap gap-2">
              {EXAMPLES.map((e) => <button key={e} onClick={() => setQuestion(t(e))} className="rounded-full bg-surface-2 px-3 py-1.5 text-left text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink">{t(e)}</button>)}
            </div>
          )}
          <div className="mt-3"><ErrorNote>{ask.error?.message}</ErrorNote></div>
        </Card>
        {ask.isPending ? <Card><Skeleton rows={4} /></Card> : current && <AnswerCard a={current} canVote={canVote} houseId={houseId} />}
      </div>

      <Card>
        <CardHead icon={BookOpen} title={t('История')} />
        {history.isPending ? <Skeleton rows={3} /> : !history.data?.length ? (
          <Empty icon={BookOpen} title={t('Вопросов пока не было')} text={t('Ответы сохраняются: к ним удобно вернуться перед собранием.')} />
        ) : (
          <ul className="flex flex-col gap-2">
            {history.data.map((a) => (
              <li key={a.id}>
                <button onClick={() => setShown(a.id)} className={cn('w-full rounded-[18px] px-4 py-3 text-left transition-colors', current?.id === a.id ? 'bg-brand-50' : 'bg-surface-2 hover:bg-surface-3')}>
                  <span className="line-clamp-2 block text-[14px] font-medium text-ink">{a.question}</span>
                  <span className="mt-0.5 block text-[12.5px] text-ink-2">{formatDateTime(a.created_at)} · {a.found ? t('статей: {n}', { n: a.citations.length }) : t('основания нет')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function AnswerCard({ a, canVote, houseId }: { a: LegalAnswer; canVote: boolean; houseId: string }) {
  const navigate = useNavigate()
  return (
    <Card>
      <p className="text-[13.5px] text-ink-2">{a.question}</p>
      {!a.found ? (
        <div className="mt-4"><Empty icon={SearchX} title={t('Основания не нашлось')} text={a.answer} /></div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2"><Tag tone={a.confidence === 'HIGH' ? 'brand' : a.confidence === 'MEDIUM' ? 'warn' : 'mute'}>{t('Ответ {confidence}', { confidence: CONFIDENCE[a.confidence] })}</Tag></div>
          <p className="mt-3 whitespace-pre-line text-[15.5px] leading-relaxed text-ink">{a.answer}</p>
          <ul className="mt-5 flex flex-col gap-2">
            {a.citations.map((c) => (
              <li key={c.article} className="rounded-[18px] bg-surface-2 p-4">
                <p className="text-[13px] font-semibold text-ink">{t('{document}, статья {article}.', { document: c.document, article: c.article })} {c.title}</p>
                <blockquote className="mt-2 border-l-[3px] border-brand-200 pl-3 text-[14px] leading-relaxed text-ink-2">«{c.quote}»</blockquote>
                <a href={c.source_url} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 hover:text-brand-600">
                  {t('Открыть закон на adilet.zan.kz')} <ExternalLink size={13} />
                </a>
              </li>
            ))}
          </ul>
          {a.suggested_action && canVote && (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[18px] bg-brand-50 p-4">
              <p className="flex-1 text-[14px] text-ink">{t('Для этого нужно решение собрания собственников.')}</p>
              <Btn icon={Vote} onClick={() => navigate(`/h/${houseId}/votes/new?decision_type=${a.suggested_action!.decision_type}`)}>{t('Создать голосование')}</Btn>
            </div>
          )}
        </>
      )}
      <p className="mt-4 text-[12.5px] text-ink-3">{a.disclaimer}</p>
    </Card>
  )
}
