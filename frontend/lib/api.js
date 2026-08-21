const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

const TOKEN_KEY = "notes.token";

export function getToken() {
    if (typeof window === "undefined") return null;

    return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
    window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
    window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

async function request(
    path,
    {
        method = "GET",
        body,
        auth = true,
        apiHeaders = {},
    } = {},
) {
    const isFormData = body instanceof FormData;

    const headers = {
        ...apiHeaders,
    };

    // Don't set Content-Type manually for FormData.
    // Browser automatically sets:
    // multipart/form-data; boundary=...
    if (!isFormData) {
        headers["Content-Type"] = "application/json";
    }

    if (auth) {
        const token = getToken();

        if (token) {
            headers.Authorization = `Bearer ${token}`;
        }
    }

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: isFormData
            ? body
            : body
                ? JSON.stringify(body)
                : undefined,
    });

    if (res.status === 204) return null;

    let data = null;

    try {
        data = await res.json();
    } catch {
        // Empty body.
    }

    if (!res.ok) {
        throw new ApiError(
            data?.message || `Request failed (${res.status})`,
            res.status,
        );
    }

    return data;
}

// The client never sends a tenantId. The server reads it from the JWT, so there
// is nothing here for a user to tamper with — see the README.
export const api = {
    login: (email, password) =>
        request("/auth/login", {
            method: "POST",
            body: { email, password },
            auth: false,
        }),

    me: () => request("/auth/me"),

    listNotes: () => request("/notes"),

    createNote: (title, content) =>
        request("/notes", { method: "POST", body: { title, content } }),

    updateNote: (id, fields) =>
        request(`/notes/${id}`, { method: "PUT", body: fields }),

    deleteNote: (id) => request(`/notes/${id}`, { method: "DELETE" }),

    // Semantic search. The query is the only input; the tenant comes from the
    // token on the server, so there is nothing here to scope client-side.
    searchNotes: (query, limit) =>
        request(
            `/notes/search?q=${encodeURIComponent(query)}` +
            (limit ? `&limit=${encodeURIComponent(limit)}` : ""),
        ),

    // Retrieval-augmented answering over the same notes search reads. POST
    // because a question is prose, not a query string.
    askNotes: (question, limit) =>
        request("/notes/ask", { method: "POST", body: { question, limit } }),

    // Returns 202 with a job, not a note: the PDF is queued and a worker does
    // the extraction. Poll `getPdfJob` until `done` before reloading notes.
    uploadPdf: (file) => {
        const formData = new FormData();

        formData.append("file", file);

        return request("/notes/pdf", {
            method: "POST",
            body: formData,
        });
    },

    getPdfJob: (jobId) => request(`/notes/pdf/jobs/${jobId}`),

    listPdfJobs: (limit) =>
        request("/notes/pdf/jobs" + (limit ? `?limit=${encodeURIComponent(limit)}` : "")),
};
