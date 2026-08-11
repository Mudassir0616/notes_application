"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
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

    const [editingId, setEditingId] = useState(null);
    const [editTitle, setEditTitle] = useState("");
    const [editContent, setEditContent] = useState("");

    // Semantic search. `results` being non-null is what swaps the note list out
    // for the result view.
    const [query, setQuery] = useState("");
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);

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

        try {
            const response = await api.searchNotes(trimmed);

            setResults(response.results);
        } catch (err) {
            handleError(err);
        } finally {
            setSearching(false);
        }
    }

    function clearSearch() {
        setQuery("");
        setResults(null);
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
                    placeholder="Search by meaning, not just keywords…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />

                <button type="submit" disabled={searching || !query.trim()}>
                    {searching ? "…" : "Search"}
                </button>

                {results !== null && (
                    <button type="button" className="secondary" onClick={clearSearch}>
                        Clear
                    </button>
                )}
            </form>

            {error && <p className="error">{error}</p>}

            {results !== null ? (
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
