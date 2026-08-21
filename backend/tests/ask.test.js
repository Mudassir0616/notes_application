// Ask-your-notes tests (Pinecone retrieval + Claude generation).
//
// Needs PINECONE_API_KEY with the index created (`npm run pinecone:setup`) and
// ANTHROPIC_API_KEY. Without them the suite skips with a reason rather than
// failing. Note that when it does run it makes real model calls, which cost
// money — this suite is deliberately small for that reason.
//
// The assertions avoid grading the model's prose. What is worth pinning down is
// the boundary: which notes were retrieved, and whose tenant they belong to.

import "dotenv/config";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { getIndex, isPineconeConfigured } from "../src/lib/pinecone.js";
import { isAnswerConfigured } from "../src/lib/anthropic.js";
import { deleteNoteVectors } from "../src/services/noteSearchService.js";

const SEED_PASSWORD = "mumBai#64";

// A fact that exists nowhere but this note, so an answer containing it can only
// have come from retrieval — and an answer containing it in the *wrong* tenant
// can only have come from a leak.
const ACME_SECRET = {
    title: "Office logistics",
    content: "The spare server room key is kept in the blue tin on Priya's desk.",
};

const GLOBEX_SECRET = {
    title: "Field notes",
    content: "The northern weather station reports in every ninety minutes on channel four.",
};

async function checkSetup() {
    if (!isPineconeConfigured()) return "PINECONE_API_KEY is not set";
    if (!isAnswerConfigured()) return "ANTHROPIC_API_KEY is not set";

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
const skipReason = problem ? `ask is unavailable: ${problem}` : false;

let server;
let base;

const created = [];
const session = {};

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

function ask(token, question, extra = {}) {
    return api("/notes/ask", { method: "POST", token, body: { question, ...extra } });
}

describe("ask your notes", { skip: skipReason }, () => {
    let acmeNote;
    let globexNote;
    let acmeTenantId;

    before(async () => {
        server = app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));

        base = `http://localhost:${server.address().port}/api`;

        for (const email of ["member@acme.com", "member@globex.com"]) {
            session[email] = await login(email);
        }

        acmeTenantId = session["member@acme.com"].user.tenantId;

        acmeNote = await createNote(session["member@acme.com"].token, ACME_SECRET);
        globexNote = await createNote(session["member@globex.com"].token, GLOBEX_SECRET);

        // Both must be retrievable before any answer can depend on them.
        await eventually(
            async () => {
                const res = await api(
                    `/notes/search?q=${encodeURIComponent(ACME_SECRET.content)}`,
                    { token: session["member@acme.com"].token },
                );

                return res.json.results.some((row) => row.noteId === acmeNote.id);
            },
            { what: "the acme note to become retrievable" },
        );

        await eventually(
            async () => {
                const res = await api(
                    `/notes/search?q=${encodeURIComponent(GLOBEX_SECRET.content)}`,
                    { token: session["member@globex.com"].token },
                );

                return res.json.results.some((row) => row.noteId === globexNote.id);
            },
            { what: "the globex note to become retrievable" },
        );
    });

    after(async () => {
        // Vectors first: the row sweep below goes straight to Postgres, which
        // has no cascade into Pinecone. Re-read each row so chunkCount is
        // current — the create response predates indexing.
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

    it("requires authentication", async () => {
        const res = await api("/notes/ask", {
            method: "POST",
            body: { question: "where is the spare key" },
        });

        assert.equal(res.status, 401);
    });

    it("rejects an empty question", async () => {
        assert.equal((await ask(session["member@acme.com"].token, "   ")).status, 400);
    });

    it("answers from the caller's own notes and cites them", async () => {
        const res = await ask(session["member@acme.com"].token, "Where is the spare server room key kept?");

        assert.equal(res.status, 200);
        assert.ok(res.json.answer.trim().length > 0, "empty answer");
        assert.equal(res.json.grounded, true);

        const source = res.json.sources.find((row) => row.noteId === acmeNote.id);

        assert.ok(source, "the note holding the answer was not cited");
        assert.match(res.json.answer, /blue tin/i, "the answer did not use the retrieved note");
    });

    it("NEVER cites another tenant's note, even when the question quotes it", async () => {
        const res = await ask(session["member@globex.com"].token, ACME_SECRET.content);

        assert.equal(res.status, 200);
        assert.ok(
            !res.json.sources.some((row) => row.noteId === acmeNote.id),
            "acme note leaked into a globex answer",
        );
        assert.doesNotMatch(res.json.answer, /blue tin/i, "acme's content leaked into the prose");
    });

    it("only ever cites rows belonging to the caller's tenant", async () => {
        const res = await ask(session["member@acme.com"].token, "What do these notes say?");

        const noteIds = res.json.sources.map((row) => row.noteId);

        if (noteIds.length) {
            const notes = await prisma.note.findMany({ where: { id: { in: noteIds } } });

            for (const note of notes) {
                assert.equal(note.tenantId, acmeTenantId, `note ${note.id} is not in acme`);
            }
        }
    });

    it("caps the retrieval limit", async () => {
        const res = await ask(session["member@acme.com"].token, "spare key", { limit: 999 });

        assert.equal(res.status, 200);
        assert.ok(res.json.sources.length <= 50);
    });
});
