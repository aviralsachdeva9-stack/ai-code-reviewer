# api.py — FastAPI + CodeBERT analysis microservice  v2.0
import re
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch
from datetime import datetime

app = FastAPI(
    title="AI Code Reviewer — CodeBERT API",
    description="Automated code analysis using a fine-tuned CodeBERT model to detect security vulnerabilities, logic flaws, and code smells.",
    version="2.0.0",
)

# ─── CORS ─────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5000",
        "http://localhost:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ─── In-memory metrics ────────────────────────────────────────────────────────
_metrics = {
    "total_analyzed": 0,
    "clean_count": 0,
    "issues_count": 0,
    "started_at": datetime.utcnow().isoformat(),
}

# ─── Model loading ────────────────────────────────────────────────────────────
print("⏳ Loading trained CodeBERT model...")
MODEL_PATH = "./my_trained_codebert"
try:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)
    model.eval()
    _model_loaded = True
    print("✅ Model loaded successfully")
except Exception as e:
    print(f"⚠️  Model not found at {MODEL_PATH}: {e}")
    print("   Running in DEMO mode — returning mock predictions")
    tokenizer = None
    model = None
    _model_loaded = False

# ─── Security / quality patterns for line-level detection ────────────────────
# Format: (regex_pattern, human_comment, severity, category)
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

# ─── Schemas ─────────────────────────────────────────────────────────────────
class CodeSnippet(BaseModel):
    code: str

class AnalysisResult(BaseModel):
    status: str        # "clean" | "issues_found"
    comment: str
    severity: str      # "none" | "low" | "medium" | "high"
    category: str      # "security" | "reliability" | "logic" | "smell" | "general"
    confidence: float  # 0.0 – 1.0
    model_loaded: bool

class PRFileRequest(BaseModel):
    code: str
    filename: str = "unknown"
    changed_lines: Optional[List[int]] = None  # actual new-file line numbers that changed

# ─── Core inference helper ────────────────────────────────────────────────────
def _run_inference(code: str) -> AnalysisResult:
    """Run CodeBERT inference (or demo fallback). Called by both /analyze and /analyze-pr-file."""
    code_lower = code.lower()

    if _model_loaded and tokenizer and model:
        inputs = tokenizer(
            code,
            return_tensors="pt",
            truncation=True,
            max_length=512,
            padding=True,
        )
        with torch.no_grad():
            outputs = model(**inputs)
            logits = outputs.logits
            probabilities = torch.softmax(logits, dim=-1)
            prediction = torch.argmax(logits, dim=-1).item()
            confidence = probabilities[0][prediction].item()

        if prediction == 1:
            _metrics["issues_count"] += 1
            severity = "high" if confidence > 0.85 else "medium" if confidence > 0.65 else "low"
            return AnalysisResult(
                status="issues_found",
                comment=(
                    f"⚠️ AI detected a potential issue (confidence: {confidence:.0%}). "
                    "Review for security vulnerabilities, unsafe inputs, or logic flaws."
                ),
                severity=severity,
                category="security",
                confidence=round(confidence, 4),
                model_loaded=True,
            )
        else:
            _metrics["clean_count"] += 1
            return AnalysisResult(
                status="clean",
                comment=f"✅ No significant issues detected (confidence: {confidence:.0%}). Code looks safe to merge.",
                severity="none",
                category="general",
                confidence=round(confidence, 4),
                model_loaded=True,
            )

    # ── Demo / fallback mode ──────────────────────────────────────────────────
    issue_signals = [
        "eval(", "exec(", "subprocess", "os.system", "sql",
        "password", "secret", "token", "rm -rf", "shell=true",
        "pickle.loads", "unsafe",
    ]
    matched = [s for s in issue_signals if s in code_lower]

    if matched:
        _metrics["issues_count"] += 1
        return AnalysisResult(
            status="issues_found",
            comment=(
                f"⚠️ [DEMO MODE] Suspicious patterns detected: {', '.join(matched[:3])}. "
                "Load the trained model for accurate analysis."
            ),
            severity="medium",
            category="security",
            confidence=0.72,
            model_loaded=False,
        )

    _metrics["clean_count"] += 1
    return AnalysisResult(
        status="clean",
        comment="✅ [DEMO MODE] No obvious suspicious patterns found. Load the trained model for deep analysis.",
        severity="none",
        category="general",
        confidence=0.68,
        model_loaded=False,
    )


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check — confirms the service is running and whether the model is loaded."""
    return {
        "status": "ok",
        "model_loaded": _model_loaded,
        "service": "codebert-analysis",
        "version": "2.0.0",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/metrics")
async def metrics():
    """Return in-memory counters for this process session."""
    return {**_metrics, "model_loaded": _model_loaded}


@app.post("/analyze", response_model=AnalysisResult)
async def analyze_code(snippet: CodeSnippet):
    """
    Analyze a code snippet / diff for vulnerabilities, logic flaws, and code smells.
    Returns overall ML classification result with severity and category.
    """
    if not snippet.code.strip():
        raise HTTPException(status_code=400, detail="code field must not be empty")

    _metrics["total_analyzed"] += 1
    return _run_inference(snippet.code)


@app.post("/analyze-pr-file")
async def analyze_pr_file(request: PRFileRequest):
    """
    Analyze a single PR file with TWO layers:
      1. Overall CodeBERT ML classification (clean / issues_found)
      2. Regex pattern scan → exact line numbers + specific issue descriptions

    Returns structured JSON ready for GitHub inline PR review comments via Octokit.
    """
    if not request.code.strip():
        raise HTTPException(status_code=400, detail="code field must not be empty")

    _metrics["total_analyzed"] += 1

    # Layer 1 — ML overall assessment
    overall = _run_inference(request.code)

    # Layer 2 — Pattern-based line-level detection
    issues = []
    lines = request.code.split('\n')
    changed_set = set(request.changed_lines) if request.changed_lines else None

    for line_num, line_text in enumerate(lines, start=1):
        # If caller provided changed_lines, only scan those (avoids flagging untouched code)
        if changed_set is not None and line_num not in changed_set:
            continue

        stripped = line_text.strip()
        if not stripped:
            continue  # skip blanks

        for pattern, comment, severity, category in LINE_PATTERNS:
            if re.search(pattern, line_text, re.IGNORECASE):
                issues.append({
                    "line": line_num,
                    "comment": comment,
                    "severity": severity,
                    "category": category,
                    "snippet": stripped[:120],
                })
                break  # one issue per line max

    # If patterns found issues but ML said clean → upgrade overall status
    if issues and overall.status == "clean":
        max_sev = max(
            issues,
            key=lambda i: {"high": 3, "medium": 2, "low": 1}.get(i["severity"], 0)
        )["severity"]
        overall = AnalysisResult(
            status="issues_found",
            comment=f"⚠️ Pattern scan found {len(issues)} issue(s). " + overall.comment,
            severity=max_sev,
            category="security",
            confidence=overall.confidence,
            model_loaded=overall.model_loaded,
        )

    return {
        "filename": request.filename,
        "overall_status": overall.status,
        "overall_comment": overall.comment,
        "severity": overall.severity,
        "confidence": overall.confidence,
        "model_loaded": overall.model_loaded,
        "issues": issues,
    }

# Run: uvicorn api:app --reload --port 8000