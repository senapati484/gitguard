/**
 * lib/firebase-admin.ts
 *
 * Firebase Admin SDK initialization (server-side only).
 * Used in Route Handlers, Server Actions, and middleware.
 * NEVER import this file in client components.
 *
 * Install: npm install firebase-admin
 */

// import admin from "firebase-admin";
// import type { ServiceAccount } from "firebase-admin";

/**
 * Returns the Firebase Admin App singleton.
 * Safe to call multiple times — skips re-initialization.
 */
export function getAdminApp() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  // TODO: Uncomment after installing firebase-admin
  // if (admin.apps.length > 0) return admin.app();
  // return admin.initializeApp({
  //   credential: admin.credential.cert({ projectId, clientEmail, privateKey } as ServiceAccount),
  // });

  return { projectId, clientEmail }; // placeholder
}

/**
 * Returns a Firestore Admin instance for server-side writes.
 */
export function getAdminFirestore() {
  // const app = getAdminApp();
  // return admin.firestore(app);
  throw new Error("TODO: implement getAdminFirestore — install firebase-admin first");
}
