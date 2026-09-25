/**
 * lib/firebase-admin.ts
 *
 * Firebase Admin SDK — singleton init (server-side ONLY).
 * Import only in Route Handlers, Server Components, middleware, and server actions.
 * Adding "server-only" causes a build-time error if accidentally imported in a client bundle.
 */
if (typeof window !== "undefined") {
  throw new Error(
    "Firebase Admin SDK can only be imported in server-side or worker environments."
  );
}
import * as admin from "firebase-admin";
import type { App } from "firebase-admin/app";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";

function readAdminConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "[firebase-admin] Missing env vars: FIREBASE_PROJECT_ID, " +
        "FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }
  return { projectId, clientEmail, privateKey };
}

/**
 * Returns the Firebase Admin App singleton.
 * Safe to call multiple times — skips re-init if the default app already exists.
 */
function getAdminApp(): App {
  if (admin.apps.length > 0) return admin.app();
  const { projectId, clientEmail, privateKey } = readAdminConfig();
  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

/** Firebase Admin Auth — verify ID tokens and session cookies server-side. */
export const adminAuth: Auth = admin.auth(getAdminApp());

/** Firebase Admin Firestore — server-side reads and writes. */
function getAdminDb(): Firestore {
  const db = admin.firestore(getAdminApp());
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings already configured or initialized
  }
  return db;
}

export const adminDb: Firestore = getAdminDb();
