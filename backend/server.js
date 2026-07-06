const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();

// Octokit instance (GitHub REST API client)
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
}));

// Parse JSON for /api routes (raw body kept for webhook HMAC)
app.use('/api', express.json());

// ─── MongoDB Connection ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err.message));

// ─── Schema: PR Webhook Reviews ───────────────────────────────────────────────
const ReviewSchema = new mongoose.Schema({
  prTitle: { type: String, required: true },
  repoName: { type: String, required: true },
  author: { type: String, required: true },
  prNumber: { type: Number },
  status: { type: String, enum: ['Clean', 'Issues Found'], required: true },
  comment: { type: String },
  severity: { type: String, enum: ['none', 'low', 'medium', 'high'], default: 'none' },
  category: { type: String, default: 'general' },
  filesCount: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
});
const Review = mongoose.model('Review', ReviewSchema);

// ─── Schema: Manual Repo Scans ────────────────────────────────────────────────
const ManualScanSchema = new mongoose.Schema({
  repoUrl: { type: String, required: true },
  repoName: { type: String, required: true },
  branch: { type: String, default: 'main' },
  totalFiles: { type: Number, default: 0 },
  cleanFiles: { type: Number, default: 0 },
  issueFiles: { type: Number, default: 0 },
  results: [{
    path: String,
    status: String,
    severity: { type: String, default: 'none' },
    comment: String,
    confidence: Number,
    category: { type: String, default: 'general' },
  }],
  timestamp: { type: Date, default: Date.now },
});
const ManualScan = mongoose.model('ManualScan', ManualScanSchema);

// ─── GitHub Headers ───────────────────────────────────────────────────────────
const githubHeaders = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const CODE_EXTENSIONS = [
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c',
  '.go', '.rb', '.php', '.cs', '.rs', '.swift', '.kt', '.vue', '.sh',
];

function isCodeFile(path) {
  return CODE_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext));
}

function parseGitHubUrl(url) {
  const trimmed = url.trim().replace(/\.git$/, '');

  // Full URL: https://github.com/owner/repo[/anything]
  const fullMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/);
  if (fullMatch) return { owner: fullMatch[1], repo: fullMatch[2] };

  // Short form: owner/repo
  const shortMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };

  throw new Error('Invalid input — use: owner/repo or https://github.com/owner/repo');
}

/**
 * Parse a GitHub patch string and return:
 *  - changedLines: actual new-file line numbers that were added/modified
 *  - lineRanges:   [{start,end}] ranges visible in the diff (only these can get inline comments)
 */
function parseDiff(patch) {
  if (!patch) return { changedLines: [], lineRanges: [] };
  const changedLines = [];
  const lineRanges = [];
  let currentLine = 0;
  let hunkStart = 0;

  for (const raw of patch.split('\n')) {
    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      if (hunkStart > 0) lineRanges.push({ start: hunkStart, end: currentLine - 1 });
      currentLine = parseInt(hunkMatch[1]);
      hunkStart = currentLine;
      continue;
    }
    if (raw.startsWith('\\')) continue;  // "\ No newline at end of file"
    if (raw.startsWith('-')) continue;  // deleted line
    if (raw.startsWith('+')) changedLines.push(currentLine);
    currentLine++;
  }
  if (hunkStart > 0) lineRanges.push({ start: hunkStart, end: currentLine - 1 });
  return { changedLines, lineRanges };
}


function verifyWebhookSignature(req, rawBody) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
}

