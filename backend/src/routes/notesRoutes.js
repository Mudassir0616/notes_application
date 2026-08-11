import express from "express";
import { authenticate } from "../middlewares/auth.middleware.js";

import {
    createNote,
    listNotes,
    updateNote,
    deleteNote,
} from "../controllers/notesController.js";

const router = express.Router();

router.use(authenticate);

router.post("/", createNote);
router.get("/", listNotes);
router.put("/:id", updateNote);
router.delete("/:id", deleteNote);

export default router;
