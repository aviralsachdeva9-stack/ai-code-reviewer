#!/usr/bin/env python3
"""
reviewer.py — Groq LLaMA 3 Autonomous Code Review Agent
=========================================================
Runs inside GitHub Actions. Reads PR context from environment variables,
fetches changed files via the GitHub REST API, sends the code to the
Groq LLaMA 3 model for expert analysis, then posts the Markdown response
as a single comment on the Pull Request.

Required Environment Variables (injected by the GitHub Actions workflow):
  GITHUB_TOKEN       — Actions-provided token (pull-requests: write)
  GITHUB_REPOSITORY  — "owner/repo"  (e.g. "acme/my-app")
  PR_NUMBER          — Pull request number as a string
  PR_HEAD_SHA        — Head commit SHA of the PR
  GROQ_API_KEY       — Your Groq API key (set in repo Secrets)
"""

import os
import sys
import base64
from typing import Optional

import requests
from groq import Groq, APIError, APIConnectionError, RateLimitError

# ─── Constants ────────────────────────────────────────────────────────────────

GROQ_MODEL = "llama3-70b-8192"

# File extensions the agent will analyse (skip binary / config / lock files)
CODE_EXTENSIONS = (
    ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".cpp", ".c",
    ".go", ".rb", ".php", ".cs", ".rs", ".swift", ".kt", ".vue", ".sh",
    ".yaml", ".yml", ".tf", ".html", ".css",
)

# Hard cap on characters sent to the model per file (≈ 6 k tokens safety margin)
MAX_CHARS_PER_FILE = 12_000

# Hard cap on total characters across all files in a single Groq request
MAX_TOTAL_CHARS = 40_000

SYSTEM_PROMPT = """You are an expert autonomous AI code reviewer with deep knowledge of \
security, software engineering best practices, and common vulnerability patterns.

Analyze the following code files extracted from a Pull Request. Your job is to:
1. Identify security vulnerabilities (e.g. injection, hardcoded secrets, XSS, SSRF, insecure deserialization).
2. Spot logical flaws, race conditions, off-by-one errors, and incorrect assumptions.
3. Flag bad practices (e.g. empty catch blocks, bare except clauses, use of eval/exec, TODO markers left in prod code).
4. Comment on code quality issues: missing error handling, overly complex functions, naming problems.

**Response format — you MUST follow this exactly:**

## 🤖 AI Code Review — [Overall Verdict: ✅ All Clear OR ⚠️ Issues Detected]

### 📊 Summary Table

| File | Status | Severity | Issues Found |
|------|--------|----------|--------------|
| `filename.py` | ✅ Clean / ⚠️ Issues | 🔴 High / 🟡 Medium / 🔵 Low / ✅ None | Brief summary |

---

### 📝 Detailed Analysis

For each issue found, use this block:

#### 📄 `<filename>`

🔴/🟡/🔵 **[SEVERITY] Issue Type** (e.g. Security, Logic Flaw, Bad Practice)

**📍 Line:** `<line number or range>`

**🔍 Explanation:** Clear explanation of why this is a problem and what the risk is.

**🧩 Code Snippet:**
```
<the problematic code>
```

**✅ Recommended Fix:** Concrete, actionable suggestion to fix the issue.

---

> 🔬 Analysed by **LLaMA 3 70B** via Groq API.
> *Automated AI review — please also request a human review for critical changes.*
"""


# ─── GitHub API helpers ───────────────────────────────────────────────────────

def _gh_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _gh_get(url: str, token: str, params: Optional[dict] = None) -> any:
    """GET a GitHub API endpoint. Raises RuntimeError on non-2xx responses."""
    try:
        resp = requests.get(
            url, headers=_gh_headers(token), params=params, timeout=30
        )
    except requests.exceptions.RequestException as exc:
        raise RuntimeError(f"Network error fetching {url}: {exc}") from exc

    if not resp.ok:
        raise RuntimeError(
            f"GitHub API GET {url} → HTTP {resp.status_code}: {resp.text[:400]}"
        )
    return resp.json()


