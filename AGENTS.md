# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js/Express API in `backend/` and a Next.js client in `frontend/`. The frontend uses the App Router with plain JavaScript — do not introduce TypeScript — keeps components in `frontend/app/` and shared logic in `frontend/lib/`. Both halves need Node 20+: the frontend for Next.js 15, the API because PDF extraction goes through `pdfjs-dist` 5, which fails to load on Node 18. Keep its UI minimal and its styling in `app/globals.css`. Application source lives in `backend/src/`: `server.js` loads the environment and starts listening, `app.js` builds and exports the Express app (import it in tests to avoid binding a port), `routes/` defines API routes, `controllers/` holds request handlers, `middlewares/` contains auth middleware, and `lib/prisma.js` centralizes Prisma access. Database schema, migrations, and seed data are in `backend/prisma/`, and tests live in `backend/tests/`. Semantic search lives in `backend/src/lib/chunker.js`, `backend/src/lib/pinecone.js`, and `backend/src/services/`; chunk vectors live in Pinecone (one namespace per tenant), not Postgres, so deletes must be explicit — there is no cascade. Retrieval-augmented answering (`/notes/ask`) sits on top of that in `backend/src/lib/anthropic.js` and `backend/src/services/noteAnswerService.js`: it retrieves through `searchNotes()` and adds no store of its own, so never give the model note text that did not come back from a tenant-scoped retrieval.

PDF ingestion is asynchronous and must stay that way: `POST /notes/pdf` only writes a `PdfJob` row and returns `202`, and all extraction happens in `backend/src/workers/pdfWorker.js` — never move OCR back into a request handler. The queue lives in `backend/src/services/pdfJobService.js` (claim, heartbeat, reclaim, fail) and the per-job work in `backend/src/services/pdfIngestService.js`, which must keep creating the note and marking the job `DONE` in one transaction, or a retried job will produce a duplicate note. Jobs carry `tenantId`/`authorId` copied from the JWT at enqueue time; the worker has no request context, so that row is the only authority on ownership. `PdfJob` timestamps are `@db.Timestamptz(3)` and are stamped in JavaScript rather than with SQL `NOW()` — mixing the two silently breaks heartbeats on a non-UTC database.

Keep the dependency list minimal: the API needs only Express, Prisma, `jsonwebtoken`, `bcryptjs`, `cors`, `dotenv`, `@pinecone-database/pinecone`, `@anthropic-ai/sdk`, and — for PDF ingestion — `multer`, `pdf-parse`, `pdf-to-img`, and `tesseract.js`. The queue deliberately adds none: it is a Postgres table, not a broker.

## Build, Test, and Development Commands

Run commands from `backend/`.

- `npm install`: install dependencies and run `prisma generate` via `postinstall`.
- `npm run prisma:generate`: regenerate the Prisma client after schema changes.
- `npm run prisma:migrate`: create/apply a development migration using `DATABASE_URL`.
- `npm run prisma:seed`: seed the database with `prisma/seed.js`.
- `npm run dev`: run the API with nodemon reloads on `PORT` or `8000`. It also starts a PDF worker in-process unless `PDF_WORKER_INLINE=false`.
- `npm start`: run the API once with Node.
- `npm run worker`: run a standalone PDF worker. Use this in production with `PDF_WORKER_INLINE=false` on the API, so OCR does not compete with request handling. Several may run at once.

## Coding Style & Naming Conventions

Use ES modules (`import`/`export`) and keep files focused by layer: route definitions call controllers, controllers contain request logic, and shared services/helpers belong in `lib/`. Follow the existing JavaScript style: semicolons, double quotes, and 4-space indentation. Name route files by domain, such as `authRoutes.js`, and controllers as `authController.js` or `notesController.js`.

## Testing Guidelines

Tests use the built-in Node test runner (`node --test`) and live in top-level `tests/` files named `*.test.js`. Run them with `npm test`; they need a migrated and seeded database (`npm run prisma:migrate && npm run prisma:seed`). `tests/search.test.js` and `tests/ask.test.js` skip with a printed reason when their keys are absent rather than failing — keep it that way, and keep `ask.test.js` small, since it makes billable model calls. `tests/isolation.test.js` covers authentication, tenant isolation, and role permissions — extend it when touching auth or notes scoping. `tests/pdfJobs.test.js` covers the ingestion queue and needs no keys, but no other worker may run against the same database while it executes, or it will claim the jobs the tests are about to claim — stop `npm run dev` or set `PDF_WORKER_INLINE=false` first. Build PDF fixtures with `tests/fixtures/pdf.js` rather than committing binaries. Note that on Node 18 top-level `before`/`after` hooks do not run, so wrap suites in `describe`. Tests must delete any rows they create.

## Commit & Pull Request Guidelines

This checkout does not expose usable Git history, so use clear imperative commit messages such as `Add note filtering` or `Fix auth token validation`. Pull requests should include a short summary, database migration notes, required environment variables, test results, and API examples or screenshots when behavior changes.

## Security & Configuration Tips

Keep secrets in `backend/.env` and do not commit real credentials. `DATABASE_URL` and `JWT_SECRET` are required, and `.env.example` documents them with safe placeholder values — update it whenever a new variable is introduced. Never read a tenant id from the request body, query string, or path; it comes only from the verified JWT via `req.user`.
