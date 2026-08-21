import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";

import {
    createNote,
    uploadPdf,
    listNotes,
    updateNote,
    deleteNote,
} from "../controllers/notesController.js";

import { ask, reindex, search } from "../controllers/searchController.js";
import { getPdfJob, listPdfJobs } from "../controllers/pdfJobController.js";
import { uploadPdfFile } from "../middlewares/uploadMiddleware.js";

const router = express.Router();

router.use(authenticate);

// Literal paths are declared before "/:id" so a note can never be shadowed by
// (or shadow) a named route.
router.get("/search", search);
router.post("/ask", ask);
router.post("/reindex", reindex);

// Where a client goes after POST /pdf returns 202. Declared before the upload
// route only for readability; they cannot collide (different methods).
router.get("/pdf/jobs", listPdfJobs);
router.get("/pdf/jobs/:jobId", getPdfJob);

router.post("/", createNote);
router.post(
    "/pdf",
    uploadPdfFile.single("file"),
    uploadPdf
);
router.get("/", listNotes);
router.put("/:id", updateNote);
router.delete("/:id", deleteNote);

export default router;
