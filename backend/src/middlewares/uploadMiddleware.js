import multer from "multer";

/**
 * Accepts the PDF upload into memory.
 *
 * Memory storage stays correct now that ingestion is queued: the buffer only
 * lives long enough to be written to the job row, and the worker reads it back
 * from Postgres. Nothing depends on a temp file surviving the request, which is
 * what lets the worker be a separate process on a separate machine.
 */

const storage = multer.memoryStorage();

/** Also the practical ceiling on OCR cost, since pages scale with file size. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const uploadPdfFile = multer({
    storage,
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "application/pdf") {
            const error = new Error("Only PDF files are allowed");

            // Tagged so the error handler in app.js can answer 415 instead of
            // letting this fall through as an anonymous 500.
            error.status = 415;

            return cb(error);
        }

        cb(null, true);
    },
});
