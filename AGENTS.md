# Repository Guidelines

## Project Structure & Module Organization

This repository contains a Node.js/Express API in `backend/` and a Next.js client in `frontend/`. The frontend uses the App Router with plain JavaScript — do not introduce TypeScript — keeps components in `frontend/app/` and shared logic in `frontend/lib/`, and needs Node 20+ while the API runs on Node 18+. Keep its UI minimal and its styling in `app/globals.css`. Application source lives in `backend/src/`: `server.js` loads the environment and starts listening, `app.js` builds and exports the Express app (import it in tests to avoid binding a port), `routes/` defines API routes, `controllers/` holds request handlers, `middlewares/` contains auth middleware, and `lib/prisma.js` centralizes Prisma access. Database schema, migrations, and seed data are in `backend/prisma/`, and tests live in `backend/tests/`. Semantic search lives in `backend/src/lib/chunker.js`, `backend/src/lib/pinecone.js`, and `backend/src/services/`; chunk vectors live in Pinecone (one namespace per tenant), not Postgres, so deletes must be explicit — there is no cascade. Keep the dependency list minimal: the API needs only Express, Prisma, `jsonwebtoken`, `bcryptjs`, `cors`, `dotenv`, and `@pinecone-database/pinecone`.

## Build, Test, and Development Commands

Run commands from `backend/`.

- `npm install`: install dependencies and run `prisma generate` via `postinstall`.
- `npm run prisma:generate`: regenerate the Prisma client after schema changes.
- `npm run prisma:migrate`: create/apply a development migration using `DATABASE_URL`.
- `npm run prisma:seed`: seed the database with `prisma/seed.js`.
- `npm run dev`: run the API with nodemon reloads on `PORT` or `8000`.
- `npm start`: run the API once with Node.

## Coding Style & Naming Conventions

Use ES modules (`import`/`export`) and keep files focused by layer: route definitions call controllers, controllers contain request logic, and shared services/helpers belong in `lib/`. Follow the existing JavaScript style: semicolons, double quotes, and 4-space indentation. Name route files by domain, such as `authRoutes.js`, and controllers as `authController.js` or `notesController.js`.

## Testing Guidelines

Tests use the built-in Node test runner (`node --test`) and live in top-level `tests/` files named `*.test.js`. Run them with `npm test`; they need a migrated and seeded database (`npm run prisma:migrate && npm run prisma:seed`). `tests/isolation.test.js` covers authentication, tenant isolation, and role permissions — extend it when touching auth or notes scoping. Note that on Node 18 top-level `before`/`after` hooks do not run, so wrap suites in `describe`. Tests must delete any rows they create.

## Commit & Pull Request Guidelines

This checkout does not expose usable Git history, so use clear imperative commit messages such as `Add note filtering` or `Fix auth token validation`. Pull requests should include a short summary, database migration notes, required environment variables, test results, and API examples or screenshots when behavior changes.

## Security & Configuration Tips

Keep secrets in `backend/.env` and do not commit real credentials. `DATABASE_URL` and `JWT_SECRET` are required, and `.env.example` documents them with safe placeholder values — update it whenever a new variable is introduced. Never read a tenant id from the request body, query string, or path; it comes only from the verified JWT via `req.user`.
