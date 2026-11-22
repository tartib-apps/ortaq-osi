import { MAX_UPLOAD_BYTES, type FilePurpose, type FileView, type UploadUrlResponse } from '@ortaq/shared'
import { api, ApiError } from './client'
import { t } from '../i18n'

const ACCEPTED: Record<string, string> = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'application/pdf': 'PDF' }
export const ACCEPT_ATTR = Object.keys(ACCEPTED).join(',')
/** Голосовое: тип записи без параметров кодека — «audio/webm;codecs=opus» → «audio/webm» */
const AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']
export const AUDIO_ACCEPT_ATTR = [...AUDIO, 'audio/x-m4a', 'audio/x-wav', 'audio/mp3'].join(',')
const ALIASES: Record<string, string> = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/x-wav': 'audio/wav', 'audio/mp3': 'audio/mpeg' }
const PHOTO_BYTES = 15 * 1024 * 1024

/**
 * Загрузка в три шага (docs/03 §14): ссылка с зашитыми типом и размером → файл прямо
 * в хранилище, минуя API → finalize, где сервер проверяет содержимое. Возвращает id файла.
 */
export async function uploadFile(houseId: string, file: File, purpose: FilePurpose): Promise<FileView> {
  const base = file.type.split(';')[0]!.trim()
  const type = ALIASES[base] ?? base
  if (purpose === 'VOICE_NOTE' ? !AUDIO.includes(type) : !ACCEPTED[type]) {
    throw new ApiError(400, 'VALIDATION_FAILED', purpose === 'VOICE_NOTE' ? 'Поддерживаются записи WebM, OGG, M4A, MP3 и WAV' : 'Поддерживаются фото (JPEG, PNG, WebP) и PDF')
  }
  const limit = purpose === 'PROPOSAL' ? MAX_UPLOAD_BYTES : PHOTO_BYTES
  if (file.size > limit) throw new ApiError(400, 'VALIDATION_FAILED', t('Файл больше {n} МБ', { n: Math.round(limit / 1024 / 1024) }))
  const ticket = await api<UploadUrlResponse>(`/houses/${houseId}/files/upload-url`, {
    method: 'POST',
    body: { purpose, mime_type: type, size_bytes: file.size, name: file.name },
  })
  let put: Response
  try {
    put = await fetch(ticket.upload_url, { method: ticket.method, headers: ticket.headers, body: file })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Файл не загрузился: нет связи с хранилищем')
  }
  if (!put.ok) throw new ApiError(put.status, 'UPLOAD_FAILED', 'Хранилище не приняло файл. Попробуйте ещё раз')
  return api<FileView>(`/houses/${houseId}/files/${ticket.file_id}/finalize`, { method: 'POST' })
}

/** Открыть файл: ссылка живёт 5 минут, поэтому берётся в момент нажатия */
export async function openFile(houseId: string, fileId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/houses/${houseId}/files/${fileId}/download-url`)
  window.open(url, '_blank', 'noopener')
}
