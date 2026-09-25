"use client";

/**
 * hooks/useAuth.ts
 *
 * React hook that subscribes to Firebase Auth state changes and exposes
 * the current user, loading state, and sign-in / sign-out helpers.
 *
 * Only usable in Client Components ("use client").
 */
import { useEffect, useState, useCallback } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  type User,
} from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";

export interface AuthState {
  /** The currently authenticated Firebase user, or null if not signed in. */
  user: User | null;
  /** True while the auth state is being determined on first load. */
  loading: boolean;
  /** Any error that occurred during sign-in. */
  error: Error | null;
  /** Triggers a Google OAuth popup and exchanges the ID token for a session cookie. */
  signInWithGoogle: () => Promise<void>;
  /** Signs out from Firebase and clears the server-side session cookie. */
  signOut: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Subscribe to Firebase auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(
      firebaseAuth,
      (firebaseUser) => {
        setUser(firebaseUser);
        setLoading(false);
      },
      (err) => {
        setError(err);
        setLoading(false);
      }
    );
    return unsubscribe;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    setError(null);
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(firebaseAuth, provider);

      // Exchange the short-lived ID token for a long-lived session cookie
      const idToken = await result.user.getIdToken();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (!res.ok) {
        throw new Error(`Session creation failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await firebaseSignOut(firebaseAuth);
      // Clear the server-side session cookie
      await fetch("/api/auth/session", { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  return { user, loading, error, signInWithGoogle, signOut };
}
