import { Pinecone } from "@pinecone-database/pinecone";

// Vector storage for note chunks.
//
// The index uses Pinecone's *integrated inference*: we upsert raw text and
// Pinecone runs the embedding model server-side. That is why this project needs
// no embedding-provider key of its own — the model is configured on the index
// itself, at creation time, and cannot be changed afterwards.

const INDEX_NAME = process.env.PINECONE_INDEX || "notes-chunks";

/** Model configured on the index. Changing it requires a new index. */
export const EMBEDDING_MODEL = process.env.PINECONE_EMBEDDING_MODEL || "llama-text-embed-v2";

/** The record field Pinecone embeds. Must match the index's `fieldMap.text`. */
export const TEXT_FIELD = "chunk_text";

export class SearchUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "SearchUnavailableError";
    }
}

let client;

export function isPineconeConfigured() {
    return Boolean(process.env.PINECONE_API_KEY);
}

export function indexName() {
    return INDEX_NAME;
}

/** Lazily constructed so a missing key doesn't break importing this module. */
export function getPinecone() {
    if (!isPineconeConfigured()) {
        throw new SearchUnavailableError("PINECONE_API_KEY is not set");
    }

    if (!client) client = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

    return client;
}

export function getIndex() {
    return getPinecone().index(INDEX_NAME);
}

/**
 * One Pinecone namespace per tenant.
 *
 * This is the primary isolation boundary for vectors: a query issued against
 * `namespace(acme)` cannot return a record stored under `namespace(globex)` —
 * it is a physical partition, not a filter that has to be remembered on every
 * query. The tenant id always comes from the verified JWT.
 */
export function namespaceFor(tenantId) {
    return `tenant_${tenantId}`;
}

/** Vector ids are `<noteId>:<chunkIndex>`, so a note's chunks share a prefix. */
export function vectorId(noteId, chunkIndex) {
    return `${noteId}:${chunkIndex}`;
}

export function vectorPrefixFor(noteId) {
    return `${noteId}:`;
}
