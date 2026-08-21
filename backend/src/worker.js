// Standalone worker entry point — the sibling of server.js.
//
// Run this as its own process (`npm run worker`) to get the real benefit of the
// queue: OCR then burns CPU on a machine that is not also serving HTTP, and the
// two scale independently. In development the API starts a worker in-process
// instead (see server.js), so `npm run dev` remains a single command.

import "dotenv/config";

import { startPdfWorker } from "./workers/pdfWorker.js";
import { terminateOcrWorker } from "./lib/ocr.js";
import prisma from "./lib/prisma.js";

const worker = startPdfWorker();

// Finish the job in flight before exiting, rather than dropping it and waiting
// for another worker to notice the stale heartbeat.
async function shutdown(signal) {
    console.log(`[pdf-worker] ${signal} received, finishing current job…`);

    await worker.stop();
    await terminateOcrWorker();
    await prisma.$disconnect();

    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
