# Multi-tenant Notes

A small multi-tenant notes app: a Node.js/Express + PostgreSQL API (`pern-stack/`) and a
minimal Next.js client (`frontend/`). Two tenants (`acme` and `globex`) are seeded, each
with an `ADMIN` and a `MEMBER` user. Authentication is JWT-based, and every note operation
is scoped to the caller's tenant.

## Requirements

- PostgreSQL 13+
- Node.js 18+ for the API
- **Node.js 20+ for the frontend** (Next.js 15 requires it — `frontend/.nvmrc` pins 20)

## Setup

### 1. API

```bash
cd pern-stack
npm install                  # installs dependencies and runs `prisma generate`
cp .env.example .env         # then edit DATABASE_URL and JWT_SECRET
npm run prisma:migrate       # create the schema
npm run prisma:seed          # create the two tenants and four users
npm run dev                  # http://localhost:8000
```

### 2. Frontend

In a second terminal, with the API already running:

```bash
cd frontend
nvm use                      # Node 20+
npm install
cp .env.example .env.local   # NEXT_PUBLIC_API_URL, defaults to the API above
npm run dev                  # http://localhost:3000
```

Sign in with any seeded account below to create, edit and delete notes. Sign in as
`acme` and `globex` users in two different browser profiles to see the isolation directly:
neither tenant's notes appear in the other's list.

### Environment variables

| Variable         | Description                                    |
| ---------------- | ---------------------------------------------- |
| `DATABASE_URL`   | Postgres connection string used by Prisma      |
| `JWT_SECRET`     | Secret used to sign and verify JWTs (required) |
| `JWT_EXPIRES_IN` | Token lifetime, defaults to `1d`               |
| `PORT`           | HTTP port, defaults to `8000`                  |

## Seeded accounts

All four accounts share the password `mumBai#64`.

| Email               | Tenant   | Role     |
| ------------------- | -------- | -------- |
| `admin@acme.com`    | `acme`   | `ADMIN`  |
| `member@acme.com`   | `acme`   | `MEMBER` |
| `admin@globex.com`  | `globex` | `ADMIN`  |
| `member@globex.com` | `globex` | `MEMBER` |

## API

| Method   | Endpoint          | Auth | Description                           |
| -------- | ----------------- | ---- | ------------------------------------- |
| `GET`    | `/api/health`     | no   | Liveness check                        |
| `POST`   | `/api/auth/login` | no   | Exchange email + password for a JWT   |
| `GET`    | `/api/auth/me`    | yes  | Identity + tenant of the token holder |
| `POST`   | `/api/notes`      | yes  | Create a note in the caller's tenant  |
| `GET`    | `/api/notes`      | yes  | List the notes of the caller's tenant |
| `PUT`    | `/api/notes/:id`  | yes  | Update a note (see permissions below) |
| `DELETE` | `/api/notes/:id`  | yes  | Delete a note (see permissions below) |

Authenticated requests send `Authorization: Bearer <token>`.

```bash
TOKEN=$(curl -s localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"member@acme.com","password":"mumBai#64"}' | jq -r .token)

curl -s localhost:8000/api/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Standup","content":"Ship the notes API"}'
```

### Permissions

| Action              | `MEMBER`       | `ADMIN`                      |
| ------------------- | -------------- | ---------------------------- |
| Create note         | yes            | yes                          |
| List tenant's notes | yes            | yes                          |
| Update note         | own notes only | any note **in their tenant** |
| Delete note         | own notes only | any note **in their tenant** |

No role can reach across a tenant boundary — an `ADMIN` of `acme` has no more access to
`globex` data than an anonymous caller does.

Denied requests return **`404`, not `403`**. A `403` would confirm that the note id exists,
letting an attacker enumerate another tenant's notes; `404` makes "not yours" and
"does not exist" indistinguishable.

## Where tenant isolation is enforced

Isolation rests on one rule: **the tenant is only ever read from the verified JWT, never
from anything the client can edit.** It is enforced at three layers.

### 1. Token issuance — [`src/controllers/authController.js`](pern-stack/src/controllers/authController.js)

On login the server looks up the user's own `tenantId` and `role` from the database and
signs them into the token. The client never supplies either value, and the signature makes
them unforgeable — a tampered token fails `jwt.verify` and is rejected with `401`.
`GET /auth/me` resolves the user from the id inside the verified token, never from a
client-supplied id, so it cannot be used to read another account.

### 2. Authentication middleware — [`src/middlewares/auth.middleware.js`](pern-stack/src/middlewares/auth.middleware.js)

`authenticate` verifies the signature and copies the claims onto `req.user`
(`id`, `tenantId`, `role`). It is mounted with `router.use(authenticate)` in
[`src/routes/notesRoutes.js`](pern-stack/src/routes/notesRoutes.js), so it applies to
**every** notes route by default — a new route cannot be added unauthenticated by accident.

### 3. Every query in [`src/controllers/notesController.js`](pern-stack/src/controllers/notesController.js)

- **Create** derives `tenantId` and `authorId` from `req.user`, so `tenantId` or `authorId`
  in the request body are simply ignored.
