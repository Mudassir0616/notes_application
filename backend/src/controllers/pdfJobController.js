import { getJobForUser, listJobsForUser, maxAttempts } from "../services/pdfJobService.js";

/**
 * Read-only views of the PDF ingestion queue.
 *
 * These exist because the upload endpoint no longer returns a note: 202 without
 * somewhere to poll would just be a black hole. Scoping matches the note routes
 * exactly — tenant always, own-author for a MEMBER — because a job carries a
 * filename and an error message, which are as much the tenant's data as the
 * note itself.
 */

const MAX_LIMIT = 50;

/** Adds the fields a polling client needs but that aren't worth storing. */
function decorate(job) {
    return {
        ...job,
        // Saves the client from encoding "is this over?" as a status list of
        // its own, which would silently break if a status were ever added.
        done: job.status === "DONE" || job.status === "FAILED",
        // A retrying job is not a broken one; the UI can say "retrying (2/3)"
        // instead of showing an alarming error that is about to resolve itself.
        maxAttempts: maxAttempts(),
    };
}

/** GET /api/notes/pdf/jobs/:jobId */
export async function getPdfJob(req, res) {
    try {
        const job = await getJobForUser({
            jobId: req.params.jobId,
            tenantId: req.user.tenantId,
            userId: req.user.id,
            role: req.user.role,
        });

        // 404 rather than 403 for a job in another tenant: the response must not
        // confirm that the id exists at all.
        if (!job) {
            return res.status(404).json({
                message: "Job not found or you do not have permission",
            });
        }

        return res.json(decorate(job));
    } catch (error) {
        console.error(error);

        return res.status(500).json({ message: "Failed to fetch job" });
    }
}

/** GET /api/notes/pdf/jobs?limit=... — recent uploads, newest first. */
export async function listPdfJobs(req, res) {
    try {
        const requested = Number.parseInt(req.query.limit, 10);
        const limit = Number.isNaN(requested) ? 20 : Math.min(Math.max(requested, 1), MAX_LIMIT);

        const jobs = await listJobsForUser({
            tenantId: req.user.tenantId,
            userId: req.user.id,
            role: req.user.role,
            limit,
        });

        return res.json({ jobs: jobs.map(decorate) });
    } catch (error) {
        console.error(error);

        return res.status(500).json({ message: "Failed to fetch jobs" });
    }
}
