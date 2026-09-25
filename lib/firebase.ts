/**
 * lib/firebase.ts
 *
 * Firebase client-side SDK initialization (browser-safe).
 * Used for auth, Firestore reads, and real-time listeners.
 *
 * Install: npm install firebase
 */

// import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
// import { getAuth } from "firebase/auth";
// import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/**
 * Returns the Firebase App singleton (initializes if not yet done).
 * Safe to call multiple times — re-uses the existing app instance.
 */
export function getFirebaseApp() {
  // TODO: Uncomment after installing firebase
  // if (getApps().length > 0) return getApp();
  // return initializeApp(firebaseConfig);
  return firebaseConfig; // placeholder
}

// export const auth = getAuth(getFirebaseApp() as FirebaseApp);
// export const db = getFirestore(getFirebaseApp() as FirebaseApp);
