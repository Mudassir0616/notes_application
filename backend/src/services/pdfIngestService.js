import prisma from "../lib/prisma.js";
import { extractPdfText } from "../lib/pdfText.js";
import { indexNoteSafely } from "./noteSearchService.js";

/**
 * Processing one claimed PDF job: bytes in, Note out.
 *
 * This is where the "no duplicate note" guarantee is actually made. The
 * expensive part (OCR) happens outside any transaction — holding a database
 * connection open for minutes would be far worse than redoing the work — and
 * then the note and the job's terminal state commit *together*:
 *
 *   crash before the commit → nothing was written; the job is reclaimed and
 *                             re-runs from the top, producing one note.
 *   crash after the commit  → the job is already DONE, so it is never claimed
 *                             again, and the note it produced is the only one.
 *
 * There is no in-between where a note exists but the job still looks runnable,
 * which is the state that would let a retry create a second copy.
 */
export async function processPdfJob(job) {
    if (!job.fileData) {
        throw new Error("Job has no file data to process");
    }

    // Minutes, potentially. Nothing is locked while this runs.
    const { text, pages, usedOcr } = await extractPdfText(job.fileData);

    const note = await prisma.$transaction(async (tx) => {
        const created = await tx.note.create({
            data: {
                title: job.fileName,
                content: text,

                // From the job row, which copied them from the verified JWT at
                // enqueue time. The worker has no request of its own to read.
                tenantId: job.tenantId,
                authorId: job.authorId,

                sourceType: "PDF",
                sourceName: job.fileName,
            },
        });

        await tx.pdfJob.update({
            where: { id: job.id },
            data: {
                status: "DONE",
                noteId: created.id,
                pages,
                usedOcr,
                error: null,
                heartbeatAt: null,
                finishedAt: new Date(),
                // The upload has served its purpose; don't keep 10 MB per job.
                fileData: null,
            },
        });

        return created;
    });

    // Outside the transaction on purpose: this is a network call to Pinecone,
    // and it is best-effort by design (see indexNoteSafely). A note that fails
    // to index is still a successful ingestion — it just needs a re-index
    // before it turns up in search.
    await indexNoteSafely(note);

    return note;
}
