// Load .env before anything reads process.env (JWT_SECRET, DATABASE_URL).
import "dotenv/config";

import app from "./app.js";
import { startPdfWorker } from "./workers/pdfWorker.js";
import { terminateOcrWorker } from "./lib/ocr.js";

if (!process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET is not set. Copy .env.example to .env.");
    process.exit(1);
}

const PORT = process.env.PORT || 8000;

/**
 * Run the PDF worker inside the API process.
 *
 * On by default so `npm run dev` stays a single command. Turn it off in
 * production (PDF_WORKER_INLINE=false) and run `npm run worker` separately:
 * OCR is CPU-bound, and the point of the queue is that it should not compete
 * with request handling for the same cores. The queue itself does not care —
 * workers claim jobs the same way wherever they run, and running several is
 * safe (see claimNextJob).
 */
const inlineWorker = process.env.PDF_WORKER_INLINE !== "false";

const server = app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
});

const worker = inlineWorker ? startPdfWorker() : null;

// Stop accepting requests, then let the job in flight finish rather than
// abandoning it to the stale-job reclaim path.
async function shutdown(signal) {
    console.log(`${signal} received, shutting down…`);

    server.close();

    if (worker) {
        await worker.stop();
        await terminateOcrWorker();
    }

    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
