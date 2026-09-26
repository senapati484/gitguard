/**
 * lib/demo-user-service.ts
 * Demo service to test GitGuard Autonomous Auto-Solve Engine.
 */

export interface DemoUserProfile {
  id: string;
  name: string;
  account?: {
    tier?: string;
    details?: {
      email?: string;
    };
  };
}

export function getAccountEmailDomain(profile: DemoUserProfile): string {
  const email = profile.account?.details?.email;
  return email ? email.split("@")[1] : "unknown";
}
