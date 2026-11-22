import { useEffect, useRef, useState } from 'react'
import { Check, Mic, RotateCcw, Square, Upload, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AI_LIMITS, Priority, Specialization, type ConfirmVoiceTasksBody, type VoiceNoteView, type VoiceTaskCandidate } from '@ortaq/shared'
import { api } from '../../shared/api/client'
import { AUDIO_ACCEPT_ATTR, uploadFile } from '../../shared/api/upload'
import { cn, formatDateTime } from '../../shared/lib/cn'
import { Btn, Card, CardHead, Empty, ErrorNote, Field, Input, Select, Skeleton, Tag } from '../../shared/ui/kit'
import { PRIORITY_LABELS, SPECIALIZATION_LABELS } from '../labels'
import { t } from '../../shared/i18n'

type Assignees = { workers: { id: string; name: string; specializations: string[]; active_tasks: number }[] }
type Draft = { on: boolean; title: string; specialization: string; priority: string; assignee: string; description: string | null }

const STATUS: Record<VoiceNoteView['status'], { label: string; tone: 'brand' | 'warn' | 'crit' | 'mute' }> = {
  PROCESSING: { label: 'Распознаётся', tone: 'warn' },
  EXTRACTED: { label: 'Ждёт проверки', tone: 'brand' },
  FAILED: { label: 'Не распознано', tone: 'crit' },
  REVIEWED: { label: 'Разобрано', tone: 'mute' },
}

/** Запись в браузере: формат выбирает браузер (Chrome — WebM, Safari — MP4) */
function useRecorder(onDone: (file: File, seconds: number) => void) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const started = useRef(0)

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => {
      const s = Math.round((Date.now() - started.current) / 1000)
      setSeconds(s)
      if (s >= AI_LIMITS.voiceSeconds) rec.current?.stop()
    }, 500)
    return () => clearInterval(t)
  }, [recording])

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const r = new MediaRecorder(stream)
      const chunks: Blob[] = []
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const type = (r.mimeType || 'audio/webm').split(';')[0]!
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
        const secs = Math.max(1, Math.round((Date.now() - started.current) / 1000))
        onDone(new File(chunks, `голосовое.${ext}`, { type }), Math.min(secs, AI_LIMITS.voiceSeconds))
      }
      rec.current = r
      started.current = Date.now()
      setSeconds(0)
      r.start()
      setRecording(true)
    } catch {
      setError(t('Нет доступа к микрофону. Разрешите его в браузере или загрузите запись файлом'))
    }
  }
  return { recording, seconds, error, start, stop: () => rec.current?.stop() }
}

