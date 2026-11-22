import { Inject, Injectable, Logger } from '@nestjs/common'
import type { VoiceNote } from '@prisma/client'
import {
  confirmVoiceTasksBody, createVoiceNoteBody, ErrorCode, MAX_UPLOAD_BYTES,
  type ConfirmVoiceTasksBody, type CreateVoiceNoteBody, type VoiceNoteView, type VoiceTaskCandidate,
} from '@ortaq/shared'
import { ctx } from '../../common/context'
import { AppError, notFound, unprocessable } from '../../common/errors'
import { PrismaService } from '../../infra/prisma.service'
import { AiService } from '../../integrations/ai/ai.service'
import type { VoiceExtractionOut } from '../../integrations/ai/schemas'
import { STORAGE_PROVIDER, type StorageProvider } from '../../integrations/storage/storage.provider'
import { AuditService } from '../audit/audit.service'
import { FilesService } from '../files/files.service'
import { TasksService } from '../tasks/tasks.service'
import { words } from '../../integrations/ai/rules-ai.provider'

const wrongState = (message: string) => new AppError(409, ErrorCode.AI_STATE, message)

/**
 * Задачи из голосового председателя (docs/11 §3.4, docs/03 §17). Модель расшифровывает и
 * предлагает задачи; создаются они только по подтверждению председателя — неверно назначенная
 * задача означает невыполненную работу. Имя исполнителя сопоставляется здесь, а не моделью:
 * справочник персонала наружу не уходит.
 */
@Injectable()
export class VoiceNotesService {
  private readonly log = new Logger('VoiceNotes')

  constructor(
    private readonly db: PrismaService,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  async create(input: CreateVoiceNoteBody): Promise<VoiceNoteView> {
    const b = createVoiceNoteBody.parse(input)
    const userId = ctx().userId ?? ''
    const note = await this.db.run(async (tx) => {
      const n = await tx.voiceNote.create({ data: { houseId: ctx().houseId ?? '', authorId: userId, audioFileId: b.audio_file_id, durationSec: b.duration_sec } })
      await this.files.attach(tx, [b.audio_file_id], 'VOICE_NOTE', n.id, userId, 'VOICE_NOTE')
      await this.audit.append(tx, { action: 'voice_note.create', entityType: 'VoiceNote', entityId: n.id, after: { duration_sec: b.duration_sec } })
      return n
    })
    // Распознавание занимает до минуты: председатель видит «обрабатывается», экран опрашивает статус
    void this.process(note.id)
    return view(note)
  }

  /** Повтор после сбоя модели или исчерпанного лимита: запись сохранена (docs/11 §4) */
  async retry(id: string): Promise<VoiceNoteView> {
    const note = await this.find(id)
    if (note.status !== 'FAILED') throw wrongState('Повторить можно только неудавшееся распознавание')
    const updated = await this.db.run((tx) => tx.voiceNote.update({ where: { id }, data: { status: 'PROCESSING', error: null } }))
    void this.process(id)
    return view(updated)
  }

  async list(): Promise<VoiceNoteView[]> {
    const rows = await this.db.run((tx) => tx.voiceNote.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }))
    return rows.map(view)
  }

  async detail(id: string): Promise<VoiceNoteView> {
    return view(await this.find(id))
  }

  /** Председатель поправил список — только теперь задачи появляются у работников с уведомлением */
  async confirm(id: string, input: ConfirmVoiceTasksBody): Promise<VoiceNoteView> {
    const b = confirmVoiceTasksBody.parse(input)
    const note = await this.find(id)
    if (note.status !== 'EXTRACTED') throw wrongState(note.status === 'REVIEWED' ? 'Задачи из этого голосового уже созданы' : 'Голосовое ещё не разобрано')
    // Отметка до создания: двойное нажатие не породит задачи дважды
    const claimed = await this.db.run((tx) => tx.voiceNote.updateMany({ where: { id, status: 'EXTRACTED' }, data: { status: 'REVIEWED', reviewedAt: new Date() } }))
    if (claimed.count === 0) throw wrongState('Задачи из этого голосового уже созданы')

    const created: string[] = []
    try {
      for (const t of b.tasks) {
        const task = await this.tasks.create(
          { title: t.title, description: t.description ?? null, specialization: t.specialization ?? null, priority: t.priority, assignee_id: t.assignee_id ?? null, contractor_id: t.contractor_id ?? null, due_at: t.due_at ?? null, requires_photo: true },
          { voiceNoteId: id },
        )
        created.push(task.id)
      }
    } catch (e) {
      // Часть задач могла создаться: фиксируем их, остальное председатель добавит вручную
      await this.db.run((tx) => tx.voiceNote.update({ where: { id }, data: { createdTaskIds: created } }))
      throw e
    }
    const candidates = note.extractedTasks as VoiceTaskCandidate[]
    const untouched = b.tasks.length === candidates.length && b.tasks.every((t, i) => t.title === candidates[i]?.title && (t.assignee_id ?? null) === (candidates[i]?.suggested_assignee_id ?? null))
    await this.ai.decide(note.aiJobId, untouched ? 'ACCEPTED' : 'MODIFIED')
    const updated = await this.db.run(async (tx) => {
      const n = await tx.voiceNote.update({ where: { id }, data: { createdTaskIds: created } })
      await this.audit.append(tx, { action: 'voice_note.confirm', entityType: 'VoiceNote', entityId: id, after: { tasks: created.length, edited: !untouched } })
      return n
    })
    return view(updated)
  }

  /** Отказ от всех кандидатов: оценка «ИИ не помог», задачи не создаются */
  async dismiss(id: string): Promise<VoiceNoteView> {
    const note = await this.find(id)
    if (note.status !== 'EXTRACTED' && note.status !== 'FAILED') throw wrongState('Голосовое уже разобрано')
    await this.ai.decide(note.aiJobId, 'REJECTED')
    const updated = await this.db.run((tx) => tx.voiceNote.update({ where: { id }, data: { status: 'REVIEWED', reviewedAt: new Date() } }))
    return view(updated)
  }

  private async process(id: string): Promise<void> {
    try {
      const { note, file, house, staff } = await this.db.run(async (tx) => {
        const note = await tx.voiceNote.findFirstOrThrow({ where: { id } })
        const file = await tx.file.findFirstOrThrow({ where: { id: note.audioFileId } })
        const house = await tx.house.findFirstOrThrow({ where: { id: note.houseId }, select: { entranceCount: true, floorCount: true } })
        const staff = await tx.houseMembership.findMany({ where: { role: 'WORKER', status: 'ACTIVE' }, select: { userId: true, user: { select: { fullName: true } } } })
        return { note, file, house, staff }
      })
      if (!this.ai.capable) throw new AppError(503, ErrorCode.AI_UNAVAILABLE, 'Распознавание речи недоступно: ИИ не подключён. Запись сохранена — повторите позже')
      const audio = await this.storage.read(file.storageKey, MAX_UPLOAD_BYTES)
      if (!audio) throw unprocessable(ErrorCode.FILE_NOT_UPLOADED, 'Запись не найдена в хранилище')
      const res = await this.ai.voice(note.houseId, note.id, { audio, mimeType: file.mimeType, entrances: house.entranceCount, floors: house.floorCount })
      const tasks = candidates(res.value, staff.map((s) => ({ id: s.userId, name: s.user.fullName ?? '' })))
      await this.db.run((tx) => tx.voiceNote.update({ where: { id }, data: { status: 'EXTRACTED', transcript: res.value.transcript, extractedTasks: tasks, aiJobId: res.jobId } }))
    } catch (e) {
      const message = e instanceof AppError ? e.message : 'Не удалось разобрать запись. Повторите позже или создайте задачи вручную'
      if (!(e instanceof AppError)) this.log.error(e instanceof Error ? e.stack : String(e))
      await this.db.run((tx) => tx.voiceNote.update({ where: { id }, data: { status: 'FAILED', error: message } })).catch(() => undefined)
    }
  }

  private async find(id: string): Promise<VoiceNote> {
    const note = await this.db.run((tx) => tx.voiceNote.findFirst({ where: { id } }))
    if (!note) throw notFound('Голосовое')
    return note
  }
}

