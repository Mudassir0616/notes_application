// Semantic search tests (Pinecone).
//
// Needs PINECONE_API_KEY and the index created (`npm run pinecone:setup`).
// Without them the suite skips with a reason rather than failing — the CRUD and
// isolation suite in isolation.test.js is the one that must always run.
//
// Pinecone upserts are eventually consistent, so anything that asserts on a
// freshly written vector polls instead of asserting immediately.

import "dotenv/config";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { getIndex, isPineconeConfigured, namespaceFor } from "../src/lib/pinecone.js";
import { deleteNoteVectors } from "../src/services/noteSearchService.js";

const SEED_PASSWORD = "mumBai#64";

// Distinctive phrasings with no shared vocabulary, so a match proves semantic
// retrieval rather than substring luck.
const ACME_SECRET = {
    title: "Q3 revenue review",
    content: "Our quarterly earnings came in well above the forecast the board signed off on.",
};

const GLOBEX_SECRET = {
    title: "Hydroponics trial",
    content: "The greenhouse basil seedlings germinated four days earlier under the new lamps.",
};

async function checkSetup() {
    if (!isPineconeConfigured()) return "PINECONE_API_KEY is not set";

    try {
        await getIndex().describeIndexStats();
        return null;
    } catch (error) {
        return `index unreachable, run npm run pinecone:setup (${error.message})`;
    }
}

const problem = await checkSetup();

// Skip reasons are emitted into TAP output, which on Node 18 only lexes ASCII
// reliably. Keep them plain.
const skipReason = problem ? `semantic search unavailable: ${problem}` : false;

let server;
let base;

const created = [];
const session = {};

let acmeTenantId;

