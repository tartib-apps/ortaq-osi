import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import {
  confirmVoiceTasksBody, createComparisonBody, createVoiceNoteBody, decideComparisonBody, legalAskBody,
  type ConfirmVoiceTasksBody, type CreateComparisonBody, type CreateVoiceNoteBody, type DecideComparisonBody, type LegalAskBody,
} from '@ortaq/shared'
import { ctx } from '../../common/context'
import { HouseScope, Rate } from '../../common/decorators'
import { ZodPipe } from '../../common/zod.pipe'
import { AiService } from '../../integrations/ai/ai.service'
import { LegalService } from './legal.service'
import { ProposalsService } from './proposals.service'
import { SummariesService } from './summaries.service'
import { VoiceNotesService } from './voice-notes.service'

/**
 * ИИ-надстройка, docs/03 §17. Долгие функции (голосовое, КП) асинхронные: ответ сразу со статусом
 * PROCESSING, экран опрашивает сущность. Ни один эндпоинт не меняет состояние дома без человека.
 */
@Controller('houses/:houseId')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly voice: VoiceNotesService,
    private readonly proposals: ProposalsService,
    private readonly legal: LegalService,
    private readonly summaries: SummariesService,
  ) {}

  @HouseScope('CHAIRMAN') @Get('ai/usage')
  usage() {
    return this.ai.usage(ctx().houseId ?? '')
  }

  /* ───────── голосовые задачи ───────── */

  @HouseScope('CHAIRMAN') @Rate('ai') @Post('voice-notes')
  createVoice(@Body(new ZodPipe(createVoiceNoteBody)) body: CreateVoiceNoteBody) {
    return this.voice.create(body)
  }

  @HouseScope('CHAIRMAN') @Get('voice-notes')
  listVoice() {
    return this.voice.list()
  }

  @HouseScope('CHAIRMAN') @Get('voice-notes/:id')
  voiceDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.voice.detail(id)
  }

  @HouseScope('CHAIRMAN') @Rate('ai') @Post('voice-notes/:id/retry') @HttpCode(200)
  retryVoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.voice.retry(id)
  }

  @HouseScope('CHAIRMAN') @Post('voice-notes/:id/confirm-tasks') @HttpCode(200)
  confirmVoice(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(confirmVoiceTasksBody)) body: ConfirmVoiceTasksBody) {
    return this.voice.confirm(id, body)
  }

  @HouseScope('CHAIRMAN') @Post('voice-notes/:id/dismiss') @HttpCode(200)
  dismissVoice(@Param('id', ParseUUIDPipe) id: string) {
    return this.voice.dismiss(id)
  }

  /* ───────── сравнение КП ───────── */

  @HouseScope('CHAIRMAN') @Rate('ai') @Post('proposals/compare')
  compare(@Body(new ZodPipe(createComparisonBody)) body: CreateComparisonBody) {
    return this.proposals.create(body)
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('comparisons')
  comparisons() {
    return this.proposals.list()
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('comparisons/:id')
  comparison(@Param('id', ParseUUIDPipe) id: string) {
    return this.proposals.detail(id)
  }

  @HouseScope('CHAIRMAN') @Rate('ai') @Post('comparisons/:id/retry') @HttpCode(200)
  retryComparison(@Param('id', ParseUUIDPipe) id: string) {
    return this.proposals.retry(id)
  }

  @HouseScope('CHAIRMAN') @Post('comparisons/:id/decide') @HttpCode(200)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideComparisonBody)) body: DecideComparisonBody) {
    return this.proposals.decide(id, body)
  }

  /* ───────── юрпомощник ───────── */

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Rate('ai') @Post('legal/ask') @HttpCode(200)
  ask(@Body(new ZodPipe(legalAskBody)) body: LegalAskBody) {
    return this.legal.ask(body)
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('legal/history')
  legalHistory() {
    return this.legal.history()
  }

  /* ───────── сводка недели ───────── */

  /** Обёртка вместо голого null: «сводок пока нет» — нормальный ответ, а не пустое тело */
  @HouseScope() @Get('summary/latest')
  async latestSummary() {
    return { summary: await this.summaries.latest() }
  }

  @HouseScope() @Get('summaries')
  summaryList() {
    return this.summaries.list()
  }

  @HouseScope('CHAIRMAN') @Rate('ai') @Post('summary/generate') @HttpCode(200)
  generateSummary() {
    return this.summaries.generateNow()
  }
}
