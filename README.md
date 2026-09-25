# GitGuard 🛡️

> **Next-Generation Autonomous GitHub Security & Code Correctness Gatekeeper.**  
> Powered by LangGraph Multi-Agent Orchestration, Semgrep OWASP SAST, Gitleaks, Deep Exploitability AI Reasoning, Firebase, and BullMQ.

GitGuard installs as a native GitHub App on your repositories, listens to pull requests and push webhooks, and orchestrates an autonomous ensemble of specialized security and correctness agents in parallel before synthesizing an authoritative **PASS / WARN / BLOCK** verdict.

---

## 🌟 Architecture Overview

```
                      [GitHub Webhook: PR / Push]
                                  │
                                  ▼
                   [Next.js 14 Webhook Handler]
                     (Instant HTTP 200 ACK <50ms)
                                  │
                                  ▼
                   [BullMQ / Upstash Redis Queue]
                        (Job: github-events)
                                  │
                                  ▼
                 [Background Worker (Railway Service)]
              (Fetches Installation Token & PR Diff)
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │    LangGraph Multi-Agent Pipeline    │
               │                                      │
               │   [START]                            │
               │      ├──> [SecretAgent] (Gitleaks)   │
               │      ├──> [BugAgent] (Diff Hunks)    │
               │      └──> [SecurityAgent] (Semgrep)  │
               │             │                        │
               │             ▼                        │
               │      [Join Barrier]                  │
               │             │                        │
               │    (Collision on file:line?)         │
               │        ├── YES ──> [DialogueNode]    │
               │        └── NO  ───────────┐          │
               │                           ▼          │
               │               [OrchestratorNode]     │
               │              (Verdict & Synthesis)   │
               └──────────────────┬───────────────────┘
                                  │
                                  ▼
                    [GitHub Pull Request Actions]
             ├── 🛡️ Check Run: GitGuard / Secrets
             ├── 🐛 Check Run: GitGuard / Bugs
             ├── 🔒 Check Run: GitGuard / Security (Exploitability)
             ├── ⚖️ Check Run: GitGuard / Orchestrator (Verdict)
             ├── 💬 Inline Annotations at exact file:line
             └── 📝 PR Review Comment with One-Click Commit Fix
```

---

## 🛠️ CLI Tools Used in GitGuard (For Mentors & Reviewers)

GitGuard pairs **industry-standard open-source security CLI tools** with **frontier AI reasoning models** (Groq LLaMA/GPT-OSS as primary, Google Gemini as fallback). Here is the full breakdown of CLI tools integrated into the pipeline:

| CLI Tool | Agent / Component | Command & Configuration Flags | Purpose & Technical Rationale |
|---|---|---|---|
| **Semgrep** (`semgrep`) | `SecurityAgent`<br>([`agents/security-agent.ts`](agents/security-agent.ts)) | `semgrep scan --config=p/owasp-top-ten --json --no-git-ignore --disable-version-check <tempDir>` | **Static Application Security Testing (SAST)**.<br>Parses syntax trees (ASTs) rather than raw regex to detect OWASP Top 10 vulnerabilities (SQLi, Command Injection, SSRF, Path Traversal, Prototype Pollution, XSS, Broken Crypto). GitGuard reconstructs diff files into an isolated workspace and runs Semgrep with the official OWASP Top 10 rule pack. |
| **Gitleaks** (`gitleaks`) | `SecretAgent`<br>([`agents/secret-agent.ts`](agents/secret-agent.ts)) | `gitleaks protect --staged --verbose --no-banner`<br>`gitleaks detect --no-git --report-format json` | **High-speed Secret & Credential Scanning**.<br>Audits git diffs for leaked secrets, API keys, private keys, JWTs, AWS credentials, and database URLs using Shannon entropy analysis and regex signatures before code is merged. |
| **Git** (`git`) | `Worker` & `SecurityAgent`<br>([`worker.ts`](worker.ts), [`security-agent.ts`](agents/security-agent.ts)) | `git init`, `git add .`, `git diff` | **Repository & Diff Workspace Management**.<br>Used to initialize isolated temporary workspaces so scanners (like Semgrep) treat reconstructed diff hunks as git-tracked files, compute commit graphs, and generate patch chunks. |
| **Node.js & npm** (`node`, `npm`, `npx`) | Web App & Worker Runtime | `npm run dev`, `npm run worker`, `npx tsx` | **Runtime & Process Orchestration**.<br>Runs the Next.js 14 web application, BullMQ queue workers, TypeScript transpilation without compile steps (`tsx`), and dependency management. |
| **npm audit / OSV** | `SecurityAgent`<br>([`agents/security-agent.ts`](agents/security-agent.ts)) | `npm audit --json`<br>OSV API (`api.osv.dev`) | **Software Composition Analysis (SCA)**.<br>Analyzes `package.json` manifest additions and dependency version bumps across PRs to identify known CVEs/GHSAs, CVSS severity, and available patch versions. |

