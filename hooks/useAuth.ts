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
  signInWithCustomToken as firebaseSignInWithCustomToken,
  signOut as firebaseSignOut,
  GoogleAuthProvider,
  GithubAuthProvider,
  type User,
} from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase";

export const LOCAL_STORAGE_TOKEN_KEY = "gitguard_token";
export const LOCAL_STORAGE_USER_KEY = "gitguard_user";
export const LOCAL_STORAGE_UID_KEY = "gitguard_uid";

export interface StoredUserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface AuthState {
  /** The currently authenticated Firebase user, or null if not signed in. */
  user: User | null;
  /** True while the auth state is being determined on first load (max 1.5s). */
  loading: boolean;
  /** True only while an active sign-in action is in progress. */
  signingIn: boolean;
  /** Any error that occurred during sign-in. */
  error: Error | null;
  /** Triggers a Google OAuth popup, stores token in browser, and sets session cookie. */
  signInWithGoogle: () => Promise<boolean>;
  /** Triggers a GitHub OAuth popup, stores token in browser, and sets session cookie. */
  signInWithGithub: () => Promise<boolean>;
  /** Instant sign-in via Firebase custom token (bypasses Google popup restrictions). */
  signInWithAdminToken: () => Promise<boolean>;
  /** Signs out from Firebase and clears browser storage and server session cookie. */
  signOut: () => Promise<void>;
}

function persistClientSession(user: User, idToken: string) {
  try {
    if (typeof window !== "undefined") {
      localStorage.setItem(LOCAL_STORAGE_TOKEN_KEY, idToken);
      localStorage.setItem(LOCAL_STORAGE_UID_KEY, user.uid);
      const profile: StoredUserProfile = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      };
      localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(profile));
    }
  } catch {
    // LocalStorage quota or access error in private mode
  }
}

function clearClientSession() {
  try {
    if (typeof window !== "undefined") {
      localStorage.removeItem(LOCAL_STORAGE_TOKEN_KEY);
      localStorage.removeItem(LOCAL_STORAGE_UID_KEY);
      localStorage.removeItem(LOCAL_STORAGE_USER_KEY);
    }
  } catch {
    // Ignore
  }
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Subscribe to Firebase auth state with a safety timeout so buttons never freeze
  useEffect(() => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        setLoading(false);
      }
    }, 1500);

    const unsubscribe = onAuthStateChanged(
      firebaseAuth,
      async (firebaseUser) => {
        resolved = true;
        clearTimeout(timer);
        setUser(firebaseUser);
        setLoading(false);

        if (firebaseUser) {
          try {
            const token = await firebaseUser.getIdToken();
            persistClientSession(firebaseUser, token);
          } catch {
            // Ignore token refresh error
          }
        } else {
          clearClientSession();
        }
      },
      (err) => {
        resolved = true;
        clearTimeout(timer);
        setError(err);
        setLoading(false);
      }
    );

    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const exchangeAndPersistSession = useCallback(async (firebaseUser: User): Promise<boolean> => {
    const idToken = await firebaseUser.getIdToken(true);
    persistClientSession(firebaseUser, idToken);

    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || data.error || `Session creation failed: ${res.status}`);
    }

    return true;
  }, []);

  const signInWithGoogle = useCallback(async (): Promise<boolean> => {
    setError(null);
    setSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const result = await signInWithPopup(firebaseAuth, provider);
      await exchangeAndPersistSession(result.user);
      setSigningIn(false);
      return true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setSigningIn(false);
      return false;
    }
  }, [exchangeAndPersistSession]);

  const signInWithGithub = useCallback(async (): Promise<boolean> => {
    setError(null);
    setSigningIn(true);
    try {
      const provider = new GithubAuthProvider();
      provider.addScope("read:user");
      provider.addScope("user:email");
      const result = await signInWithPopup(firebaseAuth, provider);
      await exchangeAndPersistSession(result.user);
      setSigningIn(false);
      return true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setSigningIn(false);
      return false;
    }
  }, [exchangeAndPersistSession]);

  const signInWithAdminToken = useCallback(async (): Promise<boolean> => {
    setError(null);
    setSigningIn(true);
    try {
      const res = await fetch("/api/auth/custom-token", { method: "POST" });
      if (!res.ok) {
        throw new Error(`Token minting failed: ${res.status}`);
      }
      const data = await res.json();
      const result = await firebaseSignInWithCustomToken(firebaseAuth, data.customToken);
      await exchangeAndPersistSession(result.user);
      setSigningIn(false);
      return true;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setSigningIn(false);
      return false;
    }
  }, [exchangeAndPersistSession]);

  const signOut = useCallback(async () => {
    try {
      clearClientSession();
      await firebaseSignOut(firebaseAuth);
      await fetch("/api/auth/session", { method: "DELETE" });
      setUser(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  return {
    user,
    loading,
    signingIn,
    error,
    signInWithGoogle,
    signInWithGithub,
    signInWithAdminToken,
    signOut,
  };
}