// ─── 1. Webhook — Inline PR Review via Octokit ───────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhookSignature(req, req.body)) {
    console.warn('⚠️  Invalid webhook signature — rejected');
    return res.status(401).send('Unauthorized');
  }

  const payload = JSON.parse(req.body.toString());
  const { action, pull_request, repository } = payload;

  res.status(200).send('Event Received');  // GitHub needs < 10s response
  if (action !== 'opened' && action !== 'synchronize') return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const pullNumber = pull_request.number;
  const commitId = pull_request.head.sha;
  console.log(`🔔 PR #${pullNumber} "${pull_request.title}" (${action})`);

  try {
    // Step 1: Get all changed files
    const { data: prFiles } = await octokit.rest.pulls.listFiles({
      owner, repo, pull_number: pullNumber, per_page: 100,
    });
    const codeFiles = prFiles.filter(f => isCodeFile(f.filename) && f.patch);
    console.log(`📂 ${prFiles.length} changed files → ${codeFiles.length} code files`);

    const inlineComments = [];
    const fileSummaries = [];
    const allIssues = [];   // ← collect every per-line issue for Detailed Analysis
    let hasIssues = false;
    let topSeverity = 'none';
    const SEV = { high: 3, medium: 2, low: 1, none: 0 };

    // Step 2: Analyse each code file
    for (const file of codeFiles) {
      const { changedLines, lineRanges } = parseDiff(file.patch);

      // Fetch full file content for better analysis
      let content = '';
      try {
        const { data: fd } = await octokit.rest.repos.getContent({
          owner, repo, path: file.filename, ref: commitId,
        });
        content = Buffer.from(fd.content, 'base64').toString('utf-8');
      } catch {
        // Fallback: reconstruct from patch additions
        content = file.patch
          .split('\n')
          .filter(l => l.startsWith('+') && !l.startsWith('+++'))
          .map(l => l.slice(1))
          .join('\n');
      }

      const aiRes = await axios.post('http://localhost:8000/analyze-pr-file', {
        code: content.slice(0, 80000),
        filename: file.filename,
        changed_lines: changedLines,
      });

      const { overall_status, overall_comment, severity, issues } = aiRes.data;
      if (overall_status === 'issues_found' || issues.length > 0) hasIssues = true;
      if ((SEV[severity] || 0) > (SEV[topSeverity] || 0)) topSeverity = severity;

      fileSummaries.push({ path: file.filename, status: overall_status, severity, issueCount: issues.length });
      // Attach the filename to each issue so the Detailed Analysis can reference it
      issues.forEach(iss => allIssues.push({ file: file.filename, ...iss }));
      console.log(`  ✓ ${file.filename} → ${overall_status} | ${issues.length} line issue(s)`);

      // Build inline comments only for lines within this diff
      for (const issue of issues) {
        const inDiff = lineRanges.some(r => issue.line >= r.start && issue.line <= r.end);
        if (!inDiff) continue;
        const emoji = { high: '🔴', medium: '🟡', low: '🔵' }[issue.severity] || '⚠️';
        inlineComments.push({
          path: file.filename, line: issue.line, side: 'RIGHT',
          body: [
            `${emoji} **[${issue.severity.toUpperCase()}] AI Review — ${issue.category}**`,
            '', issue.comment, '',
            '```', issue.snippet, '```',
          ].join('\n'),
        });
      }
    }

    // Step 3: Build summary body
    const header = hasIssues
      ? '## 🤖 AI Code Review — ⚠️ Issues Detected\n'
      : '## 🤖 AI Code Review — ✅ All Clear\n';

    const rows = fileSummaries.map(f => {
      const icon = f.status === 'clean' ? '✅' : '⚠️';
      const detail = f.status === 'clean' ? 'Clean' : `Issues Found (${f.issueCount})`;
      return `| ${icon} | \`${f.path}\` | ${detail} | ${f.severity} |`;
    }).join('\n');

    // Build the Detailed Analysis section
    let detailedSection = '';
    if (allIssues.length > 0) {
      detailedSection += '\n---\n\n### 📝 Detailed Analysis\n\n';
      allIssues.forEach((issue) => {
        const sevEmoji = { high: '🔴', medium: '🟡', low: '🔵' }[issue.severity] || '⚠️';
        detailedSection += `#### 📄 File: \`${issue.file}\`\n`;
        detailedSection += `${sevEmoji} **Vulnerability / Issue:** ${issue.category || issue.type || 'Security Bug'}\n\n`;
        detailedSection += `**🔍 Explanation:**\n${issue.comment || issue.description || issue.details || '_No details provided._'}\n\n`;
        if (issue.line) {
          detailedSection += `**📍 Line No:** ${issue.line}\n\n`;
        }
        if (issue.snippet) {
          detailedSection += `**🧩 Code Snippet:**\n\`\`\`\n${issue.snippet}\n\`\`\`\n\n`;
        }
      });
    }

    const summaryBody = [
      header,
      '| | File | Status | Severity |', '|---|---|---|---|',
      rows || '| — | No code files changed | — | — |',
      '', '---',
      `> Analysed **${codeFiles.length}** file(s) using **CodeBERT** + pattern detection.`,
      '> *Automated AI review — please also request a human review.*',
      detailedSection,
    ].join('\n');

    // Step 4: Post formal GitHub PR Review with inline comments
    try {
      await octokit.rest.pulls.createReview({
        owner, repo, pull_number: pullNumber, commit_id: commitId,
        body: summaryBody,
        event: hasIssues ? 'REQUEST_CHANGES' : 'COMMENT',
        comments: inlineComments,
      });
      console.log(`💬 PR review posted: ${inlineComments.length} inline comment(s)`);
    } catch (reviewErr) {
      // Fallback to plain issue comment if positions are invalid
      console.warn('⚠️  createReview failed, falling back:', reviewErr.message);
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: pullNumber, body: summaryBody,
      });
    }

    // Step 5: Save to MongoDB
    await new Review({
      prTitle: pull_request.title,
      repoName: repository.full_name,
      author: pull_request.user.login,
      prNumber: pullNumber,
      status: hasIssues ? 'Issues Found' : 'Clean',
      comment: summaryBody.slice(0, 500),
      severity: topSeverity,
      category: 'security',
      filesCount: codeFiles.length,
    }).save();

    console.log(`✅ Saved PR #${pullNumber} — ${hasIssues ? 'Issues Found' : 'Clean'}`);
  } catch (error) {
    console.error('❌ Webhook pipeline error:', error.response?.data || error.message);
  }
});


