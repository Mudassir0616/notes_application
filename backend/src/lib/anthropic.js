import Anthropic from "@anthropic-ai/sdk";

// Answer generation for the RAG endpoint.
//
// Retrieval is Pinecone's job (see lib/pinecone.js); this is the other half —
// the model that turns retrieved chunks into a written answer. It is configured
// separately and is separately optional: without a key, search still works and
// only /notes/ask returns 503.

/** Must be a current model — the request uses adaptive thinking and `effort`. */
export const ANSWER_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export class AnswerUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "AnswerUnavailableError";
    }
}

/** The model declined to answer. A valid outcome, not a transport failure. */
export class AnswerRefusedError extends Error {
    constructor(message) {
        super(message);
        this.name = "AnswerRefusedError";
    }
}

let client;

export function isAnswerConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Lazily constructed so a missing key doesn't break importing this module. */
export function getAnthropic() {
    if (!isAnswerConfigured()) {
        throw new AnswerUnavailableError("ANTHROPIC_API_KEY is not set");
    }

    if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    return client;
}
