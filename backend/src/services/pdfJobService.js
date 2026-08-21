import prisma from "../lib/prisma.js";

/**
 * The PDF ingestion queue.
 *
 * A queue is just three guarantees, and this file is one function per guarantee:
 *
 *   1. `claimNextJob`  — exactly one worker gets any given job (SKIP LOCKED).
 *   2. `reclaimStaleJobs` — a job held by a worker that died comes back.
 *   3. `failJob` — a job that keeps failing eventually stops (attempt cap).
 *
 * It runs on Postgres rather than Redis or SQS. That is a deliberate trade: a
 * dedicated broker scales further, but here the job's terminal state and the
 * Note it produces have to commit together, and only a shared database makes
 * that a single transaction instead of a distributed one.
 */

/** Tries before a job is parked as FAILED. A transient blip gets ~3 chances. */
const MAX_ATTEMPTS = Number.parseInt(process.env.PDF_JOB_MAX_ATTEMPTS, 10) || 3;

/**
 * How long a RUNNING job may go without a heartbeat before another worker may
 * take it. Must be comfortably larger than the heartbeat interval in
 * `workers/pdfWorker.js`, or live jobs get stolen mid-OCR.
 */
const STALE_AFTER_SECONDS = Number.parseInt(process.env.PDF_JOB_STALE_SECONDS, 10) || 120;

/** Fields safe to hand back to an API caller — never `fileData`. */
const PUBLIC_FIELDS = {
    id: true,
    status: true,
    fileName: true,
    fileSize: true,
    attempts: true,
    noteId: true,
    pages: true,
    usedOcr: true,
    error: true,
    startedAt: true,
    finishedAt: true,
    createdAt: true,
    updatedAt: true,
};

export function maxAttempts() {
    return MAX_ATTEMPTS;
}

/**
 * Every timestamp below comes from this process, never from SQL `NOW()`.
 *
 * The heartbeat is written by Prisma and compared in hand-written SQL, and those
 * two paths have to agree about what "now" means. They did not, at first: Prisma
 * maps `DateTime` to `timestamp without time zone` and writes UTC into it, while
 * anything arriving from SQL — `NOW()`, or a bound date parameter — is converted
 * to the database session's local zone on the way in. On an Asia/Kolkata server
 * that is a 5.5-hour gap, which made every heartbeat look hours stale: healthy
 * jobs were reclaimed the moment they reported progress, torn away from their
 * worker mid-OCR, and retried until they ran out of attempts.
 *
 * The fix is in two halves. `PdfJob`'s columns are `@db.Timestamptz(3)`, so the
 * database stores an instant rather than a wall-clock reading and no conversion
 * happens on either path. And every value below is stamped here, so one clock
 * decides both the write and the comparison. Multiple worker hosts then depend
 * on their clocks roughly agreeing, which against a 120-second window is not a
 * real constraint.
 */
function nowStamp() {
    return new Date();
}

/** Exponential backoff, capped. attempt 1 → 30s, 2 → 60s, 3 → 120s, … max 5m. */
function backoffUntil(attempts) {
    const seconds = Math.min(30 * 2 ** Math.max(attempts - 1, 0), 300);

    return new Date(Date.now() + seconds * 1000);
}

/**
 * Accepts an upload for later processing.
 *
 * The tenant and author are copied from the verified JWT *here*, at the only
 * point where a request context still exists. The worker later trusts this row
 * and nothing else — which is what keeps tenant isolation intact across the
 * hand-off from request to background job.
 */
export async function enqueuePdfJob({ tenantId, authorId, file }) {
    return prisma.pdfJob.create({
        data: {
            tenantId,
            authorId,
            fileName: file.originalname,
            fileSize: file.size,
            fileData: file.buffer,
        },
        select: PUBLIC_FIELDS,
    });
}

/**
 * Atomically takes the oldest eligible job, or returns null if there is none.
 *
 * The whole concurrency story is the one SQL statement below. `FOR UPDATE SKIP
 * LOCKED` makes the row selection and the status flip a single atomic step: two
 * workers polling at the same instant cannot both see the same PENDING row,
 * because the second one skips the row the first has locked rather than
 * blocking on it. Doing this as `findFirst` then `update` in Prisma would leave
 * a window between the read and the write where both workers believe they won,
 * and the same PDF would be ingested twice.
 */
