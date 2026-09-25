/**
 * lib/firebase.ts
 *
 * Firebase client-side SDK — singleton init.
 * Safe to import in Client Components ("use client") and browser code.
 * Never import firebase-admin or server-only modules from here.
 */
import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

/**
 * Returns the Firebase App singleton.
 * Uses getApps() guard so HMR / fast-refresh never double-initialises.
 */
function getFirebaseApp(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

/** Firebase Auth — Google sign-in, session management. */
export const firebaseAuth: Auth = getAuth(getFirebaseApp());

/** Client-side Firestore — used for real-time listeners in the browser. */
export const firebaseDb: Firestore = getFirestore(getFirebaseApp());
