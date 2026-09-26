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
  // Defect: profile.account can be null or undefined at runtime, causing fatal crash: Cannot read properties of undefined (reading 'details')
  const account = profile.account as { details: { email?: string } };
  const email = profile.account?.details?.email;
  return email ? email.split("@")[1] : "unknown";
}
