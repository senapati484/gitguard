#!/usr/bin/env tsx
/**
 * scripts/gitguard-protect.ts
 *
 * GitGuard Local Guardrail & Pre-Push Auto-Solve Engine.
 *
 * Purpose:
 *   Intercepts commits before they reach GitHub. If any credential, API key,
 *   token, or private secret was committed by chance, GitGuard halts direct push,
 *   AUTO-SOLVES the leak locally (extracts credential to .env.local, replaces hardcoded
 *   token in code with process.env.<VAR>, amends commit), and THEN pushes cleanly to GitHub!
 *
 * Usage:
 *   - As pre-push hook:  tsx scripts/gitguard-protect.ts --hook pre-push [remote] [url]
 *   - As pre-commit hook: tsx scripts/gitguard-protect.ts --hook pre-commit
 *   - Standalone protect: npm run guard:protect
 *   - Standalone solve:   npm run guard:solve
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";

// ── Known Secret Patterns for Instant Local Interception ──────────────────────

interface SecretRule {
  id: string;
  name: string;
  envPrefix: string;
  pattern: RegExp;
}

const BUILTIN_SECRET_RULES: SecretRule[] = [
  {
    id: "stripe-secret-key",
    name: "Stripe Secret / Restricted Key",
    envPrefix: "STRIPE_SECRET_KEY",
    pattern: /(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,99}/,
  },
  {
    id: "openai-api-key",
    name: "OpenAI API Key",
    envPrefix: "OPENAI_API_KEY",
    pattern: /sk-(?:proj-|None-)?[a-zA-Z0-9_-]{32,120}/,
  },
  {
    id: "anthropic-api-key",
    name: "Anthropic Claude API Key",
    envPrefix: "ANTHROPIC_API_KEY",
    pattern: /sk-ant-api03-[a-zA-Z0-9_-]{80,120}/,
  },
  {
    id: "gemini-api-key",
    name: "Google Gemini / Cloud API Key",
    envPrefix: "GEMINI_API_KEY",
    pattern: /AIza[0-9A-Za-z-_]{35}/,
  },
  {
    id: "github-token",
    name: "GitHub Personal Access Token",
    envPrefix: "GITHUB_TOKEN",
    pattern: /(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}|github_pat_[0-9a-zA-Z_]{82}/,
  },
  {
    id: "aws-access-key-id",
    name: "AWS Access Key ID",
    envPrefix: "AWS_ACCESS_KEY_ID",
    pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
  },
  {
    id: "database-url",
    name: "Database Connection URI with Password",
    envPrefix: "DATABASE_URL",
    pattern: /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:\s]+:[^@\s]+@[^\s"']+/,
  },
  {
    id: "slack-token",
    name: "Slack API Token",
    envPrefix: "SLACK_BOT_TOKEN",
    pattern: /xox(?:b|p|a|r)-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/,
  },
  {
    id: "private-key",
    name: "Private RSA/EC/PGP Key",
    envPrefix: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
];

interface DetectedSecret {
  file: string;
  line: number;
  secret: string;
  rule: SecretRule;
  lineContent: string;
}

// ── Git Inspection Helpers ───────────────────────────────────────────────────

function getGitRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    return process.cwd();
  }
}

function getOutgoingDiff(hookType?: string): string {
  try {
    if (hookType === "pre-commit") {
      return execSync("git diff --cached", { encoding: "utf-8" });
    }

    // Check against upstream tracking branch if available
    try {
      return execSync("git diff @{u}..HEAD", { encoding: "utf-8" });
    } catch {
      // Fallback: compare against origin/main or origin/master
      try {
        return execSync("git diff origin/main..HEAD", { encoding: "utf-8" });
      } catch {
        // Fallback: last commit diff
        return execSync("git diff HEAD~1..HEAD", { encoding: "utf-8" });
      }
    }
  } catch (err) {
    return "";
  }
}

function parseChangedFilesAndLines(diff: string): { file: string; line: number; content: string }[] {
  const results: { file: string; line: number; content: string }[] = [];
  const lines = diff.split("\n");
  let currentFile = "";
  let currentLine = 0;

  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)/);
      if (match) {
        currentLine = parseInt(match[1], 10) - 1;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLine++;
      if (currentFile && !currentFile.endsWith(".lock") && !currentFile.endsWith(".min.js")) {
        results.push({
          file: currentFile,
          line: currentLine,
          content: line.slice(1),
        });
      }
    } else if (!line.startsWith("-")) {
      currentLine++;
    }
  }

  return results;
}

// ── Gitleaks Scanning ────────────────────────────────────────────────────────

function scanWithGitleaks(gitRoot: string): DetectedSecret[] {
  const gitleaksBin = findGitleaks();
  if (!gitleaksBin) return [];

  const tempReport = path.join(gitRoot, ".git", "gitleaks-prepush-report.json");
  try {
    execSync(
      `"${gitleaksBin}" git --log-opts="@{u}..HEAD" --report-path="${tempReport}" --report-format=json`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );
  } catch (err: unknown) {
    // Gitleaks exits with code 1 when leaks are found
  }

  const detected: DetectedSecret[] = [];
  if (fs.existsSync(tempReport)) {
    try {
      const data = JSON.parse(fs.readFileSync(tempReport, "utf-8"));
      if (Array.isArray(data)) {
        for (const item of data) {
          const rule: SecretRule = {
            id: item.RuleID || "gitleaks-secret",
            name: item.Description || item.RuleID || "Exposed Secret",
            envPrefix: (item.RuleID || "SECRET_KEY").toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
            pattern: new RegExp(escapeRegex(item.Secret || item.Match)),
          };
          detected.push({
            file: item.File,
            line: item.StartLine || 1,
            secret: item.Secret || item.Match,
            rule,
            lineContent: item.Match || "",
          });
        }
      }
    } catch {
      // ignore parse error
    } finally {
      try {
        fs.unlinkSync(tempReport);
      } catch {}
    }
  }

  return detected;
}

function findGitleaks(): string | null {
  const candidates = [
    "gitleaks",
    "/opt/homebrew/bin/gitleaks",
    "/usr/local/bin/gitleaks",
    "/usr/bin/gitleaks",
  ];
  for (const bin of candidates) {
    try {
      execSync(`${bin} version`, { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Built-in Regex Scanner ───────────────────────────────────────────────────

function scanWithRegex(diff: string): DetectedSecret[] {
  const additions = parseChangedFilesAndLines(diff);
  const detected: DetectedSecret[] = [];

  for (const item of additions) {
    // Skip test files or docs that legitimately have dummy placeholders
    const lower = item.content.toLowerCase();
    const isPlaceholder =
      lower.includes("placeholder") ||
      lower.includes("your_api_key") ||
      lower.includes("example_key") ||
      lower.includes("dummy-secret") ||
      lower.includes("todo_add_key");

    if (isPlaceholder) continue;

    for (const rule of BUILTIN_SECRET_RULES) {
      const match = item.content.match(rule.pattern);
      if (match) {
        const secretVal = match[0];
        // Filter out short false positives
        if (secretVal.length < 8) continue;

        detected.push({
          file: item.file,
          line: item.line,
          secret: secretVal,
          rule,
          lineContent: item.content,
        });
      }
    }
  }

  return detected;
}

// ── Auto-Solve Engine ────────────────────────────────────────────────────────

function ensureGitIgnoreHasEnvLocal(gitRoot: string) {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, ".env*.local\n.env.local\n", "utf-8");
    return;
  }
  const content = fs.readFileSync(gitignorePath, "utf-8");
  if (!content.includes(".env.local") && !content.includes(".env*.local")) {
    fs.appendFileSync(gitignorePath, "\n# Local env files (protected by GitGuard)\n.env*.local\n.env.local\n");
  }
}

function allocateEnvVarName(existingEnv: string, baseName: string): string {
  let candidate = baseName;
  let counter = 1;
  while (new RegExp(`^${candidate}=`, "m").test(existingEnv)) {
    candidate = `${baseName}_${counter++}`;
  }
  return candidate;
}

export interface AutoSolveResult {
  file: string;
  line: number;
  envVarName: string;
  secret: string;
  replacementCode: string;
}

export function autoSolveSecret(
  gitRoot: string,
  secretFinding: DetectedSecret
): AutoSolveResult | null {
  ensureGitIgnoreHasEnvLocal(gitRoot);

  const envLocalPath = path.join(gitRoot, ".env.local");
  const existingEnv = fs.existsSync(envLocalPath)
    ? fs.readFileSync(envLocalPath, "utf-8")
    : "";

  const envVarName = allocateEnvVarName(existingEnv, secretFinding.rule.envPrefix);

  // 1. Append secret to .env.local
  const envEntry = `\n# [GitGuard Auto-Solve] Neutralized credential from ${secretFinding.file}:${secretFinding.line}\n${envVarName}="${secretFinding.secret}"\n`;
  fs.appendFileSync(envLocalPath, envEntry, "utf-8");

  // 2. Rewrite source file safely
  const filePath = path.join(gitRoot, secretFinding.file);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  let replacementExpr = `process.env.${envVarName} || ""`;
  if (ext === ".py") {
    replacementExpr = `os.environ.get("${envVarName}", "")`;
  } else if (ext === ".json") {
    replacementExpr = `"process.env.${envVarName}"`;
  }

  // Replace quoted secret with expression
  let newContent = fileContent;
  const rawSecret = secretFinding.secret;

  // Replace "secret", 'secret', `secret`
  const doubleQuoted = `"${rawSecret}"`;
  const singleQuoted = `'${rawSecret}'`;
  const backtickQuoted = `\`${rawSecret}\``;

  if (newContent.includes(doubleQuoted)) {
    newContent = newContent.replace(doubleQuoted, replacementExpr);
  } else if (newContent.includes(singleQuoted)) {
    newContent = newContent.replace(singleQuoted, replacementExpr);
  } else if (newContent.includes(backtickQuoted)) {
    newContent = newContent.replace(backtickQuoted, replacementExpr);
  } else if (newContent.includes(rawSecret)) {
    newContent = newContent.replace(rawSecret, replacementExpr);
  }

  fs.writeFileSync(filePath, newContent, "utf-8");

  return {
    file: secretFinding.file,
    line: secretFinding.line,
    envVarName,
    secret: rawSecret,
    replacementCode: replacementExpr,
  };
}

// ── Main Execution Flow ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const hookIndex = args.indexOf("--hook");
  const hookType = hookIndex !== -1 ? args[hookIndex + 1] : undefined;
  const isSolveOnly = args.includes("--solve");

  const gitRoot = getGitRoot();
  process.chdir(gitRoot);

  const diff = getOutgoingDiff(hookType);
  if (!diff || diff.trim().length === 0) {
    if (!hookType) {
      console.log("🛡️ GitGuard: No outgoing or staged commits to inspect. Working tree clean.");
    }
    process.exit(0);
  }

  // Run dual-engine detection: Gitleaks + Builtin Patterns
  const gitleaksSecrets = scanWithGitleaks(gitRoot);
  const regexSecrets = scanWithRegex(diff);

  // Merge and deduplicate findings by secret string
  const seenSecrets = new Set<string>();
  const secrets: DetectedSecret[] = [];

  for (const s of [...gitleaksSecrets, ...regexSecrets]) {
    if (!seenSecrets.has(s.secret)) {
      seenSecrets.add(s.secret);
      secrets.push(s);
    }
  }

  if (secrets.length === 0) {
    if (!hookType) {
      console.log("✅ GitGuard: All outgoing code verified. Zero credentials detected. Ready to push!");
    }
    process.exit(0);
  }

  // 🚨 SECRETS DETECTED! HALT DIRECT PUSH TO GITHUB!
  console.log("\n" + "=".repeat(68));
  console.log("🛑 🛡️ GitGuard Security Interceptor: CREDENTIAL LEAK DETECTED!");
  console.log("=".repeat(68));
  console.log(`GitGuard prevented ${secrets.length} secret(s) from being pushed to GitHub:\n`);

  for (const s of secrets) {
    const masked = s.secret.slice(0, 4) + "••••••••" + s.secret.slice(-4);
    console.log(`  • [${s.rule.name}] in ${s.file}:${s.line}`);
    console.log(`    Detected value: ${masked}`);
  }

  console.log("\n⚡ AUTOMATED AUTO-SOLVE INITIATING...");
  console.log("   1. Moving credential(s) safely into .env.local (git-ignored)");
  console.log("   2. Replacing hardcoded secret(s) with process.env.<VAR>");
  console.log("   3. Amending local commit before pushing to GitHub\n");

  const solvedResults: AutoSolveResult[] = [];
  for (const s of secrets) {
    const result = autoSolveSecret(gitRoot, s);
    if (result) {
      solvedResults.push(result);
      console.log(`   ✓ ${s.file}:${s.line} -> Extracted to .env.local as ${result.envVarName}`);
      console.log(`     Replaced with: ${result.replacementCode}`);
    }
  }

  if (solvedResults.length > 0) {
    try {
      // Stage sanitized files
      for (const res of solvedResults) {
        execSync(`git add "${res.file}"`, { stdio: "ignore" });
      }
      execSync("git add .gitignore", { stdio: "ignore" });

      if (hookType === "pre-push") {
        // In pre-push hook: amend commit locally
        execSync("git commit --amend --no-edit", { stdio: "ignore" });
        console.log("\n✅ Local commit successfully amended with sanitized code!");
        console.log("🚀 Executing secure push with sanitized commit to GitHub...\n");

        // Execute sanitized push
        const remoteName = args[hookIndex + 2] || "origin";
        try {
          execSync(`git push ${remoteName} HEAD --no-verify`, { stdio: "inherit" });
          console.log("\n🎉 Clean push to GitHub complete! Zero leaked credentials on GitHub.");
        } catch {
          console.log("\n💡 Note: Please re-run 'git push' to transmit your sanitized commit.");
        }

        // Abort the initial dirty push hook execution cleanly since we just pushed the clean commit
        process.exit(1);
      } else {
        console.log("\n✅ All credentials auto-solved and staged!");
        console.log("💡 You can now run 'git commit' or 'git commit --amend' and push securely.");
        process.exit(0);
      }
    } catch (gitErr: unknown) {
      const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
      console.error("\n❌ Notice during git amend:", msg);
      console.log("⚠️ Push halted to keep credentials safe from GitHub. Please review changes.");
      process.exit(1);
    }
  } else {
    console.error("❌ Could not auto-solve findings automatically. Push halted.");
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("gitguard-protect.ts") ||
    process.argv[1].endsWith("gitguard-protect"))
) {
  main().catch((err) => {
    console.error("Unexpected GitGuard protect error:", err);
    process.exit(1);
  });
}
