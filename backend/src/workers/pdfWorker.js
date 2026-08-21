import { UnprocessablePdfError } from "../lib/pdfText.js";
import {
    claimNextJob,
    heartbeat,
    failJob,
    reclaimStaleJobs,
} from "../services/pdfJobService.js";
import { processPdfJob } from "../services/pdfIngestService.js";

/**
 * The worker loop: claim a job, process it, repeat.
 *
 * Polling rather than push notification (Postgres LISTEN/NOTIFY, a broker) —
 * one query every couple of seconds against an indexed column is cheap, and it
 * has a property push does not: a worker that starts *after* a job was enqueued
 * still finds it. Nothing is lost when every worker is down.
 */

/** Idle gap between claim attempts. Only applies when the queue is empty. */
const POLL_INTERVAL_MS = Number.parseInt(process.env.PDF_WORKER_POLL_MS, 10) || 2000;

/**
 * How often a held job says it is still alive. Must be well under
 * PDF_JOB_STALE_SECONDS or a healthy job gets reclaimed out from under us.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** How often to look for jobs abandoned by a dead worker. */
const RECLAIM_INTERVAL_MS = 30_000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `processPdfJob` while pinging the job's heartbeat in the background.
 *
 * The heartbeat has to be on a timer rather than woven into the work, because
 * the work is one long opaque await — OCR does not report progress, and a job
 * that is merely slow must not look dead.
 */
async function processWithHeartbeat(job) {
    const timer = setInterval(() => {
        heartbeat(job.id).catch((error) => {
            console.error(`[pdf-worker] heartbeat failed for ${job.id}:`, error.message);
        });
    }, HEARTBEAT_INTERVAL_MS);

    // Don't let the heartbeat timer hold the process open at shutdown.
    timer.unref?.();

    try {
        return await processPdfJob(job);
    } finally {
        clearInterval(timer);
    }
}

/**
 * Starts the loop.
 *
 * @returns {{stop: () => Promise<void>}} `stop` stops claiming new work and
 *   resolves once the job in flight has finished — so a deploy does not sever
 *   an OCR run that was thirty seconds from done.
 */
export function startPdfWorker({ pollIntervalMs = POLL_INTERVAL_MS } = {}) {
    let running = true;
    let lastReclaimAt = 0;

    const loop = (async () => {
        console.log(`[pdf-worker] started (polling every ${pollIntervalMs}ms)`);

        while (running) {
            try {
                // Recovery pass, on a slower cadence than the claim poll.
                if (Date.now() - lastReclaimAt > RECLAIM_INTERVAL_MS) {
                    lastReclaimAt = Date.now();

                    const reclaimed = await reclaimStaleJobs();

                    if (reclaimed.length) {
                        console.warn(
                            `[pdf-worker] reclaimed ${reclaimed.length} stale job(s):`,
                            reclaimed.map((job) => `${job.id}→${job.status}`).join(", "),
                        );
                    }
                }

                const job = await claimNextJob();

                if (!job) {
                    await sleep(pollIntervalMs);
                    continue;
                }

                console.log(
                    `[pdf-worker] processing ${job.id} (${job.fileName}, attempt ${job.attempts})`,
                );

                try {
                    const note = await processWithHeartbeat(job);

                    console.log(`[pdf-worker] done ${job.id} → note ${note.id}`);
                } catch (error) {
                    // A PDF with no readable text fails the same way every time,
                    // so it skips the retry budget and is parked immediately.
                    const terminal = error instanceof UnprocessablePdfError;

                    console.error(
                        `[pdf-worker] ${terminal ? "rejected" : "failed"} ${job.id}:`,
                        error.message,
                    );

                    await failJob(job.id, error, { terminal });
                }
            } catch (error) {
                // The loop itself broke — most likely the database is down.
                // Back off and keep going; the process staying alive is what
                // lets it pick the queue back up when Postgres returns.
                console.error("[pdf-worker] loop error:", error.message);

                await sleep(pollIntervalMs);
            }
        }

        console.log("[pdf-worker] stopped");
    })();

    return {
        async stop() {
            running = false;
            await loop;
        },
    };
}
