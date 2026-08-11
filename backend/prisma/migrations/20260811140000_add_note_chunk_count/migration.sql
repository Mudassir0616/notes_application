-- Tracks how many chunk vectors a note currently has in Pinecone, so deletion
-- can address them by exact id rather than discovering them with an eventually
-- consistent list call.
ALTER TABLE "Note" ADD COLUMN "chunkCount" INTEGER NOT NULL DEFAULT 0;
