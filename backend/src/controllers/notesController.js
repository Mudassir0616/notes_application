import prisma from "../lib/prisma.js";
import { isPineconeConfigured } from "../lib/pinecone.js";
import { deleteNoteVectors, indexNoteSafely } from "../services/noteSearchService.js";

export async function createNote(req, res) {
    try {
        const { title, content } = req.body;

        if (!title || !content) {
            return res.status(400).json({
                message: "Title and content are required",
            });
        }

        const note = await prisma.note.create({
            data: {
                title,
                content,

                // NEVER take this from req.body
                tenantId: req.user.tenantId,

                // NEVER take this from req.body
                authorId: req.user.id,
            },
        });

        // Best-effort: a note that fails to embed is still created and listed,
        // it just won't appear in semantic search until it is re-indexed.
        await indexNoteSafely(note);

        return res.status(201).json(note);
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "Failed to create note",
        });
    }
}

export async function listNotes(req, res) {
    try {
        const notes = await prisma.note.findMany({
            where: {
                tenantId: req.user.tenantId,
            },
            include: {
                author: {
                    select: {
                        id: true,
                        email: true,
                        role: true,
                    },
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });

        return res.json(notes);
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "Failed to fetch notes",
        });
    }
}

export async function updateNote(req, res) {
    try {
        const { id } = req.params;
        const { title, content } = req.body;

        // Tenant scope always applies. On top of it, a MEMBER may only touch
        // their own notes; an ADMIN may touch any note inside their tenant.
        const where = {
            id,
            tenantId: req.user.tenantId,
        };

        if (req.user.role === "MEMBER") {
            where.authorId = req.user.id;
        }

        const existingNote = await prisma.note.findFirst({
            where,
        });

        if (!existingNote) {
            return res.status(404).json({
                message: "Note not found or you do not have permission",
            });
        }

        const note = await prisma.note.update({
            where: {
                id: existingNote.id,
            },
            data: {
                ...(title !== undefined && { title }),
                ...(content !== undefined && { content }),
            },
        });

        // Re-embed only when the text actually changed; a no-op edit shouldn't
        // spend an embedding call.
        if (note.title !== existingNote.title || note.content !== existingNote.content) {
            await indexNoteSafely(note);
        }

        return res.json(note);
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "Failed to update note",
        });
    }
}

export async function deleteNote(req, res) {
    try {
        const { id } = req.params;

        const where = {
            id,
            tenantId: req.user.tenantId,
        };

        if (req.user.role === "MEMBER") {
            where.authorId = req.user.id;
        }

        const note = await prisma.note.findFirst({
            where,
        });

        if (!note) {
            return res.status(404).json({
                message: "Note not found or you do not have permission",
            });
        }

        // Vectors first, deliberately. Pinecone has no foreign key, so if this
        // fails we abort with the note still present: the user retries and the
        // content stays consistent. Deleting the row first would risk vectors
        // outliving it, leaving deleted content retrievable through search.
        if (isPineconeConfigured()) {
            try {
                await deleteNoteVectors(note);
            } catch (error) {
                console.error(`Failed to delete vectors for note ${note.id}:`, error.message);

                return res.status(500).json({
                    message: "Failed to delete note: its search entries could not be removed",
                });
            }
        }

        await prisma.note.delete({
            where: {
                id: note.id,
            },
        });

        return res.status(204).send();
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            message: "Failed to delete note",
        });
    }
}
