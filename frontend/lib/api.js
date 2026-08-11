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

async function request(path, { method = "GET", body, auth = true } = {}) {
    const headers = { "Content-Type": "application/json" };

    if (auth) {
        const token = getToken();

        if (token) headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 204) return null;

    let data = null;

    try {
        data = await res.json();
    } catch {
        // Empty body.
    }

    if (!res.ok) {
        throw new ApiError(data?.message || `Request failed (${res.status})`, res.status);
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
};