### Installing Required CLI Tools

To run all GitGuard scanners locally:

```bash
# macOS (via Homebrew)
brew install semgrep gitleaks git

# Linux (Debian/Ubuntu)
pip install semgrep
sudo apt-get install git
# Install Gitleaks binary from GitHub Releases or Go:
# go install github.com/zricethezav/gitleaks/v8@latest
```

> **Note on Resiliency:** If `semgrep` or `gitleaks` is not installed in the execution environment, GitGuard's agents gracefully fall back to built-in AST and heuristic pattern analyzers, ensuring zero pipeline crashes.

---

## 🤖 Multi-Agent Architecture (LangGraph)

GitGuard does not rely on a single generic LLM prompt. Instead, it coordinates specialized agents using **LangGraph**:

### 1. `SecretAgent` (`agents/secret-agent.ts`)
- **Step 1**: Shells out to `gitleaks` against the diff to gather raw secret candidate hits.
- **Step 2**: Re-maps hunk line numbers back to original file line numbers.
- **Step 3**: Feeds candidates into Groq/Gemini to filter out dummy credentials, mock test tokens, and false positives.
- **Output**: Confirmed secret leaks trigger a failing GitHub Check Run (`GitGuard / Secrets`) with inline annotations.

### 2. `BugAgent` (`agents/bug-agent.ts`)
- **Step 1**: Extracts only modified code hunks (not entire files) to conserve tokens and prevent hallucination.
- **Step 2**: Scoped strictly to 4 fatal defect categories:
  1. *Null / Undefined Dereferences*
  2. *Unhandled Promises & Rejections*
  3. *Race Conditions & State Inconsistencies*
  4. *Off-by-One Boundary Errors*
