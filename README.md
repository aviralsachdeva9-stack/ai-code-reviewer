# 🤖 AI Code Reviewer

> An automated, AI-driven code review pipeline that integrates directly with GitHub Pull Requests. When a developer opens or updates a PR, a real-time pipeline fetches the diff, runs it through a fine-tuned **CodeBERT** model, and posts a detailed vulnerability report — with inline comments and a full Detailed Analysis — directly on the PR. Every review is logged to **MongoDB** and visualized in a live **React dashboard**.

---

## 📐 Architecture

```
GitHub PR (opened / synchronized)
        │
        ▼
Node.js Webhook Server  (port 5000)
        │
        ├──▶  GitHub API  ──── fetch real diff & file content
        │
        ├──▶  FastAPI + CodeBERT  (port 8000)  ──▶  per-line issue detection
        │
        ├──▶  GitHub API  ──── post PR Review
        │         ├─ Summary table  (File | Status | Severity)
        │         ├─ Inline comments  (per changed line)
        │         └─ 📝 Detailed Analysis  (vuln type, explanation, line no, snippet)
        │
        └──▶  MongoDB Atlas  ──── log review
                    │
                    └──▶  React Dashboard  (port 5173)
```

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Webhook / API server | Node.js 18 + Express |
| AI microservice | Python 3.10 · FastAPI · CodeBERT (HuggingFace Transformers) |
| GitHub integration | `@octokit/rest` · GitHub REST API v3 |
| Database | MongoDB Atlas · Mongoose |
| Dashboard | React 18 · Vite · Tailwind CSS · Recharts |
| Tunnel (local dev) | `localhost.run` / ngrok |

---

## 📁 Project Structure

```
ai-code-reviewer/
├── api.py                    # FastAPI + CodeBERT AI microservice
├── requirements.txt          # Python dependencies
├── demo-auth.js              # Demo file with intentional bugs (for testing)
├── backend/
│   ├── server.js             # Node.js Express webhook & REST API
│   ├── package.json
│   └── .env                  # 🔒 Secret config (never commit this)
└── frontend/
    ├── src/                  # React dashboard source
    ├── app.jsx
    ├── index.html
    └── vite.config.js
```

---

## ⚙️ First-Time Setup

### Prerequisites
- **Node.js** v18+
- **Python** 3.10+
- **MongoDB Atlas** account (free tier works)
- **GitHub Personal Access Token** — scopes: `repo` + `pull_requests` + `write:discussion`

---

### Step 1 — Clone & Install Dependencies

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/ai-code-reviewer.git
cd ai-code-reviewer

# Python dependencies (AI microservice)
pip install -r requirements.txt

# Node.js backend
cd backend
npm install
cd ..

# React frontend
cd frontend
npm install
cd ..
```

---

### Step 2 — Configure Environment Variables

Create / edit `backend/.env`:

```env
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/ai-reviewer
GITHUB_TOKEN=ghp_your_personal_access_token_here
WEBHOOK_SECRET=your_random_webhook_secret_string
PORT=5000
```

> ⚠️ **Never commit `.env` to Git.** It is already listed in `.gitignore`.

---

### Step 3 — Ensure Model is Available

The CodeBERT model should be in `./my_trained_codebert/`.
If training from scratch (optional):

```bash
python train.py
```

---

## 🚀 Running the Project (All 3 Servers)

You need **3 separate terminal windows** open simultaneously.

### Terminal 1 — Python AI Microservice (FastAPI + CodeBERT)

```bash
# Run from the ROOT of the project (ai-code-reviewer/)
python -m uvicorn api:app --reload --port 8000
```

✅ Runs at: `http://localhost:8000`

---

### Terminal 2 — Node.js Webhook Server

```bash
# Run from the backend/ folder
cd backend
node server.js
```

✅ Runs at: `http://localhost:5000`

---

### Terminal 3 — React Dashboard (Vite)

```bash
# Run from the frontend/ folder
cd frontend
npm run dev
```

✅ Runs at: `http://localhost:5173`

---

## 🔄 How to Restart After Closing This IDE

Follow these steps **every time you reopen** the project in VS Code / any IDE:

### Step-by-step Restart Guide

**1. Open 3 terminals** in your IDE
- VS Code: `Ctrl + Shift + `` ` to open terminal, then click `+` to add more

**2. Terminal 1 — Start FastAPI:**

```bash
cd "C:\Users\Aviral Sachdeva\OneDrive\Desktop\ai-code-reviewer"
python -m uvicorn api:app --reload --port 8000
```

Wait until you see:
```
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

**3. Terminal 2 — Start Node.js server:**

```bash
cd "C:\Users\Aviral Sachdeva\OneDrive\Desktop\ai-code-reviewer\backend"
node server.js
```

Wait until you see:
```
✅ MongoDB Connected
🚀 Backend running on port 5000
```

**4. Terminal 3 — Start React dashboard:**

```bash
cd "C:\Users\Aviral Sachdeva\OneDrive\Desktop\ai-code-reviewer\frontend"
npm run dev
```

Wait until you see:
```
  VITE v5.x.x  ready in XXX ms
  ➜  Local:   http://localhost:5173/
