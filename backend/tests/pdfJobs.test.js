// PDF ingestion queue tests.
//
// These run against a real Postgres database. Before running:
//   npm run prisma:migrate && npm run prisma:seed && npm test
//
// IMPORTANT: no other worker may be running against the same database while
// this suite executes, or it will claim the jobs these tests are about to claim
// themselves. Stop `npm run dev` (or set PDF_WORKER_INLINE=false) first.
//
// The suite drives the queue directly rather than through a worker loop. The
// loop is a `while` around these calls; what is worth pinning down is the
// behaviour underneath it — who may claim a job, what happens when the process
// holding one dies, and whether a retry can produce a second note.

import "dotenv/config";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import app from "../src/app.js";
import prisma from "../src/lib/prisma.js";
import { isPineconeConfigured } from "../src/lib/pinecone.js";
import { terminateOcrWorker } from "../src/lib/ocr.js";
import { deleteNoteVectors } from "../src/services/noteSearchService.js";
import {
    claimNextJob,
    failJob,
    heartbeat,
    maxAttempts,
    reclaimStaleJobs,
} from "../src/services/pdfJobService.js";
import { processPdfJob } from "../src/services/pdfIngestService.js";
import { blankPdf, textPdf } from "./fixtures/pdf.js";

const SEED_PASSWORD = "mumBai#64";

/**
 * Unique per run, because the assertions below count notes by `sourceName`:
 * a fixed filename would also match notes an earlier run left behind, and the
 * suite would report a duplicate that this run did not create.
 */
const RUN_TAG = `${process.pid}-${Date.now()}`;

const SAMPLE_TEXT =
    "The quarterly maintenance window is the first Sunday of every month. " +
    "Backups run at zero two hundred hours and the failover drill follows.";

let server;
let base;

/** Rows created by the suite, removed in the `after` hook. */
const createdJobIds = [];
const createdNoteIds = [];

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

/** Uploads a PDF buffer as multipart/form-data and registers the job for cleanup. */
async function upload(token, buffer, fileName = "sample.pdf") {
    const form = new FormData();

    form.append("file", new Blob([buffer], { type: "application/pdf" }), fileName);

    const res = await fetch(`${base}/notes/pdf`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });

    const json = await res.json().catch(() => null);

    if (json?.job?.id) createdJobIds.push(json.job.id);

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

/**
 * Claims and holds every job already in the queue, so the suite runs against an
 * empty one and each claim below returns the job that test just created.
 *
 * Necessary because `claimNextJob` takes the globally-oldest pending job — the
 * right behaviour for a worker, and the reason a test cannot assume the job it
 * enqueued is the job it gets back. Anything parked here is put back in `after`,
 * and would in any case be recovered by the stale-job reclaim if this crashed.
 */
const parked = [];

async function quiesceQueue() {
    for (let i = 0; i < 200; i += 1) {
        const job = await claimNextJob();

        if (!job) return;

        parked.push(job);
    }
}

async function releaseParked() {
    for (const job of parked) {
        await prisma.pdfJob
            .update({
                where: { id: job.id },
                data: {
                    status: "PENDING",
                    attempts: Math.max(job.attempts - 1, 0),
                    heartbeatAt: null,
                },
            })
            .catch(() => { });
    }
}

/** Backdates a held job's heartbeat: what a worker that was killed leaves behind. */
async function simulateWorkerDeath(jobId) {
    // Backdated with a JS date, not `NOW() - interval`, for the same reason the
    // service avoids NOW(): the column is `timestamp without time zone`, so the
    // two clocks disagree by the server's UTC offset.
    const longAgo = new Date(Date.now() - 86_400_000);

    await prisma.pdfJob.update({
        where: { id: jobId },
        data: { heartbeatAt: longAgo },
    });
}

