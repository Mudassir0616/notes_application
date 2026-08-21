import Anthropic from "@anthropic-ai/sdk";

import { indexName, isPineconeConfigured, SearchUnavailableError } from "../lib/pinecone.js";
import { AnswerRefusedError, AnswerUnavailableError, isAnswerConfigured } from "../lib/anthropic.js";
import { reindexTenant, searchNotes } from "../services/noteSearchService.js";
import { answerFromNotes } from "../services/noteAnswerService.js";

const MAX_LIMIT = 50;

/** Questions are prose, so they get more room than a search query needs. */
const MAX_QUESTION_CHARS = 2000;

// A missing index is a setup problem, not a bug — surface it as such rather
// than as a 500.
function isMissingIndex(error) {
    const message = String(error?.message || "");

    return (
        error?.name === "PineconeNotFoundError" ||
        message.includes("404") ||
        message.toLowerCase().includes("not found")
    );
}

function handleSearchError(error, res) {
    console.error(error);

    if (error instanceof SearchUnavailableError) {
        return res.status(503).json({
            message: "Search is not available: PINECONE_API_KEY is not configured.",
        });
    }

    if (isMissingIndex(error)) {
        return res.status(503).json({
            message:
                `Search is not available: the Pinecone index "${indexName()}" does not exist. ` +
                "Run `npm run pinecone:setup`.",
        });
    }

    // Answering runs retrieval first, so it can fail either half. The
    // generation half has its own set of causes.
    if (error instanceof AnswerUnavailableError) {
        return res.status(503).json({
            message: "Answering is not available: ANTHROPIC_API_KEY is not configured.",
        });
    }

    if (error instanceof AnswerRefusedError) {
        return res.status(502).json({ message: error.message });
    }

    if (error instanceof Anthropic.AuthenticationError) {
        return res.status(503).json({
            message: "Answering is not available: ANTHROPIC_API_KEY was rejected.",
        });
    }

    if (error instanceof Anthropic.RateLimitError) {
        return res.status(429).json({ message: "Rate limited by the model provider. Try again shortly." });
    }

    if (error instanceof Anthropic.APIError) {
        return res.status(502).json({ message: "The model provider returned an error." });
    }

    return res.status(500).json({ message: "Search failed" });
}

/**
 * GET /api/notes/search?q=...&limit=...
 *
 * Tenant scope comes from the verified JWT, exactly as it does for the CRUD
 * routes. There is no way to search another tenant's notes.
 */
export async function search(req, res) {
    try {
        const query = (req.query.q || "").trim();

        if (!query) {
            return res.status(400).json({ message: "Query parameter 'q' is required" });
        }

        if (!isPineconeConfigured()) {
            return res.status(503).json({
                message: "Search is not available: PINECONE_API_KEY is not configured.",
            });
        }

        const requested = Number.parseInt(req.query.limit, 10);
        const limit = Number.isNaN(requested) ? 10 : Math.min(Math.max(requested, 1), MAX_LIMIT);

        const results = await searchNotes({
            tenantId: req.user.tenantId,
            query,
            limit,
        });

        return res.json({ query, results });
    } catch (error) {
        return handleSearchError(error, res);
    }
}

/**
 * POST /api/notes/reindex — ADMIN only.
 *
 * Backfills notes written while search was unconfigured. Scoped to the caller's
 * tenant; an admin cannot re-index another tenant.
 */
export async function reindex(req, res) {
    try {
        if (req.user.role !== "ADMIN") {
            return res.status(403).json({ message: "Only an admin can re-index" });
        }

        if (!isPineconeConfigured()) {
            return res.status(503).json({
                message: "Re-index is not available: PINECONE_API_KEY is not configured.",
            });
        }

        const indexed = await reindexTenant(req.user.tenantId);

        return res.json({ indexed });
    } catch (error) {
        return handleSearchError(error, res);
    }
}

/**
 * POST /api/notes/ask  { question, limit? }
 *
 * Retrieval-augmented answering. The question is embedded and matched against
 * the caller's own notes, and only the chunks that come back are given to the
 * model — so the answer is scoped by exactly the same tenant boundary as
 * /notes/search, and cannot be widened from the request.
 */
export async function ask(req, res) {
    try {
        const question = String(req.body?.question || "").trim();

        if (!question) {
            return res.status(400).json({ message: "Field 'question' is required" });
        }

        if (question.length > MAX_QUESTION_CHARS) {
            return res.status(400).json({
                message: `Question must be ${MAX_QUESTION_CHARS} characters or fewer`,
            });
        }

        if (!isPineconeConfigured()) {
            return res.status(503).json({
                message: "Answering is not available: PINECONE_API_KEY is not configured.",
            });
        }

        if (!isAnswerConfigured()) {
            return res.status(503).json({
                message: "Answering is not available: ANTHROPIC_API_KEY is not configured.",
            });
        }

        const requested = Number.parseInt(req.body?.limit, 10);
        const limit = Number.isNaN(requested) ? 8 : Math.min(Math.max(requested, 1), MAX_LIMIT);

        const result = await answerFromNotes({
            tenantId: req.user.tenantId,
            question,
            limit,
        });

        return res.json({ question, ...result });
    } catch (error) {
        return handleSearchError(error, res);
    }
}