async function api(path, { method = "GET", token, body } = {}) {
    const res = await fetch(base + path, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    let json = null;

    try {
        json = await res.json();
    } catch {
        // 204 responses have no body.
    }

    return { status: res.status, json };
}

async function login(email) {
    const res = await api("/auth/login", {
        method: "POST",
        body: { email, password: SEED_PASSWORD },
    });

    assert.equal(res.status, 200, `Could not log in as ${email}. Did you run "npm run prisma:seed"?`);

    return res.json;
}

async function createNote(token, { title, content }) {
    const res = await api("/notes", { method: "POST", token, body: { title, content } });

    assert.equal(res.status, 201);
    created.push(res.json);

    return res.json;
}

/** Polls `check` until it returns truthy, or gives up. Pinecone is async. */
async function eventually(check, { attempts = 20, delayMs = 1500, what = "condition" } = {}) {
    let last;

    for (let i = 0; i < attempts; i++) {
        last = await check();

        if (last) return last;

        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(`Timed out waiting for ${what}`);
}

/** Vector ids currently stored for a note, read straight from Pinecone. */
async function vectorIdsFor(note) {
    const page = await getIndex()
        .namespace(namespaceFor(note.tenantId))
        .listPaginated({ prefix: `${note.id}:` });

    return (page.vectors || []).map((vector) => vector.id);
}

function search(token, query, extra = "") {
    return api(`/notes/search?q=${encodeURIComponent(query)}${extra}`, { token });
}

describe("semantic search", { skip: skipReason }, () => {
    let acmeNote;
    let globexNote;

    before(async () => {
        server = app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));

        base = `http://localhost:${server.address().port}/api`;

        for (const email of ["admin@acme.com", "member@acme.com", "member@globex.com"]) {
            session[email] = await login(email);
        }

        acmeTenantId = session["member@acme.com"].user.tenantId;

        acmeNote = await createNote(session["member@acme.com"].token, ACME_SECRET);
        globexNote = await createNote(session["member@globex.com"].token, GLOBEX_SECRET);

        // Wait until both are actually searchable before asserting anything.
        await eventually(
            async () => (await search(session["member@acme.com"].token, ACME_SECRET.content)).json.results.length,
            { what: "acme note to become searchable" },
        );

        await eventually(
            async () =>
                (await search(session["member@globex.com"].token, GLOBEX_SECRET.content)).json.results.length,
            { what: "globex note to become searchable" },
        );
    });

    after(async () => {
        // Clean vectors explicitly rather than relying on the API delete. The
        // row sweep below goes straight to Postgres, which has no cascade into
        // Pinecone — doing it the other way round strands vectors for notes
        // that no longer exist.
        //
        // Re-read each row first: the create response predates indexing, so its
        // chunkCount is stale and exact-id deletion would find nothing.
        const rows = await prisma.note.findMany({
            where: { id: { in: created.map((n) => n.id) } },
        });

        for (const note of rows) {
            await deleteNoteVectors(note).catch(() => {});
        }

        await prisma.note.deleteMany({ where: { id: { in: created.map((n) => n.id) } } });
        await prisma.$disconnect();
        server?.close();
    });

    it("indexes a note on create, into its own tenant namespace", async () => {
        assert.ok((await vectorIdsFor(acmeNote)).length > 0, "note produced no vectors");
    });

    it("requires authentication", async () => {
        assert.equal((await api("/notes/search?q=revenue")).status, 401);
    });

    it("rejects an empty query", async () => {
        const res = await search(session["member@acme.com"].token, "   ");

        assert.equal(res.status, 400);
    });

    it("finds a note by meaning rather than shared keywords", async () => {
        const res = await search(session["member@acme.com"].token, "how did profits do this quarter");

        assert.equal(res.status, 200);
        assert.ok(
            res.json.results.some((row) => row.noteId === acmeNote.id),
            "expected the revenue note",
        );
    });

    it("NEVER returns another tenant's note, even when the query targets it", async () => {
        // globex searches using the literal text of acme's note.
        const res = await search(session["member@globex.com"].token, ACME_SECRET.content);

        assert.equal(res.status, 200);
        assert.ok(
            !res.json.results.some((row) => row.noteId === acmeNote.id),
            "acme note leaked to globex",
        );

        // ...and the reverse direction.
        const back = await search(session["member@acme.com"].token, GLOBEX_SECRET.content);

        assert.ok(
            !back.json.results.some((row) => row.noteId === globexNote.id),
            "globex note leaked to acme",
        );
    });

    it("only ever returns rows belonging to the caller's tenant", async () => {
        const res = await search(session["member@acme.com"].token, "notes about anything at all");

        const noteIds = res.json.results.map((row) => row.noteId);

        if (noteIds.length) {
            const notes = await prisma.note.findMany({ where: { id: { in: noteIds } } });

            for (const note of notes) {
                assert.equal(note.tenantId, acmeTenantId, `note ${note.id} is not in acme`);
            }
        }
    });

    it("caps the result limit", async () => {
        const res = await search(session["member@acme.com"].token, "revenue", "&limit=999");

        assert.equal(res.status, 200);
        assert.ok(res.json.results.length <= 50);
    });

    it("re-indexes when a note's text changes", async () => {
        const note = await createNote(session["member@acme.com"].token, {
            title: "Scratch",
            content: "The office espresso machine needs descaling.",
        });

        await api(`/notes/${note.id}`, {
            method: "PUT",
            token: session["member@acme.com"].token,
            body: { content: "The parking garage gate opens with a fob, not a code." },
        });

        const found = await eventually(
            async () => {
                const res = await search(session["member@acme.com"].token, "how do I open the garage gate");

                return res.json.results.find((row) => row.noteId === note.id);
            },
            { what: "the edited note to be re-indexed" },
        );

        assert.match(found.chunk, /parking garage/i, "search returned the stale chunk text");
    });

    it("deletes vectors along with the note", async () => {
        const note = await createNote(session["member@acme.com"].token, {
            title: "Temporary",
            content: "This note exists only to be deleted again.",
        });

        await eventually(async () => (await vectorIdsFor(note)).length > 0, {
            what: "the temporary note to be indexed",
        });

        const res = await api(`/notes/${note.id}`, {
            method: "DELETE",
            token: session["member@acme.com"].token,
        });

        assert.equal(res.status, 204);

        // No orphans: deleted content must not stay retrievable.
        await eventually(async () => (await vectorIdsFor(note)).length === 0, {
            what: "the deleted note's vectors to disappear",
        });
    });

    it("re-index is admin-only and scoped to the caller's tenant", async () => {
        const forbidden = await api("/notes/reindex", {
            method: "POST",
            token: session["member@acme.com"].token,
        });

        assert.equal(forbidden.status, 403);

        const allowed = await api("/notes/reindex", {
            method: "POST",
            token: session["admin@acme.com"].token,
        });

        assert.equal(allowed.status, 200);

        // The globex note must be untouched by an acme admin's re-index.
        assert.ok((await vectorIdsFor(globexNote)).length > 0);
    });
});
