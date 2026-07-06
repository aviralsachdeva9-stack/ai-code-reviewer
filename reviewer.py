#!/usr/bin/env python3
"""
reviewer.py — Standalone AI Code Review CLI
===========================================
Runs inside GitHub Actions. Reads PR context from environment variables,
fetches changed files via the GitHub REST API, analyses them with CodeBERT
and regex pattern detection, then posts a rich Markdown review comment on
the Pull Request.

Environment Variables (all injected by the GitHub Actions workflow):
  GITHUB_TOKEN       — Personal access token / Actions-provided token
  GITHUB_REPOSITORY  — "owner/repo" (e.g. "acme/my-app")
  PR_NUMBER          — Pull request number (integer as string)
  PR_HEAD_SHA        — Head commit SHA of the PR
"""

import os
import re
import sys
import base64
from typing import List, Optional, Dict, Any

import requests

# ─── Try to load the trained CodeBERT model ───────────────────────────────────
try:
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    import torch

    MODEL_PATH = "./my_trained_codebert"
    print(f"⏳ Loading CodeBERT model from {MODEL_PATH} …")
    _tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    _model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)
    _model.eval()
    _model_loaded = True
    print("✅ CodeBERT model loaded successfully")
except Exception as exc:
    print(f"⚠️  Could not load trained model: {exc}")
    print("   Running in DEMO mode — pattern-based detection only.")
    _tokenizer = None
    _model = None
    _model_loaded = False

# ─── Security / quality patterns (regex, description, severity, category) ─────
LINE_PATTERNS = [
    # ── Critical security ──────────────────────────────────────────────────────
    (r'eval\s*\(',
     'Dangerous use of `eval()` — executes arbitrary code, severe injection risk.',
     'high', 'security'),

    (r'\bexec\s*\(',
     '`exec()` can execute arbitrary shell commands — never use with untrusted input.',
     'high', 'security'),

    (r'os\.system\s*\(',
     '`os.system()` enables command injection — use `subprocess.run()` with a list and `shell=False`.',
     'high', 'security'),

    (r'subprocess\.(call|run|Popen)\s*\(.*shell\s*=\s*True',
     '`subprocess` with `shell=True` enables shell injection — pass arguments as a list instead.',
     'high', 'security'),

    (r'pickle\.loads?\s*\(',
     '`pickle.loads()` can execute arbitrary code on deserialization — use JSON or `msgpack` instead.',
     'high', 'security'),

    (r'(password|passwd|pwd)\s*=\s*["\'][^"\']{4,}["\']',
     'Hardcoded password detected in source — use environment variables or a secrets manager.',
     'high', 'security'),

    (r'(secret|api_key|apikey|auth_token|access_token)\s*=\s*["\'][^"\']{6,}["\']',
     'Hardcoded secret / API key in source code — store secrets in `.env` or a vault.',
     'high', 'security'),

    (r'(WHERE|AND|OR)\s+[\w\"\']+\s*=\s*["\']?\s*\+\s*',
     'Potential SQL injection via string concatenation — use parameterised queries.',
     'high', 'security'),

    (r'SELECT\s+\*\s+FROM',
     '`SELECT *` exposes all columns including sensitive fields — specify only required columns.',
     'medium', 'security'),

    (r'innerHTML\s*=',
     '`innerHTML` assignment can lead to XSS — use `textContent` or sanitise input first.',
     'medium', 'security'),

    (r'dangerouslySetInnerHTML',
     '`dangerouslySetInnerHTML` bypasses React XSS protection — ensure content is fully sanitised.',
     'medium', 'security'),

    (r'console\.log\s*\(.*\b(password|secret|token|key|auth)\b',
     'Sensitive data is being logged to the console — remove before production.',
     'medium', 'security'),

    (r'Math\.random\s*\(\)',
     '`Math.random()` is not cryptographically secure — use `crypto.randomBytes()` for security purposes.',
     'low', 'security'),

    # ── Logic / reliability ────────────────────────────────────────────────────
    (r'catch\s*\(\s*\w*\s*\)\s*\{\s*\}',
     'Empty `catch` block silently swallows errors — at minimum log the error.',
     'medium', 'reliability'),

    (r'^\s*except\s*:\s*$',
     'Bare `except:` catches *all* exceptions including `SystemExit` — be specific.',
     'medium', 'reliability'),

    (r'==\s*null\b',
     'Use strict equality `=== null` to avoid unintended type coercion.',
     'low', 'logic'),

    # ── Code smell ────────────────────────────────────────────────────────────
    (r'#\s*(TODO|FIXME|HACK|XXX)\b',
     'Unresolved tech-debt marker — should be tracked or resolved before merging.',
     'low', 'smell'),

    (r'//\s*(TODO|FIXME|HACK|XXX)\b',
     'Unresolved tech-debt marker — should be tracked or resolved before merging.',
     'low', 'smell'),

    (r'setTimeout\s*\([^,]+,\s*0\s*\)',
     '`setTimeout(fn, 0)` is an anti-pattern — use `queueMicrotask()` or `Promise.resolve()` instead.',
     'low', 'smell'),
]

