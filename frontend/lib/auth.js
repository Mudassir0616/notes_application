"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, clearToken, getToken, setToken } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    // On first load, validate any stored token against the API rather than
    // trusting its contents. An expired or revoked token is discarded.
    useEffect(() => {
        if (!getToken()) {
            setLoading(false);
            return;
        }

        api.me()
            .then(setUser)
            .catch(() => clearToken())
            .finally(() => setLoading(false));
    }, []);

    const login = useCallback(async (email, password) => {
        const result = await api.login(email, password);

        setToken(result.token);
        setUser(result.user);
    }, []);

    const logout = useCallback(() => {
        clearToken();
        setUser(null);
    }, []);

    return (
        <AuthContext.Provider value={{ user, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);

    if (!context) throw new Error("useAuth must be used inside an AuthProvider");

    return context;
}

/**
 * Mirrors the server's permission rule so the UI can hide controls that would
 * fail. The server enforces this independently — this is presentation only.
 */
export function canModify(note, user) {
    if (!user) return false;

    return user.role === "ADMIN" || note.authorId === user.id;
}
