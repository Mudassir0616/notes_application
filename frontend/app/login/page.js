"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../lib/auth";

const DEMO_ACCOUNTS = [
    { email: "admin@acme.com", label: "acme / admin" },
    { email: "member@acme.com", label: "acme / member" },
    { email: "admin@globex.com", label: "globex / admin" },
    { email: "member@globex.com", label: "globex / member" },
];

const DEMO_PASSWORD = "mumBai#64";

export default function LoginPage() {
    const router = useRouter();
    const { user, loading, login } = useAuth();

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!loading && user) router.replace("/");
    }, [loading, user, router]);

    async function handleSubmit(event) {
        event.preventDefault();

        setError("");
        setSubmitting(true);

        try {
            await login(email, password);
            router.replace("/");
        } catch (err) {
            setError(err.message);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="login">
            <h1>Sign in</h1>

            <form className="stack" onSubmit={handleSubmit} style={{ marginTop: 20 }}>
                <label className="stack" style={{ gap: 4 }}>
                    <span className="meta">Email</span>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        autoComplete="username"
                        required
                    />
                </label>

                <label className="stack" style={{ gap: 4 }}>
                    <span className="meta">Password</span>
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                    />
                </label>

                {error && <p className="error">{error}</p>}

                <button type="submit" disabled={submitting}>
                    {submitting ? "Signing in…" : "Sign in"}
                </button>
            </form>

            <p className="meta" style={{ marginTop: 28 }}>
                Seeded accounts (password <code>{DEMO_PASSWORD}</code>):
            </p>

            <div className="stack" style={{ gap: 6 }}>
                {DEMO_ACCOUNTS.map((account) => (
                    <button
                        key={account.email}
                        type="button"
                        className="secondary"
                        onClick={() => {
                            setEmail(account.email);
                            setPassword(DEMO_PASSWORD);
                        }}
                    >
                        {account.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
