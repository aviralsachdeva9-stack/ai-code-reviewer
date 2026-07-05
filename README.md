# AI Code Reviewer

An automated, AI-driven code review pipeline that integrates directly with GitHub. When a developer opens a Pull Request, a Node.js webhook triggers a full analysis pipeline — real code is fetched, analyzed by a fine-tuned CodeBERT model, and results are automatically posted back to the PR as a comment and logged to MongoDB. A React + Tailwind dashboard provides real-time analytics.

---

## Architecture

```
GitHub PR  ──▶  Node.js Webhook (port 5000)
                  │
                  ├─▶  GitHub API  (fetch real diff)
                  │
                  ├─▶  FastAPI + CodeBERT (port 8000)  ──▶  Analysis Result
                  │
                  ├─▶  GitHub API  (post AI comment on PR)
                  │
                  └─▶  MongoDB Atlas  (log review data)
                            │
                            └─▶  React Dashboard (port 3000)
```

---

## Stack

| Layer | Technology |
|---|---|
| Webhook server | Node.js + Express |
| AI microservice | Python FastAPI + CodeBERT (HuggingFace Transformers) |
| Database | MongoDB Atlas (via Mongoose) |
| Dashboard | React 18 + Vite + Tailwind CSS + Recharts |
| GitHub integration | GitHub REST API v3 |

---

## Setup

### Prerequisites
- Node.js 18+
- Python 3.10+
- MongoDB Atlas account
- GitHub Personal Access Token (`repo` + `write:discussion` scopes)

### 1. Clone & Install

```bash
# Python deps
pip install -r requirements.txt

# Node.js backend
cd backend && npm install

# React frontend
cd frontend && npm install
```

### 2. Configure Environment

Edit `backend/.env`:
```env
MONGO_URI=your_mongodb_connection_string
GITHUB_TOKEN=your_github_pat
WEBHOOK_SECRET=your_webhook_secret
PORT=5000
```

### 3. Train / Load the Model

Place your trained model in `./my_trained_codebert/`. To train from scratch:
```bash
python train.py   # (if training script exists)
```

### 4. Run All Services

**Terminal 1 — FastAPI:**
```bash
python -m uvicorn api:app --reload --port 8000
```

**Terminal 2 — Node.js webhook:**
```bash
cd backend && node server.js
```

**Terminal 3 — React dashboard:**
```bash
cd frontend && npm run dev
```

Dashboard opens at `http://localhost:3000`

---

## GitHub Webhook Setup

1. Go to your GitHub repo → **Settings → Webhooks → Add webhook**
2. **Payload URL**: `https://your-server.com/webhook` (use [ngrok](https://ngrok.com/) for local dev)
3. **Content type**: `application/json`
4. **Secret**: same value as `WEBHOOK_SECRET` in `.env`
5. **Events**: Select `Pull requests`

### Local testing with ngrok:
```bash
ngrok http 5000
# Copy the HTTPS URL and paste into GitHub webhook settings
```

---

## API Endpoints

### FastAPI (port 8000)
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Service health check |
| GET | `/metrics` | In-memory analysis counters |
| POST | `/analyze` | Analyze a code snippet |

### Node.js (port 5000)
| Method | Path | Description |
|---|---|---|
| POST | `/webhook` | GitHub webhook receiver |
| GET | `/api/stats` | All reviews (newest first) |
| GET | `/api/summary` | Aggregated metrics |
| GET | `/health` | Service health check |

---

## Dashboard Features

- **KPI Cards**: Total PRs, Safe Merges, Vulnerabilities Caught, Intercept Rate
- **Code Health Pie Chart**: Safe vs Vulnerable split
- **PR Activity Timeline**: 14-day line chart
- **Repository Breakdown**: Bar chart per repo
- **System Status**: Live health check for all 3 services
- **Recent Reviews Table**: Full log with AI comments and severity
- **Auto-refresh**: Updates every 30 seconds