describe("PDF ingestion queue", () => {
    before(async () => {
        server = app.listen(0);

        await new Promise((resolve) => server.once("listening", resolve));

        base = `http://127.0.0.1:${server.address().port}/api`;

        session.acmeMember = await login("member@acme.com");
        session.acmeAdmin = await login("admin@acme.com");
        session.globexAdmin = await login("admin@globex.com");

        await quiesceQueue();
    });

    after(async () => {
        await releaseParked();

        for (const id of createdNoteIds) {
            const note = await prisma.note.findUnique({ where: { id } });

            if (!note) continue;

            if (isPineconeConfigured()) {
                await deleteNoteVectors(note).catch(() => { });
            }

            await prisma.note.delete({ where: { id } }).catch(() => { });
        }

        await prisma.pdfJob.deleteMany({ where: { id: { in: createdJobIds } } });

        // The OCR test starts a Tesseract worker, and a live one keeps this
        // process alive after the last assertion — the run would never exit.
        await terminateOcrWorker();

        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    });

    it("accepts an upload with 202 and does not create a note yet", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT));

        // 202, not 201: the note this will become does not exist yet.
        assert.equal(res.status, 202);
        assert.equal(res.json.job.status, "PENDING");
        assert.equal(res.json.job.noteId, null);
        assert.match(res.json.statusUrl, /^\/api\/notes\/pdf\/jobs\//);

        // The raw upload must never travel back out to a client.
        assert.equal(res.json.job.fileData, undefined);

        // Take it out of the queue: the claim tests below assume they are the
        // only source of pending work.
        await failJob(res.json.job.id, new Error("parked by test"), { terminal: true });
    });

    it("rejects a non-PDF upload with 415 rather than a 500", async () => {
        const form = new FormData();

        form.append("file", new Blob(["not a pdf"], { type: "text/plain" }), "notes.txt");

        const res = await fetch(`${base}/notes/pdf`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.acmeMember.token}` },
            body: form,
        });

        assert.equal(res.status, 415);

        // Multer rejects before the controller runs, so this only holds while
        // app.js has an error handler — the default one answers with HTML.
        const json = await res.json();

        assert.match(json.message, /PDF/i);
    });

    it("hides a job from another tenant", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT));

        const mine = await api(`/notes/pdf/jobs/${res.json.job.id}`, {
            token: session.acmeMember.token,
        });

        assert.equal(mine.status, 200);

        // 404, not 403 — the response must not confirm the id exists.
        const theirs = await api(`/notes/pdf/jobs/${res.json.job.id}`, {
            token: session.globexAdmin.token,
        });

        assert.equal(theirs.status, 404);

        await failJob(res.json.job.id, new Error("parked by test"), { terminal: true });
    });

    it("lets an ADMIN see a member's job but not the other way round", async () => {
        const memberJob = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT));
        const adminJob = await upload(session.acmeAdmin.token, textPdf(SAMPLE_TEXT));

        const adminReadsMember = await api(`/notes/pdf/jobs/${memberJob.json.job.id}`, {
            token: session.acmeAdmin.token,
        });

        assert.equal(adminReadsMember.status, 200);

        const memberReadsAdmin = await api(`/notes/pdf/jobs/${adminJob.json.job.id}`, {
            token: session.acmeMember.token,
        });

        assert.equal(memberReadsAdmin.status, 404);

        for (const job of [memberJob, adminJob]) {
            await failJob(job.json.job.id, new Error("parked by test"), { terminal: true });
        }
    });

    it("hands a job to exactly one of two workers claiming at once", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT), "race.pdf");
        const jobId = res.json.job.id;

        // Two claims in flight simultaneously, as two worker processes would be.
        const claims = await Promise.all([claimNextJob(), claimNextJob()]);

        const winners = claims.filter((job) => job?.id === jobId);

        assert.equal(
            winners.length,
            1,
            "SELECT ... FOR UPDATE SKIP LOCKED must let only one worker claim a job",
        );
        assert.equal(winners[0].status, "RUNNING");
        assert.equal(winners[0].attempts, 1);

        // Release anything else this race happened to pick up.
        for (const job of claims) {
            if (job && job.id !== jobId) {
                await failJob(job.id, new Error("released by test"));
            }
        }
    });

    it("returns a job abandoned by a dead worker to the queue", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT), "crash.pdf");
        const jobId = res.json.job.id;

        const claimed = await claimNextJob();

        assert.equal(claimed.id, jobId);
        assert.equal(claimed.status, "RUNNING");

        await simulateWorkerDeath(jobId);

        const reclaimed = await reclaimStaleJobs();

        assert.ok(
            reclaimed.some((job) => job.id === jobId && job.status === "PENDING"),
            "a RUNNING job with a stale heartbeat must go back to PENDING",
        );

        // Still holding its bytes, because it is going to run again.
        const row = await prisma.pdfJob.findUnique({ where: { id: jobId } });

        assert.ok(row.fileData, "a retryable job must keep the upload it needs");

        // This test deliberately leaves the job runnable, so park it before the
        // next test claims — it would otherwise be the oldest pending work.
        await failJob(jobId, new Error("parked by test"), { terminal: true });
    });

    it("does not reclaim a job that is still heartbeating", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT), `alive-${RUN_TAG}.pdf`);
        const jobId = res.json.job.id;

        const claimed = await claimNextJob();

        assert.equal(claimed.id, jobId);

        // A worker part-way through a long OCR run: still working, still saying so.
        await heartbeat(jobId);

        const reclaimed = await reclaimStaleJobs();

        assert.ok(
            !reclaimed.some((job) => job.id === jobId),
            "a job with a fresh heartbeat must not be taken from its worker",
        );

        const row = await prisma.pdfJob.findUnique({ where: { id: jobId } });

        // Regression guard. `heartbeat` writes through Prisma and the reclaim
        // query compares in SQL; while that comparison used NOW(), the two
        // clocks differed by the database's UTC offset and every heartbeat made
        // the job look hours stale — so a healthy job was reclaimed on the spot,
        // re-run from the start, and eventually failed for running out of tries.
        assert.equal(row.status, "RUNNING", "a heartbeating job must stay RUNNING");
        assert.equal(row.attempts, 1, "a heartbeating job must not be re-claimed");

        await failJob(jobId, new Error("parked by test"), { terminal: true });
    });

    it("retires a job that has burned its attempts instead of looping forever", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT), "doomed.pdf");
        const jobId = res.json.job.id;

        await prisma.pdfJob.update({
            where: { id: jobId },
            data: { status: "RUNNING", attempts: maxAttempts(), heartbeatAt: new Date() },
        });

        await simulateWorkerDeath(jobId);
        await reclaimStaleJobs();

        const row = await prisma.pdfJob.findUnique({ where: { id: jobId } });

        assert.equal(row.status, "FAILED");
        assert.equal(row.fileData, null, "a retired job must release its upload");
        assert.match(row.error, /interrupted/i);
    });

    it("creates exactly one note when a crashed job is retried", async () => {
        const res = await upload(session.acmeMember.token, textPdf(SAMPLE_TEXT), `once-${RUN_TAG}.pdf`);
        const jobId = res.json.job.id;

        // Attempt 1: claimed, then the worker dies before it can commit.
        const first = await claimNextJob();

        assert.equal(first.id, jobId);

        await simulateWorkerDeath(jobId);
        await reclaimStaleJobs();

        // Attempt 2: a different worker picks it up and finishes.
        const second = await claimNextJob();

        assert.equal(second.id, jobId);
        assert.equal(second.attempts, 2, "the retry must be counted");

        const note = await processPdfJob(second);

        createdNoteIds.push(note.id);

        // The interrupted attempt must not have left a note of its own behind.
        const notes = await prisma.note.findMany({
            where: { tenantId: session.acmeMember.user.tenantId, sourceName: `once-${RUN_TAG}.pdf` },
        });

        assert.equal(notes.length, 1, "a retried job must not produce a second note");
        assert.equal(notes[0].id, note.id);
        assert.match(notes[0].content, /quarterly maintenance window/);

        const row = await prisma.pdfJob.findUnique({ where: { id: jobId } });

        assert.equal(row.status, "DONE");
        assert.equal(row.noteId, note.id);
        assert.equal(row.usedOcr, false, "a PDF with a text layer must not report OCR");
        assert.equal(row.pages, 1);
        assert.equal(row.fileData, null, "a finished job must release its upload");
    });

    it("fails a PDF with no readable text terminally, without spending retries", async (t) => {
        // The slow one: this actually runs Tesseract over the blank pages.
        t.diagnostic("runs real OCR — expect this to take a few seconds");

        const res = await upload(session.acmeMember.token, blankPdf(3), `blank-${RUN_TAG}.pdf`);
        const jobId = res.json.job.id;

        const job = await claimNextJob();

        assert.equal(job.id, jobId);

        await assert.rejects(
            () => processPdfJob(job),
            (error) => error.name === "UnprocessablePdfError",
            "a blank scan must be rejected, not saved as an empty note",
        );

        await failJob(jobId, new Error("no readable text"), { terminal: true });

        const row = await prisma.pdfJob.findUnique({ where: { id: jobId } });

        // FAILED on attempt 1: a blank page will still be blank on attempt 3.
        assert.equal(row.status, "FAILED");
        assert.equal(row.attempts, 1);

        const notes = await prisma.note.findMany({
            where: { tenantId: session.acmeMember.user.tenantId, sourceName: `blank-${RUN_TAG}.pdf` },
        });

        assert.equal(notes.length, 0, "an unreadable PDF must not create a note");
    });
});