```

**5. (Optional) Start tunnel for GitHub webhook:**

```bash
ssh -R 80:localhost:5000 nokey@localhost.run
```

Copy the generated HTTPS URL (e.g. `https://xxxx.lhr.life`) and paste it as the GitHub webhook Payload URL.

---

### ⚡ Quick Restart Cheatsheet (Copy-Paste Ready)

> **Start order matters:** FastAPI first → then Node.js → then React

| Terminal | What | Command |
|---|---|---|
| 1 | AI server (FastAPI) | `python -m uvicorn api:app --reload --port 8000` |
| 2 | Backend (Node.js) | `cd backend && node server.js` |
| 3 | Frontend (React) | `cd frontend && npm run dev` |
| 4 (optional) | Webhook Tunnel | `ssh -R 80:localhost:5000 nokey@localhost.run` |

---

## 🔗 GitHub Webhook Setup

1. Go to your GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: your tunnel HTTPS URL + `/webhook`
   e.g. `https://xxxx.lhr.life/webhook`
3. **Content type**: `application/json`
4. **Secret**: same value as `WEBHOOK_SECRET` in `backend/.env`
5. **Events**: ✅ Select `Pull requests` only

### Testing locally (alternative to localhost.run):

```bash
# Using ngrok
ngrok http 5000
# Copy the HTTPS forwarding URL → paste into GitHub webhook settings
```

---

## 📡 API Reference

### FastAPI AI Service — `http://localhost:8000`

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/metrics` | In-memory analysis counters |
| POST | `/analyze` | Analyze a full code file |
| POST | `/analyze-pr-file` | Analyze PR diff with line-level issues |

### Node.js Backend — `http://localhost:5000`

| Method | Endpoint | Description |
|---|---|---|
| POST | `/webhook` | GitHub PR webhook receiver |
| GET | `/api/stats` | All PR reviews (newest first) |
| GET | `/api/summary` | Aggregated metrics & KPIs |
| POST | `/api/repo/tree` | Fetch file tree for a GitHub repo |
| POST | `/api/repo/analyze-file` | Analyze a single file from any repo |
| POST | `/api/scan-repo` | Batch scan entire repo (up to 40 files) |
| GET | `/api/scans` | History of past manual scans |
| GET | `/health` | Backend health check |

---

## 📊 Dashboard Features

Open `http://localhost:5173` after starting the React server.

| Feature | Description |
|---|---|
| **KPI Cards** | Total PRs, Safe Merges, Vulnerabilities Caught, Intercept Rate |
| **Code Health Chart** | Pie chart — Safe vs Vulnerable |
| **PR Activity Timeline** | 14-day line chart of review activity |
| **Repository Breakdown** | Bar chart per repo |
| **System Status** | Live health checks for all 3 services |
| **Recent Reviews Table** | Full log with AI comments, severity, category |
| **Manual Repo Scanner** | Paste any GitHub repo URL → full batch scan |
| **Auto-refresh** | Dashboard updates every 30 seconds |

---

## 🛡️ What the AI Detects

The CodeBERT model + pattern detection engine flags:

- 🔴 **SQL Injection** — string concatenation in queries
- 🔴 **Hardcoded Secrets** — API keys, tokens, passwords in code
- 🟡 **Command Injection** — unsanitized shell commands
- 🟡 **Path Traversal** — unvalidated file paths
- 🔵 **Insecure Randomness** — weak random number usage
- 🔵 **Broad Exception Handling** — catching all errors silently
- And more via CodeBERT semantic analysis

---

## 🔍 PR Comment Format

Every analyzed PR gets a structured GitHub comment:

```
## 🤖 AI Code Review — ⚠️ Issues Detected

| | File | Status | Severity |
|---|---|---|---|
| ⚠️ | `src/auth.js` | Issues Found (2) | high |
| ✅ | `src/utils.js` | Clean | none |

---
> Analysed 2 file(s) using CodeBERT + pattern detection.

---

### 📝 Detailed Analysis

#### 📄 File: `src/auth.js`
🔴 Vulnerability / Issue: sql_injection

🔍 Explanation:
Direct string concatenation used in SQL query — vulnerable to injection.

📍 Line No: 14

🧩 Code Snippet:
let query = "SELECT * FROM users WHERE email = '" + email + "'";
```

---

## 🐛 Troubleshooting

| Problem | Fix |
|---|---|
| `MongoDB Connection Error` | Check `MONGO_URI` in `backend/.env` — ensure your IP is whitelisted in MongoDB Atlas |
| `GITHUB_TOKEN invalid` | Regenerate PAT with correct scopes (`repo`, `pull_requests`) |
| Port 8000 refused | Start FastAPI (Terminal 1) first — Node.js calls it internally |
| Webhook not triggering | Ensure tunnel is running and URL is updated in GitHub webhook settings |
| `node_modules` missing | Run `npm install` inside `backend/` and `frontend/` separately |
| Python `ModuleNotFoundError` | Run `pip install -r requirements.txt` again |
| Dashboard shows no data | Check all 3 servers are running; open browser console for errors |

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add some feature'`
4. Push and open a Pull Request — the AI reviewer will automatically analyze your code! 🎉

---

## 📄 License

MIT License — feel free to use, modify, and distribute.

---

*Built with ❤️ using CodeBERT, Node.js, FastAPI, React, and MongoDB.*
