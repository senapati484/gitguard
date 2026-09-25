"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard",
    label: "Overview",
    exact: true,
    icon: (
      <svg
        className="w-4 h-4 shrink-0"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
        />
      </svg>
    ),
  },
  {
    href: "/dashboard/pricing",
    label: "Plans & Pricing",
    icon: (
      <svg
        className="w-4 h-4 shrink-0"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z"
        />
      </svg>
    ),
  },
  {
    href: "/dashboard/team-settings",
    label: "Team Policy & Audit",
    icon: (
      <svg
        className="w-4 h-4 shrink-0"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
        />
      </svg>
    ),
  },
  {
    href: "/dashboard/settings",
    label: "Alert Settings",
    icon: (
      <svg
        className="w-4 h-4 shrink-0"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
        />
      </svg>
    ),
  },
  {
    href: "/install",
    label: "Install",
    icon: (
      <svg
        className="w-4 h-4 shrink-0"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 4.5v15m7.5-7.5h-15"
        />
      </svg>
    ),
  },
];

export function DashboardSidebarNav() {
  const pathname = usePathname() || "";

  return (
    <nav className="flex-1 space-y-1 p-3">
      {NAV_ITEMS.map((item) => {
        const isActive = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900",
              isActive
                ? "bg-slate-900 text-white font-semibold shadow-sm"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-medium",
            ].join(" ")}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