function candidates(out: VoiceExtractionOut, staff: { id: string; name: string }[]): VoiceTaskCandidate[] {
  return out.tasks.map((t) => ({
    title: t.title.trim().slice(0, 200),
    description: t.description,
    specialization: t.specialization,
    priority: t.priority,
    location: { type: t.location_type, entrance: t.entrance, floor: t.floor, detail: t.location_detail },
    mentioned_assignee: t.mentioned_assignee,
    suggested_assignee_id: t.mentioned_assignee ? matchStaff(t.mentioned_assignee, staff) : null,
    due_hint: t.due_hint,
  }))
}

/**
 * «Сергей», «Серёже», «Ерлан ага» → работник дома. Совпадение по началу слова, только однозначное:
 * два Сергея — не угадываем, председатель выберет сам
 */
export function matchStaff(mentioned: string, staff: { id: string; name: string }[]): string | null {
  const heard = [...words(mentioned)]
  if (!heard.length) return null
  // Сначала по четырём буквам; уменьшительные («Серёжа» — «Сергей») совпадают только в трёх
  for (const len of [4, 3]) {
    const hits = staff.filter((s) => [...words(s.name)].some((w) => heard.some((h) => w.startsWith(h.slice(0, len)))))
    if (hits.length) return hits.length === 1 ? hits[0]!.id : null
  }
  return null
}

function view(n: VoiceNote): VoiceNoteView {
  return {
    id: n.id, status: n.status, duration_sec: n.durationSec, transcript: n.transcript, tasks: n.extractedTasks as VoiceTaskCandidate[],
    error: n.error, created_task_ids: n.createdTaskIds, audio_file_id: n.audioFileId, created_at: n.createdAt.toISOString(),
  }
}
