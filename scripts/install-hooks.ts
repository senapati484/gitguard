#!/usr/bin/env tsx
/**
 * scripts/install-hooks.ts
 *
 * Automatically installs GitGuard pre-push and pre-commit hooks into .git/hooks/
 * to guarantee that any accidental credentials committed locally are intercepted,
 * auto-solved into .env.local, and sanitized before reaching GitHub!
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

function getGitRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return process.cwd();
  }
}

function installHooks() {
  const gitRoot = getGitRoot();
  const hooksDir = path.join(gitRoot, ".git", "hooks");

  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // 1. Pre-push hook
  const prePushPath = path.join(hooksDir, "pre-push");
  const prePushScript = `#!/usr/bin/env bash
# GitGuard Autonomous Pre-Push Guardrail & Auto-Solve Hook
# Intercepts outgoing commits before push. If credentials are found, auto-solves them into .env.local and sanitizes code!

echo "🛡️ GitGuard: Verifying outgoing commits for sensitive credentials..."
npx tsx scripts/gitguard-protect.ts --hook pre-push "$@"
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  # Non-zero means gitguard-protect halted the dirty push (or auto-solved and re-pushed cleanly)
  exit 1
fi

exit 0
`;

  fs.writeFileSync(prePushPath, prePushScript, { mode: 0o755 });
  try {
    fs.chmodSync(prePushPath, 0o755);
  } catch {}

  console.log(`✅ GitGuard pre-push hook installed successfully at: ${prePushPath}`);

  // 2. Pre-commit hook
  const preCommitPath = path.join(hooksDir, "pre-commit");
  const preCommitScript = `#!/usr/bin/env bash
# GitGuard Autonomous Pre-Commit Guardrail
npx tsx scripts/gitguard-protect.ts --hook pre-commit
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  exit 1
fi

exit 0
`;

  fs.writeFileSync(preCommitPath, preCommitScript, { mode: 0o755 });
  try {
    fs.chmodSync(preCommitPath, 0o755);
  } catch {}

  console.log(`✅ GitGuard pre-commit hook installed successfully at: ${preCommitPath}`);
  console.log("🛡️ GitGuard Guardrail Active: Push protection enabled!");
}

installHooks();
