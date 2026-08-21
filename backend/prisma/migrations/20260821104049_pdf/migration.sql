-- CreateEnum
CREATE TYPE "NoteSourceType" AS ENUM ('MANUAL', 'PDF');

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "sourceName" TEXT,
ADD COLUMN     "sourceType" "NoteSourceType" NOT NULL DEFAULT 'MANUAL';
