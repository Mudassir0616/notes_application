// Minimal PDF builders for the ingestion tests.
//
// Built in code rather than committed as binaries so the fixtures stay
// reviewable: the difference between the two functions below *is* the
// difference between the two code paths under test.

function buildPdf(pageStreams) {
    const encoder = new TextEncoder();
    const objects = [];

    const pageIds = pageStreams.map((_, index) => 4 + index * 2);

    objects.push("<< /Type /Catalog /Pages 2 0 R >>");
    objects.push(
        `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] ` +
        `/Count ${pageStreams.length} >>`,
    );
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    for (const [index, stream] of pageStreams.entries()) {
        objects.push(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
            `/Contents ${pageIds[index] + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
        );
        objects.push(
            `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`,
        );
    }

    let body = "%PDF-1.4\n";
    const offsets = [];

    for (const [index, object] of objects.entries()) {
        offsets.push(body.length);
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }

    const startxref = body.length;

    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        body += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    body += `startxref\n${startxref}\n%%EOF\n`;

    return Buffer.from(body, "latin1");
}

/** A PDF with a real text layer — the fast path, no OCR needed. */
export function textPdf(text) {
    const lines = [];

    let y = 700;

    for (let i = 0; i < text.length; i += 60) {
        lines.push(`BT /F1 12 Tf 72 ${y} Td (${text.slice(i, i + 60)}) Tj ET`);
        y -= 20;
    }

    return buildPdf([lines.join("\n")]);
}

/**
 * A PDF with pages but no text anywhere — what a blank scan looks like to the
 * parser. `needsOcr` sees nothing, OCR runs and also finds nothing, and the job
 * fails terminally rather than burning its retry budget on an empty page.
 */
export function blankPdf(pages = 1) {
    return buildPdf(Array.from({ length: pages }, () => ""));
}
