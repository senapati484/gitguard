/**
 * lib/demo-user-profile.ts
 *
 * User profile preferences service.
 * Created on feature/server-side-bug-intercept branch to test server-side auto-solve.
 */

export interface UserPreferences {
  theme?: "light" | "dark" | "system";
  notificationsEnabled?: boolean;
}

export interface UserAccount {
  id: string;
  email: string;
  profile?: {
    displayName?: string;
    settings?: UserPreferences;
  };
}

/**
 * Defect 1: Null dereference — accessing settings.theme without optional chaining.
 * If user.profile or settings is undefined, this throws a TypeError at runtime.
 */
export function getActiveTheme(user: UserAccount): string {
  return user.profile?.settings?.theme?.toLowerCase() ?? '';
}

/**
 * Defect 2: Off-by-one error — accessing the last active session.
 * sessions[sessions.length] is always undefined in JavaScript/TypeScript.
 */
export function getLatestSessionId(sessions: string[]): string {
  return sessions[sessions.length - 1];
}

/**
 * Defect 3: Unhandled promise — recordUserLogin is an async function
 * but its promise is neither awaited nor caught, risking unhandled rejections.
 */
export function onUserAuthenticated(user: UserAccount): void {
  recordUserLogin(user.id).catch((err) => { console.error(err); });
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

async function recordUserLogin(userId: string): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return Boolean(userId);
}