- **List** filters on `where: { tenantId: req.user.tenantId }`.
- **Update and delete** use a _find-then-act_ pattern: they first `findFirst` the note with
  `{ id, tenantId: req.user.tenantId }` — plus `authorId: req.user.id` when the caller is a
  `MEMBER` — and only then act on the row that was found. Prisma's
  `update({ where: { id } })` accepts only a unique field, so scoping there would have been
  easy to omit silently; matching first makes the tenant filter impossible to skip.

The database reinforces this: `Note.tenantId` is a non-null foreign key to `Tenant`, and
`@@index([tenantId, authorId])` keeps the scoped lookups fast.

### Why request tampering fails

| Attack                                             | Result                                 |
| -------------------------------------------------- | -------------------------------------- |
| `POST /api/notes` with another tenant's `tenantId` | Ignored; note is created in own tenant |
| `PUT`/`DELETE` with another tenant's note id       | `404` — the `findFirst` matches no row |
| Editing the `tenantId` claim inside the JWT        | `401` — signature check fails          |
| Presenting an `alg: none` token                    | `401` — rejected by `jsonwebtoken`     |
| `MEMBER` targeting a colleague's note id           | `404` — `authorId` filter excludes it  |

## How this was tested

The suite in [`tests/isolation.test.js`](pern-stack/tests/isolation.test.js) is the proof.
It boots the real Express app on an ephemeral port and drives it over HTTP the way an
attacker would — no mocks, no internal function calls, a real Postgres database. Each test
asserts on the HTTP status _and_ re-reads the row directly from the database to confirm
nothing changed underneath. Every note it creates is deleted afterwards.

```bash
npm run prisma:migrate && npm run prisma:seed
npm test
```

The 14 cases cover:

- **Seed and claims** — the two tenants get distinct ids, and every token carries
  `userId`, `tenantId` and `role`.
- **Identity** — `/auth/me` requires a token and resolves each token to its own tenant;
  a `globex` token never resolves to `acme`.
- **Authentication** — wrong password, absent token, malformed token, a token forged with
  the wrong secret, and an `alg: none` downgrade all return `401`.
- **Create** — `tenantId`/`authorId` in the request body are ignored in favour of the token
  claims; missing fields return `400`.
- **List** — each tenant sees only its own notes, and neither tenant's note appears in the
  other's list.
- **Cross-tenant update** — a `globex` admin _and_ member each try to `PUT` an `acme` note
  by id; both get `404`, and the row is re-read to confirm the title and content are
  unchanged.
- **Cross-tenant delete** — the same pair try to `DELETE` an `acme` note; both get `404`
  and the row still exists.
- **Admin boundary** — an `acme` admin cannot update or delete a `globex` note.
- **Role rules within a tenant** — a `MEMBER` gets `404` updating or deleting a colleague's
  note but succeeds on their own; an `ADMIN` succeeds on any note in their tenant.
- **Bad input** — unknown and malformed ids return `404`, never `500`.

Current result: **14/14 passing.**

The frontend is deliberately not part of this suite. It is a presentation layer: it hides
buttons a user cannot use, but every rule it reflects is enforced independently by the API,
which is what the tests exercise.

## Frontend

`frontend/` is a minimal Next.js 15 app (App Router, JavaScript, no TypeScript) with two
routes — `/login` and `/` — and plain CSS.

```
frontend/
  app/
    layout.js              Wraps the tree in AuthProvider
    page.js                Notes list, create, inline edit, delete
    login/page.js          Sign-in form with the seeded accounts
    globals.css            All styling
  lib/
    api.js                 fetch wrapper, token storage, endpoint calls
    auth.js                AuthProvider, useAuth, canModify
```

Notes on how it integrates:

- **The token** is kept in `localStorage` and sent as `Authorization: Bearer <token>`.
  On load, `AuthProvider` validates it against `/auth/me` instead of trusting its contents,
  and discards it if the API rejects it.
- **The client never sends a `tenantId`.** Creating a note posts only `title` and
  `content`; the server derives the rest from the token. There is no field in the UI that
  could redirect a write to another tenant.
- **`canModify()` in `lib/auth.js` mirrors the server rule** (`ADMIN`, or the note's author)
  purely to hide Edit and Delete on notes the user cannot change. Bypassing it in devtools
  changes nothing — the API still answers `404`.
- **A `401` from any call** clears the token and returns the user to `/login`, so an expired
  token in an open tab fails cleanly.

## Project layout

```
pern-stack/                API
  prisma/
    schema.prisma          Tenant, User, Note models and the Role enum
    seed.js                Seeds acme + globex and their four users
  src/
    server.js              Loads .env, validates JWT_SECRET, starts listening
    app.js                 Builds and exports the Express app
    routes/                Route definitions
    controllers/           Request handlers, where tenant scoping lives
    middlewares/           JWT authentication
    lib/prisma.js          Shared Prisma client
  tests/
    isolation.test.js      Tenant-isolation and permission suite

frontend/                  Next.js client
```

## Known limitations

- Isolation is enforced in the controller layer. A defence-in-depth layer — a Prisma client
  extension or Postgres row-level security — would keep a future controller that forgets the
  filter from leaking data. Worth adding before this grows.
- `role` is embedded in the token, so a role change only takes effect at the next login or
  once the token expires.
- The frontend stores its token in `localStorage`, which is readable by any script on the
  origin. An httpOnly cookie would be the hardened choice for production.
- The login endpoint has no rate limiting, and CORS is open to all origins.
- There is no user-registration endpoint; users come from the seed.
