-- Фаза 5: ИИ-надстройка (docs/11). pgvector — для поиска по статьям законов
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "VoiceNoteStatus" AS ENUM ('PROCESSING', 'EXTRACTED', 'FAILED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "ComparisonStatus" AS ENUM ('PROCESSING', 'DONE', 'FAILED', 'DECIDED');

-- AlterEnum
ALTER TYPE "AiJobStatus" ADD VALUE 'REJECTED';

-- AlterEnum
ALTER TYPE "AiJobType" ADD VALUE 'RECEIPT_OCR';
ALTER TYPE "AiJobType" ADD VALUE 'VOICE_EXTRACT';
ALTER TYPE "AiJobType" ADD VALUE 'PROPOSAL_COMPARE';
ALTER TYPE "AiJobType" ADD VALUE 'LEGAL_QA';
ALTER TYPE "AiJobType" ADD VALUE 'WEEKLY_SUMMARY';

-- AlterEnum
ALTER TYPE "FilePurpose" ADD VALUE 'VOICE_NOTE';
ALTER TYPE "FilePurpose" ADD VALUE 'PROPOSAL';

-- AlterTable
ALTER TABLE "ai_jobs" ADD COLUMN     "tokens_in" INTEGER,
ADD COLUMN     "tokens_out" INTEGER;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "voice_note_id" UUID;

-- CreateTable
CREATE TABLE "voice_notes" (
    "id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "audio_file_id" UUID NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "transcript" TEXT,
    "extracted_tasks" JSONB NOT NULL DEFAULT '[]',
    "status" "VoiceNoteStatus" NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "ai_job_id" UUID,
    "created_task_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_comparisons" (
    "id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT,
    "status" "ComparisonStatus" NOT NULL DEFAULT 'PROCESSING',
    "analysis" JSONB,
    "recommended_index" INTEGER,
    "decided_proposal_id" UUID,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" TEXT,
    "vote_id" UUID,
    "error" TEXT,
    "ai_job_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_comparisons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_proposals" (
    "id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "comparison_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "contractor_name" TEXT,
    "parsed" JSONB,

    CONSTRAINT "commercial_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_documents" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "short_title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "version_date" DATE NOT NULL,
    "language" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "legal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "article" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),

    CONSTRAINT "legal_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_questions" (
    "id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "asked_by" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "ai_job_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_summaries" (
    "id" UUID NOT NULL,
    "house_id" UUID NOT NULL,
    "week_start" DATE NOT NULL,
    "week_end" DATE NOT NULL,
    "content" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "ai_job_id" UUID,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voice_notes_house_id_created_at_idx" ON "voice_notes"("house_id", "created_at");

-- CreateIndex
CREATE INDEX "proposal_comparisons_house_id_created_at_idx" ON "proposal_comparisons"("house_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_proposals_comparison_id_order_key" ON "commercial_proposals"("comparison_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "legal_documents_code_key" ON "legal_documents"("code");

-- CreateIndex
CREATE UNIQUE INDEX "legal_chunks_document_id_article_key" ON "legal_chunks"("document_id", "article");

-- CreateIndex
CREATE INDEX "legal_questions_house_id_created_at_idx" ON "legal_questions"("house_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_summaries_house_id_week_start_key" ON "weekly_summaries"("house_id", "week_start");

-- AddForeignKey
ALTER TABLE "voice_notes" ADD CONSTRAINT "voice_notes_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "houses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_comparisons" ADD CONSTRAINT "proposal_comparisons_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "houses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_proposals" ADD CONSTRAINT "commercial_proposals_comparison_id_fkey" FOREIGN KEY ("comparison_id") REFERENCES "proposal_comparisons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_chunks" ADD CONSTRAINT "legal_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "legal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_questions" ADD CONSTRAINT "legal_questions_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "houses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_summaries" ADD CONSTRAINT "weekly_summaries_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "houses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────── поиск по законодательству ─────────
-- Полнотекстовый индекс работает и без эмбеддингов: юрпомощник ищет статьи, даже если модель недоступна
ALTER TABLE legal_chunks ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('russian', coalesce(title, '')), 'A') || setweight(to_tsvector('russian', coalesce(content, '')), 'B')
) STORED;
CREATE INDEX legal_chunks_tsv_idx ON legal_chunks USING gin (tsv);
CREATE INDEX legal_chunks_embedding_idx ON legal_chunks USING hnsw (embedding vector_cosine_ops);

-- Корпус общий и правится только сидом (роль-владелец): приложению — чтение
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON legal_documents, legal_chunks FROM ortaq_app;

-- Сводка и история юрпомощника не переписываются задним числом
REVOKE UPDATE, DELETE, TRUNCATE ON legal_questions FROM ortaq_app;
REVOKE DELETE, TRUNCATE ON weekly_summaries, voice_notes, proposal_comparisons, commercial_proposals FROM ortaq_app;

-- ───────── изоляция домов (RLS) ─────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['voice_notes', 'proposal_comparisons', 'commercial_proposals', 'legal_questions', 'weekly_summaries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY house_isolation ON %I USING (app_bypass_rls() OR house_id = app_current_house()) WITH CHECK (app_bypass_rls() OR house_id = app_current_house())', t);
  END LOOP;
END $$;
