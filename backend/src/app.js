import express from "express";
import multer from "multer";
import cors from "cors";

import authRoutes from "./routes/authRoutes.js";
import notesRoutes from "./routes/notesRoutes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
    });
});

app.use("/api/auth", authRoutes);
app.use("/api/notes", notesRoutes);

/**
 * Error handler.
 *
 * Needed most by the upload route: multer rejects a file *before* the
 * controller runs, so without this an oversized or non-PDF upload reached
 * Express's default handler and came back as an HTML 500 — a client parsing
 * JSON saw "unexpected token <" rather than "your file is too large".
 *
 * Must be registered last, and must keep all four parameters: Express
 * identifies error middleware by arity, so dropping `next` silently turns this
 * back into a normal handler that never runs.
 */
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ message: "File is too large (10 MB maximum)" });
        }

        return res.status(400).json({ message: `Upload rejected: ${error.message}` });
    }

    if (error?.status) {
        return res.status(error.status).json({ message: error.message });
    }

    console.error(error);

    return res.status(500).json({ message: "Internal server error" });
});

export default app;
