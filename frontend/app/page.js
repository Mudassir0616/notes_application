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
                    <button type="submit" disabled={busy || !title.trim() || !content.trim()}>
                        Add note
                    </button>
                </div>
            </form>

            {error && (
                <p className="error" style={{ marginTop: 20 }}>
                    {error}
                </p>
            )}

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
                                    style={{ marginTop: 12, justifyContent: "space-between" }}
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
        </main>
    );
}