// ─── 2. Stats Endpoint ────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const reviews = await Review.find().sort({ timestamp: -1 }).limit(200);
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. Summary Endpoint ──────────────────────────────────────────────────────
app.get('/api/summary', async (req, res) => {
  try {
    const [total, clean, issues] = await Promise.all([
      Review.countDocuments(),
      Review.countDocuments({ status: 'Clean' }),
      Review.countDocuments({ status: 'Issues Found' }),
    ]);
    const severityBreakdown = await Review.aggregate([
      { $group: { _id: '$severity', count: { $sum: 1 } } },
    ]);
    const topRepos = await Review.aggregate([
      { $group: { _id: '$repoName', total: { $sum: 1 }, issues: { $sum: { $cond: [{ $eq: ['$status', 'Issues Found'] }, 1, 0] } } } },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]);
    res.json({
      total, clean, issues,
      interceptRate: total > 0 ? ((issues / total) * 100).toFixed(1) : '0.0',
      severityBreakdown, topRepos,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 4. Repo File Tree ────────────────────────────────────────────────────────
app.post('/api/repo/tree', async (req, res) => {
  try {
    const { repoUrl } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

    const { owner, repo } = parseGitHubUrl(repoUrl);

    // Get default branch
    const repoInfo = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: githubHeaders }
    );
    const branch = repoInfo.data.default_branch;

    // Fetch recursive file tree
    const { data } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers: githubHeaders }
    );

    const files = data.tree
      .filter(item => item.type === 'blob')
      .map(item => ({
        path: item.path,
        sha: item.sha,
        size: item.size,
        isCode: isCodeFile(item.path),
      }));

    console.log(`📂 Tree loaded: ${owner}/${repo} — ${files.length} files (${files.filter(f => f.isCode).length} code files)`);
    res.json({ owner, repo, branch, files, truncated: data.truncated || false });
  } catch (err) {
    console.error('❌ Repo tree error:', err.response?.data?.message || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── 5. Analyze Single File ───────────────────────────────────────────────────
app.post('/api/repo/analyze-file', async (req, res) => {
  try {
    const { owner, repo, path } = req.body;
    if (!owner || !repo || !path) {
      return res.status(400).json({ error: 'owner, repo, and path are required' });
    }

    // Fetch raw file from GitHub
    const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
    const { data: fileData } = await axios.get(fileUrl, { headers: githubHeaders });

    if (fileData.encoding !== 'base64') {
      return res.status(400).json({ error: 'Binary or unsupported file encoding' });
    }

    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
    const truncated = content.length > 50000;
    const codeToAnalyze = truncated ? content.slice(0, 50000) : content;

    // Send to FastAPI / CodeBERT
    const aiResponse = await axios.post('http://localhost:8000/analyze', { code: codeToAnalyze });

    // Return first 120 lines as preview so the frontend can render the code
    const allLines = content.split('\n');
    const previewLines = allLines.slice(0, 120);
    const contentTruncated = allLines.length > 120;

    console.log(`🔍 Analyzed: ${path} → ${aiResponse.data.status}`);
    res.json({
      path,
      fileSize: fileData.size,
      linesCount: allLines.length,
      truncated,
      contentPreview: previewLines.join('\n'),
      contentPreviewTruncated: contentTruncated,
      ...aiResponse.data,
    });
  } catch (err) {
    console.error('❌ File analysis error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.response?.data?.message || err.message });
  }
});

// ─── 6. Batch Scan Entire Repo ────────────────────────────────────────────────
app.post('/api/scan-repo', async (req, res) => {
  try {
    const { repoUrl } = req.body;
    if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

    const { owner, repo } = parseGitHubUrl(repoUrl);

    // Get tree
    const repoInfo = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers: githubHeaders }
    );
    const branch = repoInfo.data.default_branch;

    const { data } = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      { headers: githubHeaders }
    );

    // Cap at 40 code files to avoid overloading local AI server
    const codeFiles = data.tree
      .filter(item => item.type === 'blob' && isCodeFile(item.path))
      .slice(0, 40);

    console.log(`🚀 Starting batch scan: ${codeFiles.length} code files in ${owner}/${repo}`);

    const results = [];
    for (const file of codeFiles) {
      try {
        const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(file.path)}`;
        const { data: fileData } = await axios.get(fileUrl, { headers: githubHeaders });
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const codeToAnalyze = content.length > 50000 ? content.slice(0, 50000) : content;

        const aiRes = await axios.post('http://localhost:8000/analyze', { code: codeToAnalyze });
        results.push({ path: file.path, ...aiRes.data });
        console.log(`  ✓ ${file.path} → ${aiRes.data.status}`);
      } catch (fileErr) {
        console.error(`  ✗ ${file.path}: ${fileErr.message}`);
        results.push({
          path: file.path,
          status: 'error',
          comment: `Analysis failed: ${fileErr.message}`,
          severity: 'none',
          confidence: 0,
          category: 'general',
        });
      }
    }

    const cleanFiles = results.filter(r => r.status === 'clean').length;
    const issueFiles = results.filter(r => r.status === 'issues_found').length;

    // Save aggregate scan to ManualScan collection
    const scan = new ManualScan({
      repoUrl,
      repoName: `${owner}/${repo}`,
      branch,
      totalFiles: results.length,
      cleanFiles,
      issueFiles,
      results,
    });
    await scan.save();

    // Also push each file result into Review collection for dashboard stats
    const reviewDocs = results
      .filter(r => r.status !== 'error')
      .map(r => ({
        prTitle: `[Scan] ${r.path}`,
        repoName: `${owner}/${repo}`,
        author: 'manual-scan',
        status: r.status === 'issues_found' ? 'Issues Found' : 'Clean',
        comment: r.comment,
        severity: r.severity || 'none',
        category: r.category || 'general',
        filesCount: 1,
      }));
    if (reviewDocs.length > 0) await Review.insertMany(reviewDocs);

    console.log(`✅ Scan complete: ${cleanFiles} clean, ${issueFiles} issues in ${owner}/${repo}`);

    res.json({
      scanId: scan._id,
      repoName: `${owner}/${repo}`,
      branch,
      totalFiles: results.length,
      cleanFiles,
      issueFiles,
      results,
    });
  } catch (err) {
    console.error('❌ Scan error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── 7. Past Scans History ────────────────────────────────────────────────────
app.get('/api/scans', async (req, res) => {
  try {
    const scans = await ManualScan.find()
      .sort({ timestamp: -1 })
      .limit(20)
      .select('-results'); // exclude heavy results array in list view
    res.json(scans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 8. Health Check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ai-code-reviewer-backend', timestamp: new Date().toISOString() });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));

// Testing the new lhr tunnel

function testLogin(username) {
  // AI should catch this SQL injection vulnerability
  let query = "SELECT * FROM users WHERE user = '" + username + "'";
  return execute(query);
}

// fuck you