import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// Answer generation for the RAG endpoint.
//
// Retrieval is Pinecone's job (see lib/pinecone.js); this is the other half —
// the model that turns retrieved chunks into a written answer. It is configured
// separately and is separately optional: without a key, search still works and
// only /notes/ask returns 503.
//
// The answer model is currently Kimi, which speaks the OpenAI protocol, so the
// call site uses `chat.completions.create` — not Anthropic's `messages.create`.
// The Anthropic client is kept here for the eventual switch back.

export const ANSWER_MODEL = process.env.KIMI_MODEL || "kimi-k2.5";

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

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

// One cache per provider. A single shared `client` would hand back whichever
// provider happened to be constructed first.
let kimiClient;
let anthropicClient;

/** Whether the answer model (Kimi) is configured. Gates /notes/ask. */
export function isAnswerConfigured() {
    return Boolean(process.env.KIMI_API_KEY);
}

export function isAnthropicConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Lazily construct the Kimi client.
 * Moonshot/Kimi uses an OpenAI-compatible API.
 */
export function getKimi() {
    if (!isAnswerConfigured()) {
        throw new AnswerUnavailableError("KIMI_API_KEY is not set");
    }

    if (!kimiClient) {
        kimiClient = new OpenAI({
            apiKey: process.env.KIMI_API_KEY,
            baseURL: "https://api.moonshot.ai/v1",
        });
    }

    return kimiClient;
}

/** Lazily constructed so a missing key doesn't break importing this module. */
export function getAnthropic() {
    if (!isAnthropicConfigured()) {
        throw new AnswerUnavailableError("ANTHROPIC_API_KEY is not set");
    }

    if (!anthropicClient) {
        anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    return anthropicClient;
}
