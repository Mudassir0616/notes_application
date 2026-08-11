// Load .env before anything reads process.env (JWT_SECRET, DATABASE_URL).
import "dotenv/config";

import app from "./app.js";

if (!process.env.JWT_SECRET) {
    console.error("FATAL: JWT_SECRET is not set. Copy .env.example to .env.");
    process.exit(1);
}

const PORT = process.env.PORT || 8000;

app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
});
