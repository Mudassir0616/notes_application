import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";

import {
    createNote,
    listNotes,
    updateNote,
    deleteNote,
} from "../controllers/notesController.js";

import { reindex, search } from "../controllers/searchController.js";

const router = express.Router();

router.use(authenticate);

// Literal paths are declared before "/:id" so a note can never be shadowed by
// (or shadow) a named route.
router.get("/search", search);
router.post("/reindex", reindex);

router.post("/", createNote);
router.get("/", listNotes);
router.put("/:id", updateNote);
router.delete("/:id", deleteNote);

export default router;
