import { Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Query, StreamableFile } from '@nestjs/common'
import { HouseScope } from '../../common/decorators'
import { DocumentsService, type FileOut } from './documents.service'

const MEMBERS = ['CHAIRMAN', 'ACCOUNTANT', 'WORKER', 'RESIDENT'] as const

/** Имя файла по RFC 5987: кириллица в Content-Disposition без искажений */
function file(f: FileOut): StreamableFile {
  const ascii = f.name.replace(/[^\x20-\x7e]/g, '_')
  return new StreamableFile(f.body, {
    type: f.type,
    length: f.body.length,
    disposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  })
}

/**
 * Печатные формы и выгрузки (docs/10 §7, docs/09 §7). Права наследуются от данных: отчёт жильцу —
 * только опубликованный, протокол — только опубликованный, журнал и должники — правлению.
 */
@Controller('houses/:houseId')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @HouseScope(...MEMBERS) @Get('reports/:reportId/pdf')
  async reportPdf(@Param('reportId', ParseUUIDPipe) id: string) {
    return file(await this.docs.reportPdf(id))
  }

  @HouseScope(...MEMBERS) @Get('reports/:reportId/xlsx')
  async reportXlsx(@Param('reportId', ParseUUIDPipe) id: string) {
    return file(await this.docs.reportXlsx(id))
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('annual-reports/:year')
  annual(@Param('year', ParseIntPipe) year: number) {
    return this.docs.annual(year)
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('annual-reports/:year/pdf')
  async annualPdf(@Param('year', ParseIntPipe) year: number) {
    return file(await this.docs.annualPdf(year))
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('annual-reports/:year/xlsx')
  async annualXlsx(@Param('year', ParseIntPipe) year: number) {
    return file(await this.docs.annualXlsx(year))
  }

  @HouseScope(...MEMBERS) @Get('votes/:voteId/protocol/pdf')
  async protocolPdf(@Param('voteId', ParseUUIDPipe) id: string) {
    return file(await this.docs.protocolPdf(id))
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('exports/transactions')
  async transactions(@Query('from') from: string, @Query('to') to: string) {
    return file(await this.docs.transactionsXlsx(from ?? '', to ?? from ?? ''))
  }

  @HouseScope('CHAIRMAN', 'ACCOUNTANT') @Get('exports/debtors')
  async debtors() {
    return file(await this.docs.debtorsXlsx())
  }
}
