// Splits a note into overlapping chunks for embedding.
//
// Notes in this app are short, so most produce a single chunk. The splitter
// still exists because a long note embedded as one vector averages every topic
// it mentions into a single point, which makes it match everything weakly and
// nothing strongly.

const MAX_CHARS = 1000;
const OVERLAP_CHARS = 150;

/** Splits text that is already over the limit, preferring sentence ends. */
function splitOversized(text, maxChars) {
    const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [text];
    const pieces = [];

    let current = "";

    for (const sentence of sentences) {
        // A single sentence longer than the limit gets cut on length alone.
        if (sentence.length > maxChars) {
            if (current) {
                pieces.push(current);
                current = "";
            }

            for (let i = 0; i < sentence.length; i += maxChars) {
                pieces.push(sentence.slice(i, i + maxChars));
            }

            continue;
        }

        if (current.length + sentence.length > maxChars) {
            pieces.push(current);
            current = sentence;
        } else {
            current += sentence;
        }
    }

    if (current) pieces.push(current);

    return pieces;
}

/**
 * Chunks a note's content on paragraph boundaries, falling back to sentence
 * and then hard-length splits. Consecutive chunks share `overlap` characters so
 * a sentence spanning a boundary is still retrievable from one side.
 *
 * @returns {string[]} chunk texts in document order (never empty for non-blank input)
 */
export function chunkContent(content, { maxChars = MAX_CHARS, overlap = OVERLAP_CHARS } = {}) {
    const text = (content || "").trim();

    if (!text) return [];
    if (text.length <= maxChars) return [text];

    const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
    const blocks = [];

    for (const paragraph of paragraphs) {
        if (paragraph.length > maxChars) {
            blocks.push(...splitOversized(paragraph, maxChars));
        } else {
            blocks.push(paragraph);
        }
    }

    const chunks = [];

    let current = "";

    for (const block of blocks) {
        if (current && current.length + block.length + 2 > maxChars) {
            chunks.push(current.trim());

            // Carry the tail of the finished chunk into the next one.
            current = current.slice(-overlap) + "\n\n" + block;
        } else {
            current = current ? `${current}\n\n${block}` : block;
        }
    }

    if (current.trim()) chunks.push(current.trim());

    return chunks;
}

/**
 * Builds the text actually sent to the embedding model. The title is prepended
 * to every chunk so a chunk retrieved on its own still carries its subject —
 * without it, chunk 3 of a note is an anonymous paragraph.
 */
export function buildEmbeddingInput(title, chunk) {
    return `${title}\n\n${chunk}`;
}
