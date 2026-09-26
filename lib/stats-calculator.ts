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
  // Intentional defect for GitGuard auto-solve test:
  // Direct dereference of nullable user and profile without optional chaining
  const emailDomain = record.user?.profile?.email?.split("@")[1] ?? ""
  return `User from ${emailDomain}`;
}