def _gh_post(url: str, token: str, payload: dict) -> any:
    """POST to a GitHub API endpoint. Raises RuntimeError on non-2xx responses."""
    try:
        resp = requests.post(
            url, headers=_gh_headers(token), json=payload, timeout=30
        )
    except requests.exceptions.RequestException as exc:
        raise RuntimeError(f"Network error posting to {url}: {exc}") from exc

    if not resp.ok:
        raise RuntimeError(
            f"GitHub API POST {url} → HTTP {resp.status_code}: {resp.text[:400]}"
        )
    return resp.json()


def fetch_pr_files(token: str, owner: str, repo: str, pr_number: int) -> list:
    """Return the list of files changed in the PR (up to 100)."""
    url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/files"
    return _gh_get(url, token, params={"per_page": 100})


def fetch_file_content(
    token: str, owner: str, repo: str, path: str, ref: str
) -> Optional[str]:
    """
    Fetch the full UTF-8 content of a file at a given commit ref.
    Returns None on any error (binary file, file too large, API failure, etc.).
    """
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}"
    try:
        data = _gh_get(url, token, params={"ref": ref})
        if data.get("encoding") == "base64":
            raw = base64.b64decode(data["content"])
            return raw.decode("utf-8", errors="replace")
    except RuntimeError as exc:
        print(f"  ⚠️  Could not fetch {path}: {exc}")
    return None


def post_pr_comment(
    token: str, owner: str, repo: str, pr_number: int, body: str
) -> None:
    """Post a comment on the Pull Request timeline."""
    url = f"https://api.github.com/repos/{owner}/{repo}/issues/{pr_number}/comments"
    result = _gh_post(url, token, {"body": body})
    print(f"  💬 Comment posted: {result.get('html_url', '(no url)')}")


# ─── Groq helpers ────────────────────────────────────────────────────────────

def build_user_message(file_blocks: list[dict]) -> str:
    """
    Assemble the user message from a list of {filename, content} dicts.
    Each file is clearly delimited so the model can reference filenames.
    """
    parts = []
    total = 0
    for fb in file_blocks:
        header = f"\n\n### FILE: `{fb['filename']}`\n```\n"
        footer = "\n```"
        body = fb["content"][:MAX_CHARS_PER_FILE]
        if len(fb["content"]) > MAX_CHARS_PER_FILE:
            body += f"\n... [truncated — {len(fb['content'])} chars total]"
        block = header + body + footer
        if total + len(block) > MAX_TOTAL_CHARS:
            parts.append(
                f"\n\n### FILE: `{fb['filename']}`\n"
                "_[Omitted — total context limit reached. Please review manually.]_"
            )
            break
        parts.append(block)
        total += len(block)

    return (
        f"Please review the following {len(file_blocks)} changed file(s) "
        f"from this Pull Request:\n"
        + "".join(parts)
    )


def call_groq(client: Groq, user_message: str) -> str:
    """
    Call the Groq chat completion API and return the model's response text.
    Handles rate-limit and connection errors with informative messages.
    """
    try:
        completion = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_message},
            ],
            temperature=0.2,      # low temperature → deterministic, factual review
            max_tokens=4096,
            top_p=0.9,
        )
        return completion.choices[0].message.content.strip()

    except RateLimitError as exc:
        raise RuntimeError(
            f"Groq rate limit hit — try again in a moment. Detail: {exc}"
        ) from exc
    except APIConnectionError as exc:
        raise RuntimeError(
            f"Could not connect to Groq API: {exc}"
        ) from exc
    except APIError as exc:
        raise RuntimeError(
            f"Groq API error (HTTP {exc.status_code}): {exc.message}"
        ) from exc


# ─── Helpers ─────────────────────────────────────────────────────────────────

def is_code_file(path: str) -> bool:
    return path.lower().endswith(CODE_EXTENSIONS)


def patch_to_text(patch: str) -> str:
    """Extract only the added/context lines from a unified diff patch."""
    lines = []
    for line in patch.split("\n"):
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+") or line.startswith(" "):
            lines.append(line[1:])  # strip the leading +/space
    return "\n".join(lines)


