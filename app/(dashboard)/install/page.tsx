import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";

export const metadata: Metadata = {
  title: "Install GitGuard | GitGuard",
  description: "Install the GitGuard GitHub App on your repositories.",
};

/**
 * The GitHub App slug from your App's settings page.
 * e.g. https://github.com/apps/gitguard-dev/installations/new
 * Set NEXT_PUBLIC_GITHUB_APP_SLUG in .env.local to customise.
 */
const APP_SLUG =
  process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? "gitguard-dev";

const GITHUB_APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

/**
 * app/(dashboard)/install/page.tsx  →  /install
 *
 * Prompts authenticated users to install the GitHub App on their account
 * or organisation. After install, GitHub redirects to /api/setup with
 * installation_id in the query string.
 *
 * Unauthenticated users are bounced to /login.
 */
export default async function InstallPage() {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
      <div className="max-w-md space-y-6 text-center">
        {/* Icon */}
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
          <svg
            aria-hidden="true"
            className="h-9 w-9 text-primary-foreground"
            fill="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
            />
          </svg>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">
            Install GitGuard
          </h1>
          <p className="text-muted-foreground">
            Grant GitGuard access to your repositories so it can run automated
            security checks on every push and pull request.
          </p>
        </div>

        {/* Permission highlights */}
        <ul className="space-y-2 rounded-lg border border-border bg-muted/50 p-4 text-left text-sm">
          {[
            { icon: "✓", text: "Read repository contents and metadata" },
            { icon: "✓", text: "Read and write pull request checks" },
            { icon: "✓", text: "Receive push and pull request webhooks" },
          ].map(({ icon, text }) => (
            <li key={text} className="flex items-center gap-2">
              <span className="font-semibold text-primary">{icon}</span>
              <span className="text-muted-foreground">{text}</span>
            </li>
          ))}
        </ul>

        <a
          href={GITHUB_APP_INSTALL_URL}
          className={[
            "inline-flex w-full items-center justify-center gap-2 rounded-lg",
            "bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground",
            "shadow-sm transition-colors hover:bg-primary/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
        >
          {/* GitHub mark */}
          <svg
            aria-hidden="true"
            className="h-5 w-5"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"
            />
          </svg>
          Install on GitHub
        </a>

        <p className="text-xs text-muted-foreground">
          You&apos;ll be redirected to GitHub to choose which repositories to
          grant access to.
        </p>
      </div>
    </div>
  );
}
