# GitGuard

> **Automated GitHub repository security checks powered by a GitHub App, Next.js 14, Firebase, and Upstash Redis.**

GitGuard installs as a GitHub App on your organization or personal account, listens to webhook events, and runs configurable security checks on every push and pull request.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router, TypeScript) |
| Styling | Tailwind CSS + shadcn/ui |
| GitHub integration | GitHub App (`@octokit/app`) |
| Database / Auth | Firebase (Firestore + Firebase Auth) |
| Cache / Queue | Upstash Redis (`@upstash/redis`) |
| Webhook tunnel (dev) | ngrok |

---

## Prerequisites

- **Node.js** ≥ 18.17
- **npm** ≥ 9
- **ngrok** account + CLI ([https://ngrok.com/download](https://ngrok.com/download))
- A **GitHub App** registered on GitHub ([instructions below](#1-create-the-github-app))
- A **Firebase project** with Firestore enabled
- An **Upstash Redis** database

---

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/gitguard.git
cd gitguard
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in every value. See the [Environment Variables](#environment-variables) section below for details on each key.

### 3. Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **GitHub App name**: `GitGuard (dev)` (must be globally unique)
   - **Homepage URL**: `http://localhost:3000`
   - **Webhook URL**: Leave blank for now — you'll add the ngrok URL in the next step.
   - **Webhook secret**: Generate one with `openssl rand -hex 32` and copy it to `GITHUB_WEBHOOK_SECRET`.
3. Set the required **permissions**:
   - Repository → Contents: Read
   - Repository → Pull requests: Read & Write
   - Repository → Checks: Read & Write
4. Subscribe to **events**: `Push`, `Pull request`, `Check run`.
5. Click **Create GitHub App**.
6. On the App settings page, copy the **App ID** → `GITHUB_APP_ID`.
7. Under **Private keys**, click **Generate a private key** → download the `.pem` file.
8. Convert to a single-line env var:
   ```bash
   awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' private-key.pem
   ```
   Paste the output as the value of `GITHUB_APP_PRIVATE_KEY` in `.env.local`.

### 4. Start ngrok tunnel

In a separate terminal, expose your local dev server:

```bash
# Free plan — ephemeral URL (changes on restart)
ngrok http 3000

# Paid plan — static domain (recommended)
ngrok http --domain=your-static-domain.ngrok-free.app 3000
```

Copy the **Forwarding** URL (e.g., `https://abc123.ngrok-free.app`).

### 5. Update the webhook URL in GitHub

1. Go back to your GitHub App settings.
2. Set **Webhook URL** to:
   ```
   https://abc123.ngrok-free.app/api/webhooks/github
   ```
3. Save changes.

### 6. Update `NEXT_PUBLIC_APP_URL`

Set this in `.env.local` to your ngrok URL so OAuth redirects and webhook callbacks are correct:

```env
NEXT_PUBLIC_APP_URL=https://abc123.ngrok-free.app
```

### 7. Start the dev server

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

All variables are listed in [`.env.example`](.env.example). Below is a summary:

| Variable | Required | Description |
|---|---|---|
| `GITHUB_APP_ID` | ✅ | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | RSA private key PEM (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | ✅ | Secret for validating webhook payloads |
| `GITHUB_OAUTH_CLIENT_ID` | Optional | For GitHub OAuth login |
| `GITHUB_OAUTH_CLIENT_SECRET` | Optional | For GitHub OAuth login |
| `NEXT_PUBLIC_FIREBASE_*` | ✅ | Firebase client-side config (safe to expose) |
| `FIREBASE_PROJECT_ID` | ✅ | Firebase Admin — project ID |
| `FIREBASE_CLIENT_EMAIL` | ✅ | Firebase Admin — service account email |
| `FIREBASE_PRIVATE_KEY` | ✅ | Firebase Admin — service account private key |
| `UPSTASH_REDIS_URL` | ✅ | Upstash REST URL (includes auth token) |
| `UPSTASH_REDIS_TOKEN` | ✅ | Upstash Redis auth token |
| `NEXT_PUBLIC_APP_URL` | ✅ | Public URL of the app (ngrok URL in dev) |

---

## Project Structure

```
gitguard/
├── app/
│   ├── (dashboard)/          # Route group — auth-protected UI
│   │   ├── layout.tsx        # Shared sidebar + topbar layout
│   │   └── page.tsx          # Dashboard home
│   ├── api/
│   │   └── webhooks/
│   │       └── github/
│   │           └── route.ts  # GitHub webhook handler (POST)
│   ├── layout.tsx            # Root layout
│   └── page.tsx              # Marketing / landing page
├── lib/
│   ├── github.ts             # GitHub App client utilities
│   ├── firebase.ts           # Firebase client SDK
│   ├── firebase-admin.ts     # Firebase Admin SDK (server-only)
│   ├── redis.ts              # Upstash Redis client
│   └── utils.ts              # Shared helpers (cn, formatRelativeTime, …)
├── components/               # shadcn/ui + custom components (add here)
├── .env.example              # Environment variable template
├── next.config.mjs
├── tailwind.config.ts
└── tsconfig.json
```

---

## Installing shadcn/ui

After running `npm install`, initialize shadcn/ui:

```bash
npx shadcn-ui@latest init
```

Then add components as needed:

```bash
npx shadcn-ui@latest add button card badge table
```

---

## Installing remaining dependencies

```bash
# GitHub App authentication
npm install @octokit/app @octokit/rest

# Firebase (client + admin)
npm install firebase firebase-admin

# Upstash Redis
npm install @upstash/redis

# shadcn/ui peer dependencies
npm install clsx tailwind-merge class-variance-authority lucide-react
```

---

## Webhook Debugging

The ngrok web interface at [http://localhost:4040](http://localhost:4040) shows all incoming webhook requests and lets you **replay** them — very useful for iterating on event handlers without re-triggering real GitHub events.

---

## Testing the Webhook Locally

Once everything is running, install the GitHub App on a test repository. Then trigger an event (e.g., push a commit). You should see:

1. The webhook delivery logged in the ngrok dashboard.
2. A `[webhook] Received event="push"` log line in your terminal.
3. A `200 OK` response returned to GitHub.

---

## Deployment (Railway / Vercel)

### Architecture
- **Web App (Vercel or Railway)**: Serves Next.js App Router, Dashboard, and Webhook Receiver at `/api/webhooks/github`. On `push` or `pull_request`, it validates signatures and enqueues `{ installationId, repo, sha, diffUrl }` into the `github-events` BullMQ queue.
- **Worker (Railway Service)**: Runs the BullMQ consumer via `worker.ts`. It pulls jobs off the queue, acquires the installation Octokit client, and fetches the diff via compare or PR-files API.

### 1. Web Service (Next.js)
- Build command: `npm run build`
- Start command: `npm run start`

### 2. Worker Service (Railway)
Create an additional service in your Railway project connected to the same repository:
- Build command: `npm run build` (or leave default)
- Start command: `npm run worker`
- Set the same environment variables (including `UPSTASH_REDIS_URL`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`).

---

## License

MIT
