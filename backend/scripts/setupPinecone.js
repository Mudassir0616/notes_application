// Creates the Pinecone index this app searches against.
//
//   npm run pinecone:setup
//
// The index is created with *integrated inference*: Pinecone hosts the
// embedding model, so the app upserts raw text and never calls an embedding
// provider itself. The model and its dimension are fixed at creation time —
// changing either means creating a new index and re-indexing.

import "dotenv/config";

import { Pinecone } from "@pinecone-database/pinecone";

import { EMBEDDING_MODEL, TEXT_FIELD } from "../src/lib/pinecone.js";

const NAME = process.env.PINECONE_INDEX || "notes-chunks";
const CLOUD = process.env.PINECONE_CLOUD || "aws";
const REGION = process.env.PINECONE_REGION || "us-east-1";

async function main() {
    if (!process.env.PINECONE_API_KEY) {
        console.error("PINECONE_API_KEY is not set. Copy .env.example to .env and add it.");
        process.exit(1);
    }

    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

    const existing = await pc.listIndexes();

    if (existing.indexes?.some((index) => index.name === NAME)) {
        console.log(`Index "${NAME}" already exists — nothing to do.`);
        return;
    }

    console.log(`Creating index "${NAME}" (${EMBEDDING_MODEL}, ${CLOUD}/${REGION})…`);

    const index = await pc.createIndexForModel({
        name: NAME,
        cloud: CLOUD,
        region: REGION,
        embed: { model: EMBEDDING_MODEL, fieldMap: { text: TEXT_FIELD } },
        waitUntilReady: true,
    });

    console.log(`Ready: dimension ${index?.dimension}, metric ${index?.metric}`);
}

main().catch((error) => {
    console.error("Pinecone setup failed:", error.message);
    process.exit(1);
});
