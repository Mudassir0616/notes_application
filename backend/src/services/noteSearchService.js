import prisma from "../lib/prisma.js";
import { buildEmbeddingInput, chunkContent } from "../lib/chunker.js";
import {
    getIndex,
    isPineconeConfigured,
    namespaceFor,
    TEXT_FIELD,
    vectorId,
    vectorPrefixFor,
} from "../lib/pinecone.js";

/** Every vector id under `<noteId>:`, across all pages. */
async function listVectorIdsForNote(namespace, noteId) {
    const ids = [];

    let paginationToken;

    do {
        const page = await namespace.listPaginated({
            prefix: vectorPrefixFor(noteId),
            paginationToken,
        });

        for (const vector of page.vectors || []) ids.push(vector.id);

        paginationToken = page.pagination?.next;
    } while (paginationToken);

    return ids;
}

/**
 * Deletes every vector belonging to a note.
 *
 * Pinecone has no foreign keys, so this replaces the database's ON DELETE
 * CASCADE — and it is the one operation that must not fail silently, because an
 * orphaned vector is deleted note content that is still retrievable.
 *
 * Two passes, deliberately:
 *   1. Delete the exact ids implied by the note's stored `chunkCount`. This is
 *      race-free. A list-only approach is not: `listPaginated` is eventually
 *      consistent, so a vector written moments ago may not appear yet and would
 *      survive the delete.
 *   2. Sweep anything else sharing the note's id prefix, to catch drift if
 *      `chunkCount` is ever stale.
 */
export async function deleteNoteVectors({ id, tenantId, chunkCount = 0 }) {
    const namespace = getIndex().namespace(namespaceFor(tenantId));

    const known = Array.from({ length: chunkCount }, (_, index) => vectorId(id, index));

    if (known.length) await namespace.deleteMany({ ids: known });

    const discovered = (await listVectorIdsForNote(namespace, id)).filter(
        (vector) => !known.includes(vector),
    );

    if (discovered.length) await namespace.deleteMany({ ids: discovered });

    return known.length + discovered.length;
}

/**
 * Re-indexes a single note: removes its old vectors, then upserts fresh ones.
 *
 * Only the chunk text is sent — Pinecone embeds it server-side. `tenantId`
 * comes from the stored note row, which the controller already scoped to the
 * caller, so a chunk cannot land in another tenant's namespace.
 */
export async function indexNote(note) {
    const namespace = getIndex().namespace(namespaceFor(note.tenantId));

    // Clear the previous generation first, using the count stored on the row —
    // an edit that shortens a note must not leave its old tail behind.
    await deleteNoteVectors(note);

    const chunks = chunkContent(note.content);

    if (chunks.length) {
        await namespace.upsertRecords({
            records: chunks.map((chunk, index) => ({
                _id: vectorId(note.id, index),
                // The embedded field. The title is folded in so a chunk
                // retrieved on its own still carries its subject.
                [TEXT_FIELD]: buildEmbeddingInput(note.title, chunk),
                noteId: note.id,
                chunkIndex: index,
            })),
        });
    }

    // Record the count so the next delete can address these ids exactly.
    await prisma.note.update({
        where: { id: note.id },
        data: { chunkCount: chunks.length },
    });

    return chunks.length;
}

/**
 * Indexes a note without letting a Pinecone failure break the write path.
 * A note that fails to index is still saved and still listed — it just will not
 * appear in search until it is edited again or re-indexed.
 */
export async function indexNoteSafely(note) {
    if (!isPineconeConfigured()) return;

    try {
        await indexNote(note);
    } catch (error) {
        console.error(`Failed to index note ${note.id}:`, error.message);
    }
}

/**
 * Semantic search across a single tenant's notes.
 *
 * Two independent isolation layers:
 *   1. The query runs inside the tenant's own Pinecone namespace, so foreign
 *      vectors are not searched in the first place.
 *   2. The returned note ids are then resolved through a tenant-scoped Postgres
 *      query, and any id that does not come back is dropped. Postgres remains
 *      the source of truth, so even a mis-namespaced vector cannot surface
 *      another tenant's note — and titles/authors can never be stale.
 */
export async function searchNotes({ tenantId, query, limit = 10 }) {
    const namespace = getIndex().namespace(namespaceFor(tenantId));

    const response = await namespace.searchRecords({
        query: { topK: limit, inputs: { text: query } },
        fields: [TEXT_FIELD, "noteId", "chunkIndex"],
    });

    const hits = response.result?.hits || [];

    if (!hits.length) return [];

    const noteIds = [...new Set(hits.map((hit) => hit.fields?.noteId).filter(Boolean))];

    const notes = await prisma.note.findMany({
        where: { id: { in: noteIds }, tenantId },
        include: { author: { select: { id: true, email: true, role: true } } },
    });

    const byId = new Map(notes.map((note) => [note.id, note]));

    return hits
        .map((hit) => {
            const note = byId.get(hit.fields?.noteId);

            if (!note) return null;

            return {
                chunkId: hit._id,
                noteId: note.id,
                chunkIndex: hit.fields?.chunkIndex ?? 0,
                chunk: hit.fields?.[TEXT_FIELD] || "",
                title: note.title,
                authorEmail: note.author.email,
                createdAt: note.createdAt,
                score: Number(Number(hit._score).toFixed(4)),
            };
        })
        .filter(Boolean);
}

/**
 * Re-indexes every note in a tenant. Exposed for backfilling notes created
 * before Pinecone was configured.
 */
export async function reindexTenant(tenantId) {
    const notes = await prisma.note.findMany({ where: { tenantId } });

    for (const note of notes) {
        await indexNote(note);
    }

    return notes.length;
}