/** Длительность файла, выбранного с диска: браузер читает её из метаданных */
function duration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement('audio')
    a.preload = 'metadata'
    a.onloadedmetadata = () => { URL.revokeObjectURL(a.src); resolve(Number.isFinite(a.duration) ? Math.ceil(a.duration) : 60) }
    a.onerror = () => resolve(60)
    a.src = URL.createObjectURL(file)
  })
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export function VoicePanel({ houseId }: { houseId: string }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const list = useQuery({
    queryKey: ['house', houseId, 'voice-notes'],
    queryFn: () => api<VoiceNoteView[]>(`/houses/${houseId}/voice-notes`),
    // Пока запись распознаётся — опрашиваем: результат приходит через 10–60 секунд
    refetchInterval: (q) => (q.state.data?.some((n) => n.status === 'PROCESSING') ? 2500 : false),
  })
  const send = useMutation({
    mutationFn: async ({ file, seconds }: { file: File; seconds: number }) => {
      const audio = await uploadFile(houseId, file, 'VOICE_NOTE')
      return api<VoiceNoteView>(`/houses/${houseId}/voice-notes`, { method: 'POST', body: { audio_file_id: audio.id, duration_sec: seconds } })
    },
    onSuccess: async (n) => { setSelected(n.id); await qc.invalidateQueries({ queryKey: ['house', houseId, 'voice-notes'] }); void qc.invalidateQueries({ queryKey: ['house', houseId, 'ai-usage'] }) },
  })
  const recorder = useRecorder((file, seconds) => send.mutate({ file, seconds }))
  const fileInput = useRef<HTMLInputElement>(null)
  const current = list.data?.find((n) => n.id === selected) ?? list.data?.find((n) => n.status === 'EXTRACTED') ?? null

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-5">
        <Card>
          <CardHead icon={Mic} title={t('Надиктуйте задачи')} sub={t('Скажите, что сделать и где — ИИ разложит на задачи по специализациям. Задачи появятся у работников только после вашей проверки.')} />
          <div className="flex flex-col items-center gap-3 rounded-[20px] bg-surface-2 px-5 py-6">
            <button
              type="button"
              onClick={() => (recorder.recording ? recorder.stop() : void recorder.start())}
              disabled={send.isPending}
              aria-label={recorder.recording ? t('Остановить запись') : t('Начать запись')}
              className={cn('grid size-20 place-items-center rounded-full text-white transition-colors disabled:opacity-55', recorder.recording ? 'bg-danger hover:bg-[#c43a33]' : 'bg-brand-600 hover:bg-brand-700')}
            >
              {recorder.recording ? <Square size={26} strokeWidth={2.4} /> : <Mic size={30} strokeWidth={2.2} />}
            </button>
            <p className="nums text-[15px] font-semibold text-ink">{recorder.recording ? mmss(recorder.seconds) : send.isPending ? t('Отправляю…') : t('Нажмите и говорите')}</p>
            <p className="text-center text-[12.5px] text-ink-2">{t('До 10 минут. Можно по-русски и по-казахски')}</p>
          </div>
          <div className="mt-3 flex justify-center">
            <Btn variant="ghost" icon={Upload} onClick={() => fileInput.current?.click()} disabled={send.isPending || recorder.recording}>{t('Загрузить запись')}</Btn>
            <input
              ref={fileInput} type="file" accept={AUDIO_ACCEPT_ATTR} hidden
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) send.mutate({ file: f, seconds: Math.min(await duration(f), AI_LIMITS.voiceSeconds) })
              }}
            />
          </div>
          <div className="mt-3"><ErrorNote>{recorder.error ?? send.error?.message}</ErrorNote></div>
        </Card>

        <Card>
          <CardHead title={t('Последние голосовые')} />
          {list.isPending ? <Skeleton rows={3} /> : !list.data?.length ? (
            <Empty icon={Mic} title={t('Голосовых пока нет')} text={t('Запишите первое — например, обход дома утром.')} />
          ) : (
            <ul className="flex flex-col gap-2">
              {list.data.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => setSelected(n.id)}
                    className={cn('flex w-full items-center justify-between gap-3 rounded-[18px] px-4 py-3 text-left transition-colors', current?.id === n.id ? 'bg-brand-50' : 'bg-surface-2 hover:bg-surface-3')}
                  >
                    <span className="min-w-0">
                      <span className="block text-[14.5px] font-medium text-ink">{formatDateTime(n.created_at)} · {mmss(n.duration_sec)}</span>
                      <span className="block truncate text-[12.5px] text-ink-2">{n.transcript ?? (n.status === 'PROCESSING' ? t('Распознаётся…') : n.error ?? '')}</span>
                    </span>
                    <Tag tone={STATUS[n.status].tone}>{t(STATUS[n.status].label)}</Tag>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {current ? <NoteReview key={current.id + current.status} houseId={houseId} note={current} /> : (
        <Card><Empty icon={Check} title={t('Нечего проверять')} text={t('Когда ИИ разберёт запись, здесь появятся задачи: поправьте исполнителей и подтвердите.')} /></Card>
      )}
    </div>
  )
}

function toDraft(c: VoiceTaskCandidate): Draft {
  const where = [c.location.entrance && t('подъезд {n}', { n: c.location.entrance }), c.location.floor && t('этаж {n}', { n: c.location.floor }), c.location.detail].filter(Boolean).join(', ')
  const description = [c.description, where && t('Место: {place}', { place: where }), c.due_hint && t('Срок: {due}', { due: c.due_hint })].filter(Boolean).join('\n') || null
  return { on: true, title: c.title, specialization: c.specialization ?? '', priority: c.priority, assignee: c.suggested_assignee_id ?? '', description }
}

