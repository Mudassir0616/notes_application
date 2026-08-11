import { indexName, isPineconeConfigured, SearchUnavailableError } from "../lib/pinecone.js";
import { reindexTenant, searchNotes } from "../services/noteSearchService.js";

const MAX_LIMIT = 50;

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
