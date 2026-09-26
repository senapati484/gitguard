import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { DashboardShell } from "@/components/dashboard/DashboardShell";

interface DashboardLayoutProps {
  children: ReactNode;
}

/**
 * Shared layout for the (dashboard) route group.
 * Performs server-side session verification — redirects to /login if invalid.
 * Delegates responsive collapsible navigation and viewports to DashboardShell.
 */
export default async function DashboardLayout({
  children,
}: DashboardLayoutProps) {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  return <DashboardShell uid={uid}>{children}</DashboardShell>;
}