function NoteReview({ houseId, note }: { houseId: string; note: VoiceNoteView }) {
  const qc = useQueryClient()
  const [drafts, setDrafts] = useState<Draft[]>(() => note.tasks.map(toDraft))
  const assignees = useQuery({ queryKey: ['house', houseId, 'assignees'], queryFn: () => api<Assignees>(`/houses/${houseId}/tasks/assignees`) })
  const refresh = () => qc.invalidateQueries({ queryKey: ['house', houseId, 'voice-notes'] })
  const confirm = useMutation({
    mutationFn: (body: ConfirmVoiceTasksBody) => api<VoiceNoteView>(`/houses/${houseId}/voice-notes/${note.id}/confirm-tasks`, { method: 'POST', body }),
    onSuccess: async () => { await refresh(); await qc.invalidateQueries({ queryKey: ['house', houseId, 'tasks'] }) },
  })
  const dismiss = useMutation({ mutationFn: () => api(`/houses/${houseId}/voice-notes/${note.id}/dismiss`, { method: 'POST' }), onSuccess: refresh })
  const retry = useMutation({ mutationFn: () => api(`/houses/${houseId}/voice-notes/${note.id}/retry`, { method: 'POST' }), onSuccess: refresh })
  const set = (i: number, patch: Partial<Draft>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const chosen = drafts.filter((d) => d.on && d.title.trim().length >= 3)

  return (
    <Card>
      <CardHead
        icon={Mic}
        title={note.status === 'REVIEWED' ? t('Голосовое разобрано') : note.status === 'FAILED' ? t('Не удалось распознать') : note.status === 'PROCESSING' ? t('Распознаётся') : t('Проверьте задачи')}
        sub={note.status === 'EXTRACTED' ? t('ИИ мог ошибиться в именах и местах. Снимите лишнее, поправьте исполнителей — задачи уйдут работникам с уведомлением.') : undefined}
        aside={<Tag tone={STATUS[note.status].tone}>{t(STATUS[note.status].label)}</Tag>}
      />
      {note.status === 'PROCESSING' && <Skeleton rows={4} />}
      {note.status === 'FAILED' && (
        <div className="flex flex-col items-start gap-3">
          <ErrorNote>{note.error}</ErrorNote>
          <div className="flex gap-2">
            <Btn icon={RotateCcw} loading={retry.isPending} onClick={() => retry.mutate()}>{t('Повторить')}</Btn>
            <Btn variant="ghost" onClick={() => dismiss.mutate()}>{t('Убрать')}</Btn>
          </div>
        </div>
      )}
      {note.transcript && (
        <details className="mb-5 rounded-[18px] bg-surface-2 px-4 py-3" open={note.status !== 'REVIEWED'}>
          <summary className="cursor-pointer text-[13.5px] font-semibold text-ink">{t('Расшифровка')}</summary>
          <p className="mt-2 whitespace-pre-line text-[14px] leading-relaxed text-ink-2">{note.transcript}</p>
        </details>
      )}
      {note.status === 'REVIEWED' && (
        <p className="text-[14px] text-ink-2">{note.created_task_ids.length ? t('Создано задач: {n}. Они в разделе «Задачи».', { n: note.created_task_ids.length }) : t('Задачи из этого голосового не создавались.')}</p>
      )}
      {note.status === 'EXTRACTED' && (
        <>
          {drafts.length === 0 && <Empty icon={X} title={t('Задач не нашлось')} text={t('В записи не прозвучало конкретных поручений. Можно записать ещё раз.')} />}
          <ul className="flex flex-col gap-3">
            {drafts.map((d, i) => (
              <li key={i} className={cn('rounded-[20px] p-4 transition-colors', d.on ? 'bg-surface-2' : 'bg-surface-2/50')}>
                <label className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-ink">
                  <input type="checkbox" checked={d.on} onChange={(e) => set(i, { on: e.target.checked })} className="size-4 accent-[var(--color-brand-600)]" />
                  {t('Создать задачу {n}', { n: i + 1 })}
                  {note.tasks[i]?.mentioned_assignee && <span className="font-normal text-ink-2">· {t('названо: «{name}»', { name: note.tasks[i]!.mentioned_assignee! })}</span>}
                </label>
                <div className={cn('grid gap-3 sm:grid-cols-2', !d.on && 'pointer-events-none opacity-50')}>
                  <div className="sm:col-span-2">
                    <Field label={t('Что сделать')}>{(id) => <Input id={id} value={d.title} onChange={(v) => set(i, { title: v })} maxLength={200} />}</Field>
                  </div>
                  <Field label={t('Исполнитель')}>
                    {(id) => <Select id={id} value={d.assignee} onChange={(v) => set(i, { assignee: v })} options={[{ v: '', label: t('Назначу позже') }, ...(assignees.data?.workers ?? []).map((w) => ({ v: w.id, label: `${w.name} · ${t('задач: {n}', { n: w.active_tasks })}` }))]} />}
                  </Field>
                  <Field label={t('Специализация')}>
                    {(id) => <Select id={id} value={d.specialization} onChange={(v) => set(i, { specialization: v })} options={[{ v: '', label: t('Не указана') }, ...Specialization.map((s) => ({ v: s, label: SPECIALIZATION_LABELS[s] ?? s }))]} />}
                  </Field>
                  <Field label={t('Приоритет')}>
                    {(id) => <Select id={id} value={d.priority} onChange={(v) => set(i, { priority: v })} options={Priority.map((p) => ({ v: p, label: PRIORITY_LABELS[p] ?? p }))} />}
                  </Field>
                  {d.description && <p className="self-end whitespace-pre-line text-[12.5px] text-ink-2">{d.description}</p>}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4"><ErrorNote>{confirm.error?.message}</ErrorNote></div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Btn
              icon={Check} loading={confirm.isPending} disabled={!chosen.length}
              onClick={() => confirm.mutate({
                tasks: chosen.map((d) => ({
                  title: d.title.trim(), description: d.description, specialization: (d.specialization || null) as ConfirmVoiceTasksBody['tasks'][number]['specialization'],
                  priority: d.priority as ConfirmVoiceTasksBody['tasks'][number]['priority'], assignee_id: d.assignee || null,
                })),
              })}
            >
              {t('Создать задачи: {n}', { n: chosen.length })}
            </Btn>
            <Btn variant="ghost" loading={dismiss.isPending} onClick={() => dismiss.mutate()}>{t('Ничего не создавать')}</Btn>
          </div>
        </>
      )}
    </Card>
  )
}
