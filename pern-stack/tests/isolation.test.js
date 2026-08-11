// Tenant-isolation and role-permission tests.
//
// These run against a real Postgres database. Before running:
//   npm run prisma:migrate && npm run prisma:seed && npm test
//
// The suite boots the Express app on an ephemeral port, drives it over HTTP
// exactly like a real client would, and deletes every note it created.

import "dotenv/config";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";

const SEED_PASSWORD = "mumBai#64";

let server;
let base;

/** Note ids created by the suite, removed in the `after` hook. */
const created = [];

/** Logged-in sessions keyed by email: { token, user }. */
const session = {};

let acmeTenantId;
let globexTenantId;

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

    assert.equal(
        res.status,
        200,
        `Could not log in as ${email}. Did you run "npm run prisma:seed"?`,
    );

    return res.json;
}

/** Creates a note and registers it for cleanup. Returns the note body. */
async function createNote(token, title, content = "content") {
    const res = await api("/notes", {
        method: "POST",
        token,
        body: { title, content },
    });

    assert.equal(res.status, 201);
    created.push(res.json.id);

    return res.json;
}

function claims(token) {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

describe("tenant isolation and role permissions", () => {
    before(async () => {
        server = app.listen(0);
        await new Promise((resolve) => server.once("listening", resolve));

        base = `http://localhost:${server.address().port}/api`;

        for (const email of [
            "admin@acme.com",
            "member@acme.com",
            "admin@globex.com",
            "member@globex.com",
        ]) {
            session[email] = await login(email);
        }

        acmeTenantId = claims(session["admin@acme.com"].token).tenantId;
        globexTenantId = claims(session["admin@globex.com"].token).tenantId;
    });

    after(async () => {
        if (created.length) {
            await prisma.note.deleteMany({
                where: { id: { in: created.filter(Boolean) } },
            });
        }

        await prisma.$disconnect();
        server?.close();
    });

    it("seeds distinct tenants and issues tokens carrying tenantId + role", () => {
        assert.notEqual(acmeTenantId, globexTenantId);

        for (const [email, { token }] of Object.entries(session)) {
            const payload = claims(token);

            assert.ok(payload.userId, `${email} token is missing userId`);
            assert.ok(payload.tenantId, `${email} token is missing tenantId`);
            assert.ok(payload.role, `${email} token is missing role`);
        }
    });

    it("returns the caller's own identity and tenant from /auth/me", async () => {
        assert.equal((await api("/auth/me")).status, 401);

        const res = await api("/auth/me", { token: session["member@acme.com"].token });

        assert.equal(res.status, 200);
        assert.equal(res.json.email, "member@acme.com");
        assert.equal(res.json.role, "MEMBER");
        assert.equal(res.json.tenantId, acmeTenantId);
        assert.equal(res.json.tenant.slug, "acme");

        // A globex token must never resolve to acme's tenant.
        const other = await api("/auth/me", { token: session["admin@globex.com"].token });

        assert.equal(other.json.tenantId, globexTenantId);
        assert.equal(other.json.tenant.slug, "globex");
    });

    it("rejects a wrong password", async () => {
        const res = await api("/auth/login", {
            method: "POST",
            body: { email: "admin@acme.com", password: "not-the-password" },
        });

        assert.equal(res.status, 401);
    });

    it("rejects missing, malformed and forged tokens", async () => {
        assert.equal((await api("/notes")).status, 401);
        assert.equal((await api("/notes", { token: "abc.def.ghi" })).status, 401);

        // Correct payload shape, but signed with a secret the server does not know.
        const forged = jwt.sign(
            {
                userId: session["member@globex.com"].user.id,
                tenantId: acmeTenantId,
                role: "ADMIN",
            },
            "attacker-secret",
        );

        assert.equal((await api("/notes", { token: forged })).status, 401);

        // "alg: none" downgrade attack.
        const header = Buffer.from(
            JSON.stringify({ alg: "none", typ: "JWT" }),
        ).toString("base64url");

        const payload = Buffer.from(
            JSON.stringify({ userId: "x", tenantId: acmeTenantId, role: "ADMIN" }),
        ).toString("base64url");

        assert.equal((await api("/notes", { token: `${header}.${payload}.` })).status, 401);
    });

    it("derives tenantId and authorId from the token, never from the body", async () => {
        const res = await api("/notes", {
            method: "POST",
            token: session["member@acme.com"].token,
            body: {
                title: "tampered",
                content: "content",

                // Attacker-supplied values that must be ignored.
                tenantId: globexTenantId,
                authorId: session["admin@globex.com"].user.id,
            },
        });

        assert.equal(res.status, 201);
        created.push(res.json.id);

        assert.equal(res.json.tenantId, acmeTenantId);
        assert.equal(res.json.authorId, session["member@acme.com"].user.id);
    });

    it("rejects a create with a missing title or content", async () => {
        const res = await api("/notes", {
            method: "POST",
            token: session["member@acme.com"].token,
            body: { title: "only a title" },
        });

        assert.equal(res.status, 400);
    });

    it("lists only the caller's tenant", async () => {
        const acmeNote = await createNote(session["member@acme.com"].token, "acme note");
        const globexNote = await createNote(session["member@globex.com"].token, "globex note");

        const acmeList = (await api("/notes", { token: session["member@acme.com"].token })).json;
        const globexList = (await api("/notes", { token: session["member@globex.com"].token })).json;

        assert.ok(acmeList.every((note) => note.tenantId === acmeTenantId));
        assert.ok(globexList.every((note) => note.tenantId === globexTenantId));

        assert.ok(!globexList.some((note) => note.id === acmeNote.id));
        assert.ok(!acmeList.some((note) => note.id === globexNote.id));
    });

    it("blocks a foreign tenant from updating a note by guessing its id", async () => {
        const note = await createNote(session["member@acme.com"].token, "acme note", "original");

        for (const email of ["admin@globex.com", "member@globex.com"]) {
            const res = await api(`/notes/${note.id}`, {
                method: "PUT",
                token: session[email].token,
                body: { title: "pwned", content: "pwned" },
            });

            // 404, not 403: the response must not confirm that the note exists.
            assert.equal(res.status, 404, `${email} was not blocked`);
        }

        const stored = await prisma.note.findUnique({ where: { id: note.id } });

        assert.equal(stored.title, "acme note");
        assert.equal(stored.content, "original");
    });

    it("blocks a foreign tenant from deleting a note by guessing its id", async () => {
        const note = await createNote(session["member@acme.com"].token, "acme note");

        for (const email of ["admin@globex.com", "member@globex.com"]) {
            const res = await api(`/notes/${note.id}`, {
                method: "DELETE",
                token: session[email].token,
            });

            assert.equal(res.status, 404, `${email} was not blocked`);
        }

        assert.ok(await prisma.note.findUnique({ where: { id: note.id } }));
    });

    it("lets a member delete their own note but not another user's", async () => {
        const adminNote = await createNote(session["admin@acme.com"].token, "admin note");
        const ownNote = await createNote(session["member@acme.com"].token, "member note");

        const forbidden = await api(`/notes/${adminNote.id}`, {
            method: "DELETE",
            token: session["member@acme.com"].token,
        });

        assert.equal(forbidden.status, 404);
        assert.ok(await prisma.note.findUnique({ where: { id: adminNote.id } }));

        const allowed = await api(`/notes/${ownNote.id}`, {
            method: "DELETE",
            token: session["member@acme.com"].token,
        });

        assert.equal(allowed.status, 204);
        assert.equal(await prisma.note.findUnique({ where: { id: ownNote.id } }), null);
    });

    it("lets a member update their own note but not another user's", async () => {
        const adminNote = await createNote(
            session["admin@acme.com"].token,
            "admin note",
            "original",
        );

        const ownNote = await createNote(
            session["member@acme.com"].token,
            "member note",
            "original",
        );

        const forbidden = await api(`/notes/${adminNote.id}`, {
            method: "PUT",
            token: session["member@acme.com"].token,
            body: { content: "edited by a member" },
        });

        assert.equal(forbidden.status, 404);

        const stored = await prisma.note.findUnique({ where: { id: adminNote.id } });

        assert.equal(stored.content, "original");

        const allowed = await api(`/notes/${ownNote.id}`, {
            method: "PUT",
            token: session["member@acme.com"].token,
            body: { content: "edited by the author" },
        });

        assert.equal(allowed.status, 200);
        assert.equal(allowed.json.content, "edited by the author");
    });

    it("lets an admin update and delete any note inside their own tenant", async () => {
        const memberNote = await createNote(
            session["member@acme.com"].token,
            "member note",
            "original",
        );

        const updated = await api(`/notes/${memberNote.id}`, {
            method: "PUT",
            token: session["admin@acme.com"].token,
            body: { content: "edited by the admin" },
        });

        assert.equal(updated.status, 200);
        assert.equal(updated.json.content, "edited by the admin");

        const deleted = await api(`/notes/${memberNote.id}`, {
            method: "DELETE",
            token: session["admin@acme.com"].token,
        });

        assert.equal(deleted.status, 204);
        assert.equal(await prisma.note.findUnique({ where: { id: memberNote.id } }), null);
    });

    it("stops an admin's power at their own tenant boundary", async () => {
        const globexNote = await createNote(session["member@globex.com"].token, "globex note");

        const updated = await api(`/notes/${globexNote.id}`, {
            method: "PUT",
            token: session["admin@acme.com"].token,
            body: { content: "cross-tenant admin edit" },
        });

        assert.equal(updated.status, 404);

        const deleted = await api(`/notes/${globexNote.id}`, {
            method: "DELETE",
            token: session["admin@acme.com"].token,
        });

        assert.equal(deleted.status, 404);
        assert.ok(await prisma.note.findUnique({ where: { id: globexNote.id } }));
    });

    it("returns 404 rather than 500 for unknown and malformed ids", async () => {
        const unknown = await api("/notes/00000000-0000-0000-0000-000000000000", {
            method: "PUT",
            token: session["admin@acme.com"].token,
            body: { title: "x" },
        });

        assert.equal(unknown.status, 404);

        const malformed = await api("/notes/not-a-uuid", {
            method: "DELETE",
            token: session["admin@acme.com"].token,
        });

        assert.equal(malformed.status, 404);
    });
});