# ─── Main entrypoint ─────────────────────────────────────────────────────────

def main() -> None:
    # ── 1. Read & validate environment variables ──────────────────────────────
    token       = os.environ.get("GITHUB_TOKEN", "").strip()
    repository  = os.environ.get("GITHUB_REPOSITORY", "").strip()  # "owner/repo"
    pr_num_str  = os.environ.get("PR_NUMBER", "").strip()
    head_sha    = os.environ.get("PR_HEAD_SHA", "").strip()
    groq_key    = os.environ.get("GROQ_API_KEY", "").strip()

    missing = [
        k for k, v in {
            "GITHUB_TOKEN":      token,
            "GITHUB_REPOSITORY": repository,
            "PR_NUMBER":         pr_num_str,
            "GROQ_API_KEY":      groq_key,
        }.items() if not v
    ]
    if missing:
        print(f"❌ Missing required environment variable(s): {', '.join(missing)}")
        sys.exit(1)

    if "/" not in repository:
        print(f"❌ GITHUB_REPOSITORY must be 'owner/repo', got: {repository!r}")
        sys.exit(1)

    try:
        pr_number = int(pr_num_str)
    except ValueError:
        print(f"❌ PR_NUMBER must be an integer, got: {pr_num_str!r}")
        sys.exit(1)

    owner, repo = repository.split("/", 1)
    print(f"🔔 Reviewing PR #{pr_number} in {owner}/{repo} @ {head_sha or 'HEAD'}")

    # ── 2. Fetch changed files from GitHub ───────────────────────────────────
    try:
        pr_files = fetch_pr_files(token, owner, repo, pr_number)
    except RuntimeError as exc:
        print(f"❌ Failed to fetch PR file list: {exc}")
        sys.exit(1)

    code_files = [
        f for f in pr_files
        if is_code_file(f["filename"]) and (f.get("patch") or f.get("status") != "removed")
    ]
    print(f"📂 {len(pr_files)} changed file(s) → {len(code_files)} code file(s) to review")

    if not code_files:
        print("ℹ️  No reviewable code files changed — skipping.")
        sys.exit(0)

    # ── 3. Build file blocks for the Groq prompt ──────────────────────────────
    file_blocks = []
    for pr_file in code_files:
        filename = pr_file["filename"]
        patch    = pr_file.get("patch", "")

        # Prefer full file content; fall back to patch-extracted text
        content = None
        if head_sha:
            content = fetch_file_content(token, owner, repo, filename, head_sha)

        if not content:
            if patch:
                content = patch_to_text(patch)
                print(f"  ℹ️  {filename}: using patch diff (full file unavailable)")
            else:
                print(f"  ⚠️  {filename}: no content available — skipping")
                continue

        file_blocks.append({"filename": filename, "content": content})
        print(f"  ✓  {filename} ({len(content):,} chars)")

    if not file_blocks:
        print("⚠️  No file content could be retrieved — aborting.")
        sys.exit(1)

    # ── 4. Send to Groq and get the AI review ─────────────────────────────────
    print(f"\n🧠 Sending {len(file_blocks)} file(s) to Groq ({GROQ_MODEL}) …")
    client = Groq(api_key=groq_key)
    user_message = build_user_message(file_blocks)

    try:
        review_markdown = call_groq(client, user_message)
    except RuntimeError as exc:
        print(f"❌ Groq API call failed: {exc}")
        sys.exit(1)

    print(f"✅ Received {len(review_markdown):,} chars of review from Groq")

    # ── 5. Post the review as a PR comment ────────────────────────────────────
    print("\n📤 Posting review comment to PR …")
    try:
        post_pr_comment(token, owner, repo, pr_number, review_markdown)
    except RuntimeError as exc:
        print(f"❌ Failed to post PR comment: {exc}")
        sys.exit(1)

    print("🎉 Done — AI review posted successfully.")


if __name__ == "__main__":
    main()
