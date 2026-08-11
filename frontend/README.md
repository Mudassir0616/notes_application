# Notes frontend

Minimal Next.js (App Router, JavaScript) client for the multi-tenant notes API.
See the [root README](../README.md) for setup and for how tenant isolation is enforced.

```bash
npm install
cp .env.example .env.local   # point NEXT_PUBLIC_API_URL at the API
npm run dev                  # http://localhost:3000
```

Requires Node.js 20+ (see `.nvmrc`). The API must be running first.