# File extensions considered as source code
CODE_EXTENSIONS = (
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c',
    '.go', '.rb', '.php', '.cs', '.rs', '.swift', '.kt', '.vue', '.sh',
)

SEV_RANK = {'high': 3, 'medium': 2, 'low': 1, 'none': 0}


# ─── GitHub API helpers ───────────────────────────────────────────────────────

def _gh_headers(token: str) -> Dict[str, str]:
    return {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }


def _gh_get(url: str, token: str, params: Optional[Dict] = None) -> Any:
    """GET a GitHub API endpoint, raising on HTTP errors."""
    resp = requests.get(url, headers=_gh_headers(token), params=params, timeout=30)
    if not resp.ok:
        raise RuntimeError(
            f"GitHub API GET {url} → {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


def _gh_post(url: str, token: str, payload: Dict) -> Any:
    """POST to a GitHub API endpoint, raising on HTTP errors."""
    resp = requests.post(url, headers=_gh_headers(token), json=payload, timeout=30)
    if not resp.ok:
        raise RuntimeError(
            f"GitHub API POST {url} → {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


def fetch_pr_files(token: str, owner: str, repo: str, pr_number: int) -> List[Dict]:
    """Return the list of files changed in the PR (up to 100 files)."""
    url = f'https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/files'
    return _gh_get(url, token, params={'per_page': 100})


def fetch_file_content(
    token: str, owner: str, repo: str, path: str, ref: str
) -> Optional[str]:
    """
    Fetch the full UTF-8 content of a file at a given ref.
    Returns None if the file cannot be retrieved (binary, too large, etc.).
    """
    url = f'https://api.github.com/repos/{owner}/{repo}/contents/{path}'
    try:
        data = _gh_get(url, token, params={'ref': ref})
        if data.get('encoding') == 'base64':
            return base64.b64decode(data['content']).decode('utf-8', errors='replace')
    except Exception as exc:
        print(f"  ⚠️  Could not fetch {path}: {exc}")
    return None


def post_pr_comment(token: str, owner: str, repo: str, pr_number: int, body: str) -> None:
    """Post a comment on the Pull Request issue thread."""
    url = f'https://api.github.com/repos/{owner}/{repo}/issues/{pr_number}/comments'
    result = _gh_post(url, token, {'body': body})
    print(f"💬 Review comment posted: {result.get('html_url', '(no url)')}")


# ─── Analysis helpers ─────────────────────────────────────────────────────────

def is_code_file(path: str) -> bool:
    return path.lower().endswith(CODE_EXTENSIONS)


def parse_patch_changed_lines(patch: Optional[str]) -> List[int]:
    """
    Parse a GitHub unified diff patch string and return the list of
    new-file line numbers that were added or modified ('+' lines).
    """
    if not patch:
        return []
    changed: List[int] = []
    current_line = 0
    for raw in patch.split('\n'):
        hunk = re.match(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@', raw)
        if hunk:
            current_line = int(hunk.group(1))
            continue
        if raw.startswith('\\'):
            continue
        if raw.startswith('-'):
            continue
        if raw.startswith('+'):
            changed.append(current_line)
        current_line += 1
    return changed


def run_codebert_inference(code: str) -> Dict[str, Any]:
    """
    Run the trained CodeBERT model on a code snippet.
    Falls back to simple keyword heuristics when the model is not loaded.
    Returns a dict: {status, comment, severity, confidence, model_loaded}
    """
    if _model_loaded and _tokenizer and _model:
        import torch
        inputs = _tokenizer(
            code, return_tensors='pt', truncation=True, max_length=512, padding=True,
        )
        with torch.no_grad():
            logits = _model(**inputs).logits
            probs = torch.softmax(logits, dim=-1)
            prediction = torch.argmax(logits, dim=-1).item()
            confidence = probs[0][prediction].item()

        if prediction == 1:
            severity = 'high' if confidence > 0.85 else 'medium' if confidence > 0.65 else 'low'
            return {
                'status': 'issues_found',
                'comment': (
                    f'⚠️ AI detected a potential issue (confidence: {confidence:.0%}). '
                    'Review for security vulnerabilities, unsafe inputs, or logic flaws.'
                ),
                'severity': severity,
                'confidence': round(confidence, 4),
                'model_loaded': True,
            }
        return {
            'status': 'clean',
            'comment': f'✅ No significant issues detected (confidence: {confidence:.0%}).',
            'severity': 'none',
            'confidence': round(confidence, 4),
            'model_loaded': True,
        }

    # ── Demo / fallback mode ──────────────────────────────────────────────────
    issue_signals = [
        'eval(', 'exec(', 'subprocess', 'os.system', 'sql',
        'password', 'secret', 'token', 'rm -rf', 'shell=true',
        'pickle.loads', 'unsafe',
    ]
    matched = [s for s in issue_signals if s in code.lower()]
    if matched:
        return {
            'status': 'issues_found',
            'comment': (
                f'⚠️ [DEMO] Suspicious patterns detected: {", ".join(matched[:3])}. '
                'Load the trained model for accurate analysis.'
            ),
            'severity': 'medium',
            'confidence': 0.72,
            'model_loaded': False,
        }
    return {
        'status': 'clean',
        'comment': '✅ [DEMO] No obvious suspicious patterns found.',
        'severity': 'none',
        'confidence': 0.68,
        'model_loaded': False,
    }


def scan_line_patterns(
    code: str, changed_lines: Optional[List[int]] = None
) -> List[Dict[str, Any]]:
    """
    Scan source code line-by-line using LINE_PATTERNS regexes.
    If `changed_lines` is provided, only those line numbers are scanned.
    Returns a list of issue dicts.
    """
    issues: List[Dict[str, Any]] = []
    changed_set = set(changed_lines) if changed_lines else None
    for line_num, line_text in enumerate(code.split('\n'), start=1):
        if changed_set is not None and line_num not in changed_set:
            continue
        stripped = line_text.strip()
        if not stripped:
            continue
        for pattern, comment, severity, category in LINE_PATTERNS:
            if re.search(pattern, line_text, re.IGNORECASE):
                issues.append({
                    'line': line_num,
                    'comment': comment,
                    'severity': severity,
                    'category': category,
                    'snippet': stripped[:120],
                })
                break  # one issue per line maximum
    return issues


def analyse_file(
    code: str, filename: str, changed_lines: List[int]
) -> Dict[str, Any]:
    """
    Run both analysis layers on a single file and merge the results.
    Returns: {status, comment, severity, confidence, model_loaded, issues}
    """
    # Layer 1 — ML overall classification
    ml = run_codebert_inference(code[:80_000])

    # Layer 2 — Regex line-level scan (only on changed lines)
    issues = scan_line_patterns(code, changed_lines or None)

    # If patterns found issues but ML said clean, upgrade the overall status
    if issues and ml['status'] == 'clean':
        max_sev = max(issues, key=lambda i: SEV_RANK.get(i['severity'], 0))['severity']
        ml = {
            **ml,
            'status': 'issues_found',
            'comment': f'⚠️ Pattern scan found {len(issues)} issue(s). ' + ml['comment'],
            'severity': max_sev,
        }

    return {**ml, 'issues': issues, 'filename': filename}


# ─── Markdown report builder ──────────────────────────────────────────────────

def build_markdown_report(
    file_results: List[Dict[str, Any]],
    pr_number: int,
    repo: str,
) -> str:
    """
    Build the full Markdown comment string:
      1. Header (all-clear vs issues detected)
      2. Summary table  — File | Status | Severity
      3. Detailed Analysis section — per issue blocks
      4. Footer
    """
    has_issues = any(r['status'] == 'issues_found' for r in file_results)
    all_issues = []
    for r in file_results:
        for iss in r.get('issues', []):
            all_issues.append({'file': r['filename'], **iss})

    # ── Header ────────────────────────────────────────────────────────────────
    if has_issues:
        header = '## 🤖 AI Code Review — ⚠️ Issues Detected\n'
    else:
        header = '## 🤖 AI Code Review — ✅ All Clear\n'

    # ── Summary Table ─────────────────────────────────────────────────────────
    table_rows = []
    for r in file_results:
        icon = '✅' if r['status'] == 'clean' else '⚠️'
        issue_count = len(r.get('issues', []))
        detail = 'Clean' if r['status'] == 'clean' else f'Issues Found ({issue_count})'
        sev = r.get('severity', 'none')
        sev_badge = {'high': '🔴 High', 'medium': '🟡 Medium', 'low': '🔵 Low', 'none': '✅ None'}.get(sev, sev)
        table_rows.append(f'| {icon} | `{r["filename"]}` | {detail} | {sev_badge} |')

    header_rows = ['| | File | Status | Severity |', '|---|---|---|---|']
    body_rows = table_rows if table_rows else ['| - | No code files changed | - | - |']
    table = '\n'.join(header_rows + body_rows)

    # ── Detailed Analysis ─────────────────────────────────────────────────────
    detailed = ''
    if all_issues:
        detailed += '\n---\n\n### 📝 Detailed Analysis\n\n'
        for issue in all_issues:
            sev_emoji = {'high': '🔴', 'medium': '🟡', 'low': '🔵'}.get(issue['severity'], '⚠️')
            detailed += f'#### 📄 File: `{issue["file"]}`\n'
            detailed += f'{sev_emoji} **Vulnerability / Issue:** {issue.get("category", "security").title()}\n\n'
            detailed += f'**🔍 Explanation:**\n{issue["comment"]}\n\n'
            if issue.get('line'):
                detailed += f'**📍 Line No:** {issue["line"]}\n\n'
            if issue.get('snippet'):
                detailed += f'**🧩 Code Snippet:**\n```\n{issue["snippet"]}\n```\n\n'

    # ── ML model overall comment ───────────────────────────────────────────────
    ml_notes = []
    for r in file_results:
        if r.get('comment'):
            ml_notes.append(f'- `{r["filename"]}`: {r["comment"]}')

    ml_section = ''
    if ml_notes:
        ml_section = '\n---\n\n### 🧠 Model Assessment\n\n' + '\n'.join(ml_notes) + '\n'

    model_tag = 'CodeBERT (trained)' if any(
        r.get('model_loaded') for r in file_results
    ) else 'CodeBERT (demo / pattern mode)'

    code_files_count = len(file_results)

    # ── Footer ────────────────────────────────────────────────────────────────
    footer = (
        f'\n---\n'
        f'> 🔬 Analysed **{code_files_count}** file(s) using **{model_tag}** + regex pattern detection.\n'
        f'> *Automated AI review — please also request a human review.*'
    )

    return '\n'.join([header, table, ml_section, detailed, footer])


# ─── Main entrypoint ──────────────────────────────────────────────────────────

def main() -> None:
    # ── Read environment variables ────────────────────────────────────────────
    token = os.environ.get('GITHUB_TOKEN', '').strip()
    repository = os.environ.get('GITHUB_REPOSITORY', '').strip()  # "owner/repo"
    pr_number_str = os.environ.get('PR_NUMBER', '').strip()
    head_sha = os.environ.get('PR_HEAD_SHA', '').strip()

    # Validate required env vars
    missing = [k for k, v in {
        'GITHUB_TOKEN': token,
        'GITHUB_REPOSITORY': repository,
        'PR_NUMBER': pr_number_str,
    }.items() if not v]
    if missing:
        print(f'❌ Missing required environment variable(s): {", ".join(missing)}')
        sys.exit(1)

    if '/' not in repository:
        print(f'❌ GITHUB_REPOSITORY must be in "owner/repo" format, got: {repository!r}')
        sys.exit(1)

    try:
        pr_number = int(pr_number_str)
    except ValueError:
        print(f'❌ PR_NUMBER must be an integer, got: {pr_number_str!r}')
        sys.exit(1)

    owner, repo = repository.split('/', 1)
    print(f'🔔 Reviewing PR #{pr_number} in {owner}/{repo} @ {head_sha or "HEAD"}')

    # ── Fetch PR files ────────────────────────────────────────────────────────
    try:
        pr_files = fetch_pr_files(token, owner, repo, pr_number)
    except RuntimeError as exc:
        print(f'❌ Failed to fetch PR files: {exc}')
        sys.exit(1)

    code_files = [f for f in pr_files if is_code_file(f['filename']) and f.get('patch')]
    print(f'📂 {len(pr_files)} changed file(s) → {len(code_files)} code file(s) to analyse')

    if not code_files:
        print('ℹ️  No code files changed — skipping review comment.')
        sys.exit(0)

    # ── Analyse each code file ────────────────────────────────────────────────
    file_results: List[Dict[str, Any]] = []

    for pr_file in code_files:
        filename = pr_file['filename']
        patch = pr_file.get('patch', '')
        changed_lines = parse_patch_changed_lines(patch)

        # Attempt to fetch full file content; fall back to patch additions
        content = None
        if head_sha:
            content = fetch_file_content(token, owner, repo, filename, head_sha)

        if content is None:
            # Reconstruct from patch additions as fallback
            content = '\n'.join(
                line[1:]
                for line in patch.split('\n')
                if line.startswith('+') and not line.startswith('+++')
            )
            print(f'  ℹ️  Using patch fallback for {filename}')

        result = analyse_file(content, filename, changed_lines)
        file_results.append(result)

        issue_count = len(result.get('issues', []))
        print(f'  ✓ {filename} → {result["status"]} | {issue_count} line issue(s) | severity: {result["severity"]}')

    # ── Build Markdown report ─────────────────────────────────────────────────
    markdown = build_markdown_report(file_results, pr_number, repo)

    # ── Post comment to PR ────────────────────────────────────────────────────
    try:
        post_pr_comment(token, owner, repo, pr_number, markdown)
    except RuntimeError as exc:
        print(f'❌ Failed to post PR comment: {exc}')
        sys.exit(1)

    has_issues = any(r['status'] == 'issues_found' for r in file_results)
    print(f'✅ Review complete — {"⚠️ issues found" if has_issues else "all clear"}')


if __name__ == '__main__':
    main()
