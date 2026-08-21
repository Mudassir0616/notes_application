-- CreateEnum
CREATE TYPE "PdfJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "PdfJob" (
    "id" TEXT NOT NULL,
    "status" "PdfJobStatus" NOT NULL DEFAULT 'PENDING',
    "tenantId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileData" BYTEA,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" TIMESTAMP(3),
    "noteId" TEXT,
    "pages" INTEGER,
    "usedOcr" BOOLEAN,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PdfJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PdfJob_status_runAfter_idx" ON "PdfJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "PdfJob_tenantId_createdAt_idx" ON "PdfJob"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PdfJob_authorId_idx" ON "PdfJob"("authorId");

-- CreateIndex
CREATE INDEX "PdfJob_noteId_idx" ON "PdfJob"("noteId");

-- AddForeignKey
ALTER TABLE "PdfJob" ADD CONSTRAINT "PdfJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PdfJob" ADD CONSTRAINT "PdfJob_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PdfJob" ADD CONSTRAINT "PdfJob_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;
