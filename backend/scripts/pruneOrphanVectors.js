// Deletes Pinecone vectors whose note no longer exists in Postgres.
//
//   npm run pinecone:prune           # report only
//   npm run pinecone:prune -- --fix  # actually delete
//
// Pinecone has no foreign keys, so nothing cascades when a note row is removed.
// The API deletes vectors before the row (see notesController.deleteNote), but
// anything that writes to the database directly — a manual DELETE, a restored
// dump, a crash between the two steps — can still strand vectors. An orphaned
// vector is deleted note content that is still retrievable, so this is a
// reconciliation job worth running on a schedule in production.

import "dotenv/config";

import prisma from "../src/lib/prisma.js";
import { getIndex, isPineconeConfigured } from "../src/lib/pinecone.js";

const FIX = process.argv.includes("--fix");

async function main() {
    if (!isPineconeConfigured()) {
        console.error("PINECONE_API_KEY is not set.");
        process.exit(1);
    }

    const index = getIndex();
    const stats = await index.describeIndexStats();
    const namespaces = Object.keys(stats.namespaces || {});

    const liveNoteIds = new Set((await prisma.note.findMany({ select: { id: true } })).map((n) => n.id));

    let totalOrphans = 0;

    for (const name of namespaces) {
        const namespace = index.namespace(name);
        const orphans = [];

        let paginationToken;

        do {
            const page = await namespace.listPaginated({ paginationToken });

            for (const vector of page.vectors || []) {
                // Vector ids are `<noteId>:<chunkIndex>`.
                const noteId = vector.id.split(":")[0];

                if (!liveNoteIds.has(noteId)) orphans.push(vector.id);
            }

            paginationToken = page.pagination?.next;
        } while (paginationToken);

        totalOrphans += orphans.length;

        if (!orphans.length) {
            console.log(`${name}: clean`);
            continue;
        }

        console.log(`${name}: ${orphans.length} orphaned vector(s)`);

        if (FIX) {
            // deleteMany caps at 1000 ids per call.
            for (let i = 0; i < orphans.length; i += 1000) {
                await namespace.deleteMany({ ids: orphans.slice(i, i + 1000) });
            }

            console.log(`${name}: deleted ${orphans.length}`);
        }
    }

    if (totalOrphans && !FIX) {
        console.log(`\n${totalOrphans} orphan(s) found. Re-run with --fix to delete them.`);
        process.exitCode = 1;
    } else if (!totalOrphans) {
        console.log("\nNo orphans.");
    }

    await prisma.$disconnect();
}

main().catch(async (error) => {
    console.error("Prune failed:", error.message);
    await prisma.$disconnect();
    process.exit(1);
});