export async function claimNextJob() {
    const now = nowStamp();

    const rows = await prisma.$queryRaw`
        UPDATE "PdfJob"
        SET status       = 'RUNNING'::"PdfJobStatus",
            attempts     = attempts + 1,
            "startedAt"  = COALESCE("startedAt", ${now}),
            "heartbeatAt"= ${now},
            "updatedAt"  = ${now}
        WHERE id = (
            SELECT id
            FROM "PdfJob"
            WHERE status = 'PENDING'::"PdfJobStatus"
              AND "runAfter" <= ${now}
            ORDER BY "runAfter" ASC, "createdAt" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        )
        RETURNING id
    `;

    if (!rows.length) return null;

    // Re-read through Prisma to get the row typed and to pull `fileData`, which
    // is deliberately kept out of the RETURNING clause above — no reason to haul
    // 10 MB of bytes through a lock-holding statement.
    return prisma.pdfJob.findUnique({ where: { id: rows[0].id } });
}

/** Says "still alive" so `reclaimStaleJobs` leaves this job alone. */
export async function heartbeat(jobId) {
    await prisma.pdfJob.updateMany({
        where: { id: jobId, status: "RUNNING" },
        data: { heartbeatAt: nowStamp() },
    });
}

/**
 * Returns jobs abandoned by a dead worker to the queue.
 *
 * Without this, killing a worker mid-OCR leaves the row RUNNING forever and the
 * user polls a job that will never move. A crashed process cannot clean up
 * after itself, so recovery has to be someone else's periodic job — here, the
 * next worker to run an idle tick.
 *
 * A job that has already burned its attempts is retired instead of re-queued,
 * so a PDF that reliably kills the worker cannot become an infinite loop.
 */
export async function reclaimStaleJobs() {
    const now = nowStamp();

    // Computed here rather than as `NOW() - interval` for the reason above: this
    // is compared against heartbeats that Prisma wrote, so it must share their clock.
    const staleBefore = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);

    const rows = await prisma.$queryRaw`
        UPDATE "PdfJob"
        SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS}
                          THEN 'FAILED'::"PdfJobStatus"
                          ELSE 'PENDING'::"PdfJobStatus" END,
            error  = CASE WHEN attempts >= ${MAX_ATTEMPTS}
                          THEN 'Processing was interrupted and did not recover after repeated attempts.'
                          ELSE error END,
            "finishedAt" = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN ${now} ELSE NULL END,
            -- Free the bytes only when giving up; a retry still needs them.
            "fileData"   = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE "fileData" END,
            "heartbeatAt"= NULL,
            "runAfter"   = ${now},
            "updatedAt"  = ${now}
        WHERE status = 'RUNNING'::"PdfJobStatus"
          AND "heartbeatAt" < ${staleBefore}
        RETURNING id, status
    `;

    return rows;
}

/**
 * Records a failed attempt.
 *
 * `terminal` short-circuits the retry budget: a PDF with no readable text is
 * not a transient fault and will fail identically forever, so retrying it only
 * spends CPU and makes the user wait longer for the same answer.
 */
export async function failJob(jobId, error, { terminal = false } = {}) {
    const job = await prisma.pdfJob.findUnique({
        where: { id: jobId },
        select: { attempts: true },
    });

    if (!job) return null;

    const giveUp = terminal || job.attempts >= MAX_ATTEMPTS;

    return prisma.pdfJob.update({
        where: { id: jobId },
        data: {
            status: giveUp ? "FAILED" : "PENDING",
            error: String(error?.message || error),
            heartbeatAt: null,
            runAfter: giveUp ? nowStamp() : backoffUntil(job.attempts),
            finishedAt: giveUp ? nowStamp() : null,
            // Terminal state means nobody will read these bytes again.
            ...(giveUp && { fileData: null }),
        },
        select: PUBLIC_FIELDS,
    });
}

/**
 * Reads one job for a caller.
 *
 * Scoped exactly like the note routes it sits beside: tenant always, plus
 * author for a MEMBER. A job id is a uuid, but guessing is not the threat —
 * leaking one tenant's filenames and error text to another is.
 */
export async function getJobForUser({ jobId, tenantId, userId, role }) {
    const where = { id: jobId, tenantId };

    if (role === "MEMBER") where.authorId = userId;

    return prisma.pdfJob.findFirst({ where, select: PUBLIC_FIELDS });
}

/** Recent jobs for the caller, newest first. Powers the frontend's upload list. */
export async function listJobsForUser({ tenantId, userId, role, limit = 20 }) {
    const where = { tenantId };

    if (role === "MEMBER") where.authorId = userId;

    return prisma.pdfJob.findMany({
        where,
        select: PUBLIC_FIELDS,
        orderBy: { createdAt: "desc" },
        take: limit,
    });
}
