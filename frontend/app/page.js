"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../lib/api";
import { canModify, useAuth } from "../lib/auth";

export default function NotesPage() {
    const router = useRouter();
    const { user, loading, logout } = useAuth();

    const [notes, setNotes] = useState([]);
    const [loadingNotes, setLoadingNotes] = useState(true);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const [title, setTitle] = useState("");
    const [content, setContent] = useState("");

    // PDF upload is asynchronous now: the request returns a job id, and the
    // note only exists once a worker has finished with it. `pdfJob` holds the
    // job currently being polled, which is what the progress line renders.
    const [pdfFile, setPdfFile] = useState(null);
    const [uploadingPdf, setUploadingPdf] = useState(false);
    const [pdfJob, setPdfJob] = useState(null);

    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState("");
    const [editContent, setEditContent] = useState("");

    // Semantic search. `results` being non-null is what swaps the note list out
    // for the result view.
    const [query, setQuery] = useState("");
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);

    // Ask-your-notes. Like `results`, a non-null `answer` is what swaps the
    // note list out — the two views are mutually exclusive.
    const [answer, setAnswer] = useState(null);
    const [asking, setAsking] = useState(false);

    // A 401 means the token expired or was revoked while the tab was open.
    const handleError = useCallback(
        (err) => {
            if (err.status === 401) {
                logout();
                router.replace("/login");
                return;
            }

            setError(err.message);
        },
        [logout, router],
    );

    const loadNotes = useCallback(async () => {
        try {
            setNotes(await api.listNotes());
            setError("");
        } catch (err) {
            handleError(err);
        } finally {
            setLoadingNotes(false);
        }
    }, [handleError]);

    useEffect(() => {
        if (loading) return;

        if (!user) {
            router.replace("/login");
            return;
        }

        loadNotes();
    }, [loading, user, router, loadNotes]);

    async function handleCreate(event) {
        event.preventDefault();

        setBusy(true);

        try {
            // Only title and content are sent. tenantId and authorId come from
            // the token on the server.
            await api.createNote(title.trim(), content.trim());

            setTitle("");
            setContent("");

            await loadNotes();
        } catch (err) {
            handleError(err);
        } finally {
            setBusy(false);
        }
    }

    async function handleSearch(event) {
        event.preventDefault();

        const trimmed = query.trim();

        if (!trimmed) return;

        setSearching(true);
        setError("");
        setResults(null);
        setAnswer(null);

        try {
            const response = await api.searchNotes(trimmed);

            setResults(response.results);
        } catch (err) {
            handleError(err);
        } finally {
            setSearching(false);
        }
    }

    // Same box, same tenant scoping — the difference is that the server sends
    // the matching chunks to a model and returns prose with citations instead
    // of a ranked list.
    async function handleAsk() {
        const trimmed = query.trim();

        if (!trimmed) return;

        setAsking(true);
        setError("");
        setResults(null);
        setAnswer(null);

        try {
            setAnswer(await api.askNotes(trimmed));
        } catch (err) {
            handleError(err);
        } finally {
            setAsking(false);
        }
    }

    function clearSearch() {
        setQuery("");
        setResults(null);
        setAnswer(null);
        setError("");
    }

    function startEditing(note) {
        setEditingId(note.id);
        setEditTitle(note.title);
        setEditContent(note.content);
        setError("");
    }

    async function handleUpdate(event, id) {
        event.preventDefault();

        setBusy(true);

        try {
            await api.updateNote(id, {
                title: editTitle.trim(),
                content: editContent.trim(),
            });

            setEditingId(null);

            await loadNotes();
        } catch (err) {
            handleError(err);
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete(id) {
        if (!window.confirm("Delete this note?")) return;

        setBusy(true);

        try {
            await api.deleteNote(id);

            await loadNotes();
        } catch (err) {
            handleError(err);
        } finally {
            setBusy(false);
        }
    }

    /**
     * Uploads a PDF and follows the job it creates.
     *
     * The upload itself returns almost immediately — it only queues the file —
     * so the wait that used to happen inside the request now happens here, one
     * poll at a time. The advantage is that the wait is now visible and
     * survivable: the page can say which stage the job is on, a slow scan
     * cannot time the request out, and closing the tab no longer loses the work.
     */
    async function handlePdfUpload(event) {
        event.preventDefault();

        if (!pdfFile) {
            setError("Please select a PDF file");
            return;
        }

        setUploadingPdf(true);
        setError("");

        try {
            const { job } = await api.uploadPdf(pdfFile);

            setPdfJob(job);
            setPdfFile(null);

            // Reset the actual file input.
            event.target.reset();

            const finished = await pollPdfJob(job.id);

            if (finished.status === "FAILED") {
                setError(finished.error || "The PDF could not be processed");
            } else {
                await loadNotes();
            }
        } catch (err) {
            handleError(err);
        } finally {
            setUploadingPdf(false);
        }
    }

    /**
     * Polls a job until it reaches a terminal state.
     *
     * A fixed one-second interval, because the honest answer to "how long will
     * this take" is "it depends on the document" — a text PDF is done on the
     * first poll, a long scan takes a minute of OCR. Nothing is lost by polling
     * a little longer; the job is safe in the database either way.
     */
    async function pollPdfJob(jobId) {
        // Roughly five minutes, which is past the point where a stuck job is
        // better reported than waited on. The job itself keeps going regardless.
        const MAX_POLLS = 300;

        for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
            const job = await api.getPdfJob(jobId);

            setPdfJob(job);

            if (job.done) return job;

            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        throw new ApiError("Still processing — check back in a moment", 504);
    }

    /** Human-readable progress for the job line under the upload form. */
    function describePdfJob(job) {
        if (job.status === "PENDING") {
            return job.attempts > 0
                ? `Queued for retry (attempt ${job.attempts + 1} of ${job.maxAttempts})…`
                : "Queued…";
        }

        if (job.status === "RUNNING") return "Extracting text (running OCR if needed)…";
        if (job.status === "FAILED") return job.error || "Failed";

        return job.usedOcr
            ? `Done — read ${job.pages} page(s) with OCR`
            : `Done — read ${job.pages} page(s)`;
    }

    if (loading || !user) return <main className="meta">Loading…</main>;

    return (
        <main>
            <div className="header">
                <div>
                    <h1>Notes</h1>
                    <p className="meta" style={{ margin: "4px 0 0" }}>
                        {user.tenant?.name || user.tenantId} · {user.email}{" "}
                        <span className="tag">{user.role}</span>
                    </p>
                </div>

                <button
                    className="secondary"
                    onClick={() => {
                        logout();
                        router.replace("/login");
                    }}
                >
                    Sign out
                </button>
            </div>

            <form className="search" onSubmit={handleSearch}>
                <input
                    placeholder="Search by meaning, or ask a question…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />

                <button type="submit" disabled={searching || asking || !query.trim()}>
                    {searching ? "…" : "Search"}
                </button>

                <button
                    type="button"
                    className="secondary"
                    onClick={handleAsk}
                    disabled={searching || asking || !query.trim()}
                >
                    {asking ? "…" : "Ask"}
                </button>

                {(results !== null || answer !== null) && (
                    <button type="button" className="secondary" onClick={clearSearch}>
                        Clear
                    </button>
                )}
            </form>

            {error && <p className="error">{error}</p>}

            {answer !== null ? (
                <div style={{ marginTop: 20 }}>
                    <article className="card answer">
                        <p>{answer.answer}</p>

                        {answer.sources.length > 0 && (
                            <div className="sources">
                                <p className="meta">Answered from</p>

                                {answer.sources.map((source) => (
                                    <p key={source.noteId} className="meta">
                                        <span className="score">[{source.citation}]</span>{" "}
                                        {source.title} · {source.authorEmail}
                                    </p>
                                ))}
                            </div>
                        )}
                    </article>
                </div>
            ) : results !== null ? (
                <div style={{ marginTop: 20 }}>
                    {results.length === 0 ? (
                        <p className="empty">Nothing in this tenant matched.</p>
                    ) : (
                        results.map((row, index) => (
                            <article
                                key={row.chunkId || `${row.noteId}-${index}`}
                                className="card note"
                            >
                                <h3>{row.title}</h3>

                                {row.chunk && <p>{row.chunk}</p>}

                                <p className="meta" style={{ marginTop: 12 }}>
                                    {row.authorEmail} · similarity{" "}
                                    <span className="score">{row.score}</span>
                                </p>
                            </article>
                        ))
                    )}
                </div>
            ) : (
                <>
                    <form className="card stack" onSubmit={handlePdfUpload}>
                        <h2>Upload PDF</h2>

                        <input
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={(event) => {
                                setPdfFile(event.target.files?.[0] || null);
                            }}
                        />

                        {pdfFile && (
                            <p className="meta">
                                Selected: {pdfFile.name}
                            </p>
                        )}

                        {/* The job line replaces the old spinner-in-the-dark: the
                            request is long gone, so this is the only thing that
                            can say what is actually happening. */}
                        {pdfJob && (
                            <p className="meta">
                                {pdfJob.fileName}: {describePdfJob(pdfJob)}
                            </p>
                        )}

                        <div>
                            <button
                                type="submit"
                                disabled={uploadingPdf || !pdfFile}
                            >
                                {uploadingPdf ? "Processing PDF…" : "Upload PDF"}
                            </button>
                        </div>
                    </form>

                    <form className="card stack" onSubmit={handleCreate}>
                        <h2>New note</h2>

                        <input
                            placeholder="Title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            required
                        />

                        <textarea
                            placeholder="Content"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            required
                        />

                        <div>
                            <button
                                type="submit"
                                disabled={busy || !title.trim() || !content.trim()}
                            >
                                Add note
                            </button>
                        </div>
                    </form>

                    <div style={{ marginTop: 28 }}>
                        {loadingNotes ? (
                            <p className="meta">Loading notes…</p>
                        ) : notes.length === 0 ? (
                            <p className="empty">No notes in this tenant yet.</p>
                        ) : (
                            notes.map((note) =>
                                editingId === note.id ? (
                                    <form
                                        key={note.id}
                                        className="card stack note"
                                        onSubmit={(e) => handleUpdate(e, note.id)}
                                    >
                                        <input
                                            value={editTitle}
                                            onChange={(e) => setEditTitle(e.target.value)}
                                            required
                                        />

                                        <textarea
                                            value={editContent}
                                            onChange={(e) => setEditContent(e.target.value)}
                                            required
                                        />

                                        <div className="row">
                                            <button type="submit" disabled={busy}>
                                                Save
                                            </button>

                                            <button
                                                type="button"
                                                className="secondary"
                                                onClick={() => setEditingId(null)}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </form>
                                ) : (
                                    <article key={note.id} className="card note">
                                        <h3>{note.title}</h3>
                                        <p>{note.content}</p>

                                        <div
                                            className="row"
                                            style={{
                                                marginTop: 12,
                                                justifyContent: "space-between",
                                            }}
                                        >
                                            <span className="meta">
                                                {note.author?.email}
                                                {note.author?.id === user.id && " (you)"} ·{" "}
                                                {new Date(note.createdAt).toLocaleDateString()}
                                            </span>

                                            {canModify(note, user) && (
                                                <span className="row">
                                                    <button
                                                        className="secondary"
                                                        onClick={() => startEditing(note)}
                                                        disabled={busy}
                                                    >
                                                        Edit
                                                    </button>

                                                    <button
                                                        className="danger"
                                                        onClick={() => handleDelete(note.id)}
                                                        disabled={busy}
                                                    >
                                                        Delete
                                                    </button>
                                                </span>
                                            )}
                                        </div>
                                    </article>
                                ),
                            )
                        )}
                    </div>
                </>
            )}
        </main>
    );
}
