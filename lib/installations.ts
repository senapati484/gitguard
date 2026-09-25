import { FieldValue, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";

/**
 * lib/installations.ts
 *
 * Helper to fetch installations associated with a user uid.
 * Handles auto-claiming active GitHub App installations in local / single-tenant setups
 * when an installation was created via webhook before the user signed in.
 */
export async function getUserInstallationDocs(
  uid: string
): Promise<QueryDocumentSnapshot[]> {
  if (!uid) return [];

  // 1. First attempt: Find installations explicitly linked to this admin uid
  const primarySnap = await adminDb
    .collection("installations")
    .where("adminUids", "array-contains", uid)
    .limit(25)
    .get();

  if (!primarySnap.empty) {
    return primarySnap.docs.filter((d) => d.data().setupAction !== "deleted");
  }

  // 2. Fallback: If 0 installations linked, check for active unassigned installations
  // (e.g. GitHub sent installation.created webhook, but user hadn't visited /api/setup yet)
  const allInstallsSnap = await adminDb
    .collection("installations")
    .limit(25)
    .get();

  const activeDocs = allInstallsSnap.docs.filter((doc) => {
    const data = doc.data();
    return (
      data.setupAction !== "deleted" &&
      !doc.id.startsWith("test-team-install") &&
      !doc.id.startsWith("marketplace_")
    );
  });

  if (activeDocs.length > 0) {
    // Automatically link this logged-in admin's uid to the active installation(s)
    for (const doc of activeDocs) {
      const data = doc.data();
      const admins: string[] = Array.isArray(data.adminUids) ? data.adminUids : [];
      if (!admins.includes(uid)) {
        await doc.ref.set(
          {
            adminUids: FieldValue.arrayUnion(uid),
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      }
    }

    // Re-fetch now that uid is linked
    const updatedSnap = await adminDb
      .collection("installations")
      .where("adminUids", "array-contains", uid)
      .limit(25)
      .get();

    return updatedSnap.docs.filter((d) => d.data().setupAction !== "deleted");
  }

  return [];
}
