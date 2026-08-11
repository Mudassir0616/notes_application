import prisma from "../lib/prisma.js";

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
