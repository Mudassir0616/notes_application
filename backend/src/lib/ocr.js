// lib/ocr.js
import { createWorker } from "tesseract.js";
import { pdf as pdfToImages } from "pdf-to-img";

let workerPromise = null;

/** Alphanumerics below which a document is treated as having no text layer. */
const MIN_MEANINGFUL_CHARS = 25;

/**
 * Per-page floor. A page of real text runs to hundreds of characters, so ten is
 * far below any genuine text layer — but it is enough to catch the case the
 * document-wide threshold alone misses (see needsOcr).
 */
const MIN_CHARS_PER_PAGE = 10;

/**
 * pdf-parse inserts a `-- 3 of 12 --` separator between pages. It is metadata,
 * not content, and must not count as extracted text.
 */
const PAGE_MARKER = /^\s*--\s*\d+\s*of\s*\d+\s*--\s*$/gim;

// One long-lived worker — creating one per request costs ~2s each time.
function getWorker(lang = "eng") {
    if (!workerPromise) {
        workerPromise = createWorker(lang, undefined, {
            cachePath: "./.tesseract",
        });
    }
    return workerPromise;
}

/**
 * Decides whether a PDF's extracted text is real content or an empty shell that
 * needs OCR.
 *
 * Both corrections below matter on multi-page scans, and the old version made
 * neither: it counted the page separators pdf-parse injects, and it compared a
 * whole document against a single-page threshold. Together those meant a
 * scanned PDF of eight pages or more cleared the bar on `-- 1 of 8 --` alone,
 * skipped OCR entirely, and produced a note containing only separators.
 *
 * @param {string} text extracted text layer
 * @param {number} [pageCount] page count, when known — lets a long document be
 *   judged per page instead of in total
 */
/**
 * Shuts the shared worker down.
 *
 * A live Tesseract worker holds open handles, which keep the Node process alive
 * indefinitely — a process that has run OCR never exits on its own. Long-running
 * servers never noticed; anything finite (a test run, a one-shot script) hangs
 * at the end without this.
 */
export async function terminateOcrWorker() {
    if (!workerPromise) return;

    const worker = await workerPromise;

    workerPromise = null;

    await worker.terminate();
}

export function needsOcr(text, pageCount = 1) {
    if (!text) return true;

    const content = text.replace(PAGE_MARKER, "");
    const alphanumeric = content.replace(/[^a-z0-9]/gi, "");

    if (alphanumeric.length < MIN_MEANINGFUL_CHARS) return true;

    // A title page with a text layer in front of forty scanned pages is still a
    // scan; judging the document as a whole would call it readable.
    const pages = Math.max(pageCount, 1);

    return alphanumeric.length / pages < MIN_CHARS_PER_PAGE;
}

export async function ocrPdfBuffer(buffer, { scale = 4, maxPages = 25 } = {}) {
    const worker = await getWorker();

    // scale 4 turns this ~94ppi scan into ~376 DPI, which is what Tesseract wants
    const document = await pdfToImages(buffer, { scale });

    const pages = [];
    let pageNumber = 0;

    for await (const image of document) {
        if (++pageNumber > maxPages) break;

        const { data } = await worker.recognize(image);
        const text = data.text.trim();

        if (text) pages.push(text);
    }

    return {
        text: pages.join("\n\n").trim(),
        pages: pageNumber,
    };
}