/**
 * lib/stats-calculator.ts
 *
 * User stats & headline formatter module.
 */

export interface UserActivityRecord {
  id: string;
  user?: {
    profile?: {
      displayName?: string;
      email?: string;
    };
  };
}

export function formatUserHeadline(record: UserActivityRecord): string {
  const email = record.user?.profile?.email;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return "User from Unknown Domain";
  }
  const parts = email.split("@");
  const emailDomain = parts[1] || "Unknown Domain";
  return `User from ${emailDomain}`;
}
