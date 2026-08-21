// Turning an uploaded PDF into text.
//
// Extracted out of the controller because this is now the *worker's* job, not a
// request handler's: it can take minutes, and nothing here may touch `req`.
// Two strategies, in order of cost: read the embedded text layer, and only if
// that comes back empty (a scan, i.e. a page of pixels) fall back to OCR.

import { PDFParse } from "pdf-parse";

import { needsOcr, ocrPdfBuffer } from "./ocr.js";

/**
 * The PDF was read successfully and simply has no text in it — blank, too
 * low-resolution, or handwritten.
 *
 * This is a *terminal* failure, and the distinction matters to the queue: a
 * timeout deserves a retry, but a blank scan will be just as blank on the third
 * attempt. The worker checks for this type and stops retrying immediately.
 */
export class UnprocessablePdfError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnprocessablePdfError";
    }
}

/**
 * Extracts text from a PDF buffer, falling back to OCR when there is no text
 * layer to read.
 *
 * @returns {Promise<{text: string, pages: number, usedOcr: boolean}>}
 *   `usedOcr` is now an honest boolean — the old inline version reported
 *   `sourceType === "PDF"`, which was true on both branches and so always said
 *   OCR had run.
 * @throws {UnprocessablePdfError} when neither strategy finds readable text.
 */
export async function extractPdfText(buffer) {
    let parser;

    try {
        // IMPORTANT: pdfjs-based parsers transfer (detach) the underlying
        // ArrayBuffer. Take the private copy for OCR *before* handing the
        // original to PDFParse, or it is zero-length by the time OCR needs it.
        const ocrBuffer = Buffer.from(buffer);

        parser = new PDFParse({ data: buffer });

        const pdf = await parser.getText();

        let text = pdf.text?.trim() ?? "";
        let pages = pdf.total;
        let usedOcr = false;

        // Page count is passed so a long scan is judged per page — a text layer
        // on page one does not make forty scanned pages readable.
        if (needsOcr(text, pages)) {
            const ocr = await ocrPdfBuffer(ocrBuffer);

            text = ocr.text;
            pages = ocr.pages;
            usedOcr = true;
        }

        if (needsOcr(text, pages)) {
            throw new UnprocessablePdfError(
                "No readable text found in this PDF, even after OCR. " +
                "It may be blank, too low-resolution, or handwritten.",
            );
        }

        return { text, pages, usedOcr };
    } finally {
        if (parser) {
            await parser.destroy().catch(() => { });
        }
    }
}