- **Step 3 (One-Click Suggested Changes)**:
  - For **high-confidence findings**, BugAgent converts the defect into native **GitHub suggested changes** (```` ```suggestion ```` blocks) posted directly to the Pull Request review comments instead of plain annotations.
  - Pull request authors can inspect the green diff and commit the fix with a **single click**.
  - Lower-confidence or informational items remain as check run annotations.
- **Output**: Posts check run `GitGuard / Bugs`. Critical/high bugs block merges; minor bugs warn without blocking.

### 3. `SecurityAgent` (`agents/security-agent.ts`)
- **Step 1**: Executes `semgrep --config=p/owasp-top-ten` across diff files.
- **Step 2**: Executes dependency audit on modified manifests (`package.json`) via OSV.
- **Step 3 (The Core Innovation)**: **Real-World Exploitability Reasoning**.
  - Traditional scanners spam developers with theoretical CVEs.
  - The model evaluates **data flow taint propagation**, **sink reachability**, and **framework mitigations** (e.g. Next.js auto-escaping, ORM parameterization, schema validation).
  - Distinguishes **Confirmed Exploits** from **Theoretical/Mitigated CVEs** (`isExploitable: boolean`).
  - Only confirmed exploitable issues trigger a merge block!

### 4. `DialogueNode` (`agents/orchestrator.ts`)
- Triggered by a conditional edge in LangGraph whenever `BugAgent` and `SecurityAgent` flag the **same file and line**.
- Conducts an automated consensus dialogue between correctness and security auditors to reconcile root causes (e.g. did a null dereference or race condition create an exploitable sink?).

### 5. `CommitAgent` (`agents/commit-agent.ts`)
- Analyzes the diff along with BugAgent findings to generate a **Conventional Commit message**.
- Formats the recommendation as a GitHub Markdown `suggestion` block that pull request authors can apply with a **single click**.

### 6. `OrchestratorNode` (`agents/orchestrator.ts`)
- Synthesizes findings across all nodes into an authoritative verdict:
  - 🛑 **BLOCK**: Confirmed secrets OR confirmed exploitable critical/high defects.
  - ⚠️ **WARN**: Non-exploitable CVEs, low/medium bugs, or hardening suggestions.
  - ✅ **PASS**: Clean changeset.
- Generates a human-readable PR summary comment and completes the `GitGuard / Orchestrator` Check Run.

---

## 🛡️ `.gitguardignore` Parsing & Whitelist Auditing

GitGuard implements strict, auditable exemption controls via `.gitguardignore` at the root of monitored repositories:

- **Mandatory Reason String**: Every exemption rule **MUST** include a reason string explaining the business or technical justification:
  ```gitignore
  # Format: <glob-pattern> # reason: <why it is ignored>
  tests/fixtures/** # reason: mock test data with dummy API keys
  *.mock.ts # reason: local unit test stubs
  legacy/auth.js # reason: approved backwards compatibility fallback
  ```
- **Security Enforcement**: If a rule omits the reason string (e.g. `tests/**`), GitGuard marks it as **INVALID** and **refuses to whitelist the files**, preventing unreviewed security bypasses.
- **Dashboard Audit View**: Every time `SecretAgent` or `BugAgent` skips a finding due to a valid `.gitguardignore` rule, an audit record is logged to Firestore (`ignored_audits`) and surfaced prominently in the repository dashboard with the exact pattern and documented reason.

---

## 📊 Dashboard & Health Monitoring

- **`app/(dashboard)/dashboard/page.tsx`**:
  - Lists all installations where the signed-in user is an administrator (`adminUids`).
  - Displays per-installation 30-day composite health score (0–100, Grade A+ to F).
  - Summarizes recent review runs with color-coded verdict pills (`PASS`, `WARN`, `BLOCK`) and defect breakdowns.
  - Includes a global `.gitguardignore` audit view preview.
- **`app/(dashboard)/repo/[id]/page.tsx`**:
  - Interactive **Recharts** 30-day health-score trend line (`HealthTrendChart`) showing score trajectory over time.
  - Per-agent Check Run history (SecretAgent, BugAgent with suggested changes, SecurityAgent SAST, SEOAgent Web Vitals, Consensus Dialogue).
  - Dedicated **Dashboard Audit View** displaying all whitelisted exemptions, file/line targets, matched glob patterns, and required reasons.
- **Badges**: Public cached SVG badges via `GET /api/badge/[installationId]/[repo]`.

## ⚡ Asynchronous Architecture: Webhooks + BullMQ + Upstash

GitHub webhooks have a strict **10-second timeout**. Running multi-agent AI pipelines inline would cause webhook delivery failures.

GitGuard separates ingest from execution:
1. **Webhook Handler** (`app/api/webhooks/github/route.ts`):
   - Validates the `X-Hub-Signature-256` HMAC using `GITHUB_WEBHOOK_SECRET`.
   - Enqueues `{ installationId, repo, sha, diffUrl, pullNumber }` into the `github-events` queue on Upstash Redis via **BullMQ**.
   - Returns `200 OK` in `< 50ms`.
2. **Worker Daemon** (`worker.ts`):
   - Runs as an independent process on Railway (`npm run worker`).
   - Retrieves an authenticated GitHub installation Octokit client.
   - Downloads the git diff from GitHub's compare or PR-files API.
   - Invokes `gitGuardGraph.invoke(...)` and updates GitHub Check Runs in real time.

---

## 🔐 Authentication & Database Architecture

- **Firebase Auth (Client)**: Google Sign-In and GitHub OAuth popup authentication (`hooks/useAuth.ts`).
- **Server Session Management** (`lib/auth-session.ts`): Exchanges Firebase client ID tokens for 5-day secure, HTTP-only `__session` cookies verified server-side with Firebase Admin SDK (`checkRevoked: true`).
- **Cloud Firestore**:
  - `installations/{installation_id}`: Maps GitHub App installations to admin user UIDs.
  - `reviews/{review_id}`: Persistent audit log of all scans, agent outputs, and verdicts.
- **GitHub App Setup Flow** (`app/api/setup/route.ts`): When an admin installs GitGuard from GitHub Marketplace, GitHub redirects to `/api/setup?installation_id=...`, which binds the GitHub installation ID to the authenticated Firebase user in Firestore and redirects to `/dashboard`.

---

## 💻 Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | Next.js 14 (App Router, Server Components, Route Handlers) |
| **Agent Orchestration** | LangGraph (`@langchain/langgraph`, `@langchain/core`) |
| **Primary AI Inference** | Groq API (`openai/gpt-oss-120b`, ultra-low latency inference) |
| **Fallback AI Inference** | Google Gemini API (`gemini-2.5-flash`, high-throughput failover) |
| **SAST Security Engine** | Semgrep CLI (`p/owasp-top-ten` rule registry) |
| **Secret Detection** | Gitleaks CLI (`gitleaks protect` / `gitleaks detect`) |
| **SCA / CVE Database** | Open Source Vulnerabilities (OSV) API & `npm audit` |
| **Queue / Worker** | BullMQ + Upstash Redis (`@upstash/redis`, `ioredis`) |
| **Database & Auth** | Google Firebase (Authentication + Cloud Firestore + Firebase Admin SDK) |
| **GitHub Integration** | GitHub Apps (`@octokit/app`, `@octokit/rest`, Check Runs API) |
| **Styling** | Tailwind CSS + Lucide Icons |

---

## 🚀 Getting Started

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/senapati484/gitguard.git
cd gitguard
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Fill in the required keys in `.env.local`:

```env
# ── GitHub App ──
GITHUB_APP_ID=5070835
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
NEXT_PUBLIC_GITHUB_APP_SLUG=gitguard-io

# ── AI Inference (Groq + Gemini) ──
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-120b
GEMINI_API_KEY=AQ....
GEMINI_MODEL=gemini-2.5-flash

# ── Firebase Client (Web App) ──
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=gitguard-ff005.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=gitguard-ff005
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=gitguard-ff005.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=591306061168
NEXT_PUBLIC_FIREBASE_APP_ID=1:591306061168:web:2a964d3ccfd69d69ddcbb5
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=G-4YMECMRMKZ

# ── Firebase Admin SDK (Server) ──
FIREBASE_PROJECT_ID=gitguard-ff005
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@gitguard-ff005.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# ── Upstash Redis (BullMQ Queue) ──
UPSTASH_REDIS_URL=rediss://default:...@...upstash.io:6379
UPSTASH_REDIS_TOKEN=...
```

### 3. Run Locally

Start the web application:
```bash
npm run dev
```

In a separate terminal, start the BullMQ worker:
```bash
npm run worker
```

Expose your local server via `ngrok` or `smee.io`:
```bash
ngrok http 3000
```
Update your GitHub App's Webhook URL to: `https://<your-ngrok-url>/api/webhooks/github`.

---

## 🚢 Production Deployment (Railway)

1. **Web Service**:
   - Repository: `senapati484/gitguard`
   - Build Command: `npm run build`
   - Start Command: `npm run start`
2. **Worker Service**:
   - Repository: `senapati484/gitguard`
   - Build Command: `npm run build`
   - Start Command: `npm run worker`
   - Environment: Install `semgrep` and `gitleaks` via Dockerfile or Nixpack.

---

## 👥 Authors & Team
Built with ❤️ for GitHub security, enterprise developer experience, and autonomous AI engineering.
