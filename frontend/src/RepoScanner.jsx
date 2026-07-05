import React, { useState, useCallback } from 'react';
import {
  FolderOpen, Folder, FileCode2, GitBranch,
  Play, CheckCircle, XCircle, ChevronRight, ChevronDown,
  AlertTriangle, Shield, RefreshCw,
  Code, AlertCircle, Search, Loader2,
} from 'lucide-react';

// ─── Extension → color mapping ────────────────────────────────────────────────
const EXT_COLORS = {
  py: '#3b82f6', js: '#f59e0b', jsx: '#38bdf8', ts: '#60a5fa',
  tsx: '#38bdf8', java: '#f97316', cpp: '#a855f7', c: '#a855f7',
  go: '#34d399', rs: '#f97316', php: '#818cf8', rb: '#ef4444',
  cs: '#8b5cf6', kt: '#a78bfa', swift: '#f97316', vue: '#4ade80', sh: '#94a3b8',
};

function getExt(path) {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

function extColor(path) {
  return EXT_COLORS[getExt(path)] || '#64748b';
}

function extLabel(path) {
  return (getExt(path) || 'FILE').toUpperCase();
}

// ─── Build nested tree from flat file list ────────────────────────────────────
function buildFileTree(files) {
  const root = { name: '__root__', type: 'dir', path: '', children: [] };

  files.forEach(file => {
    const parts = file.path.split('/');
    let node = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let dir = node.children.find(c => c.type === 'dir' && c.name === dirName);
      if (!dir) {
        dir = { name: dirName, type: 'dir', path: parts.slice(0, i + 1).join('/'), children: [] };
        node.children.push(dir);
      }
      node = dir;
    }

    node.children.push({
      name: parts[parts.length - 1],
      type: 'file',
      path: file.path,
      isCode: file.isCode,
      size: file.size,
    });
  });

  // Sort: dirs first, then alphabetically
  function sortNode(n) {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(c => { if (c.type === 'dir') sortNode(c); });
  }
  sortNode(root);
  return root;
}

// ─── Single tree node ─────────────────────────────────────────────────────────
function TreeNode({ node, depth, selectedPath, onFileClick, scanMap, expanded, toggleDir }) {
  if (node.type === 'file') {
    const result = scanMap[node.path];
    const isSelected = selectedPath === node.path;
    return (
      <div
        className={`file-item${isSelected ? ' file-item-selected' : ''}${!node.isCode ? ' file-item-noncode' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 10}px` }}
        onClick={() => node.isCode && onFileClick(node)}
        title={node.isCode ? node.path : `${node.path} (not a code file)`}
      >
        <span className="file-ext-tag" style={{ color: extColor(node.path), borderColor: extColor(node.path) + '55' }}>
          {extLabel(node.path)}
        </span>
        <span className="file-name-text">{node.name}</span>
        {result && result.status !== 'error' && (
          <span className={`file-result-dot${result.status === 'clean' ? ' dot-clean' : ' dot-issue'}`} />
        )}
      </div>
    );
  }

  // Directory
  const key = node.path || node.name;
  const isOpen = expanded[key] !== false;
  const fileCt = node.children.filter(c => c.type === 'file').length;
  const dirCt  = node.children.filter(c => c.type === 'dir').length;

  return (
    <div>
      <div
        className="folder-item"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={() => toggleDir(key)}
      >
        {isOpen
          ? <ChevronDown size={11} className="text-gray-500 shrink-0" />
          : <ChevronRight size={11} className="text-gray-500 shrink-0" />}
        {isOpen
          ? <FolderOpen size={13} className="text-yellow-400/70 shrink-0" />
          : <Folder     size={13} className="text-yellow-400/40 shrink-0" />}
        <span className="folder-name">{node.name}</span>
        <span className="folder-meta">{dirCt > 0 ? `${dirCt}d · ` : ''}{fileCt}f</span>
      </div>
      {isOpen && node.children.map((child, i) => (
        <TreeNode
          key={child.path || child.name + i}
          node={child} depth={depth + 1}
          selectedPath={selectedPath} onFileClick={onFileClick}
          scanMap={scanMap} expanded={expanded} toggleDir={toggleDir}
        />
      ))}
    </div>
  );
}

// ─── Right-panel: analysis result ────────────────────────────────────────────
function AnalysisPanel({ selectedFile, analysis, analyzing, scanResult, scanning }) {
  /* ── Scanning all files ── */
  if (scanning) {
    return (
      <div className="analysis-panel analysis-center">
        <Loader2 size={34} className="spin text-lime-300 mb-4" />
        <p className="text-sm font-medium text-gray-300">Scanning all code files…</p>
        <p className="text-xs text-gray-600 mt-1">File-by-file to avoid overloading the AI server</p>
      </div>
    );
  }

  /* ── Batch scan results summary ── */
  if (scanResult) {
    const issueRate = scanResult.totalFiles > 0
      ? ((scanResult.issueFiles / scanResult.totalFiles) * 100).toFixed(1)
      : '0.0';
    return (
      <div className="analysis-panel">
        <div className="card-header mb-4">
          <h3 className="card-title"><Shield size={15} className="text-lime-300" />Scan Complete</h3>
          <span className="card-badge">Done</span>
        </div>
        <p className="text-xs text-gray-500 mb-4 font-mono">{scanResult.repoName} · {scanResult.branch}</p>

        <div className="scan-summary-grid">
          {[
            { label: 'Scanned',  val: scanResult.totalFiles,  cls: 'text-white' },
            { label: 'Clean',    val: scanResult.cleanFiles,   cls: 'text-emerald-400' },
            { label: 'Issues',   val: scanResult.issueFiles,   cls: 'text-red-400' },
            { label: 'Issue Rate', val: `${issueRate}%`,        cls: 'text-amber-400' },
          ].map(s => (
            <div key={s.label} className="scan-stat-card">
              <p className="scan-stat-label">{s.label}</p>
              <p className={`scan-stat-value ${s.cls}`}>{s.val}</p>
            </div>
          ))}
        </div>

        <div className="scan-results-list">
          {scanResult.results.map((r, i) => (
            <div key={i} className={`scan-result-item${r.status === 'issues_found' ? ' result-issue' : r.status === 'error' ? ' result-error' : ' result-clean'}`}>
              <div className="flex items-center gap-2 min-w-0">
                {r.status === 'clean'        && <CheckCircle size={12} className="text-emerald-400 shrink-0" />}
                {r.status === 'issues_found' && <XCircle     size={12} className="text-red-400 shrink-0" />}
                {r.status === 'error'        && <AlertTriangle size={12} className="text-amber-400 shrink-0" />}
                <span className="font-mono text-xs truncate" title={r.path}>{r.path}</span>
              </div>
              {r.severity && r.severity !== 'none' && (
                <span className={`severity-chip severity-${r.severity}`}>{r.severity}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── No file selected yet ── */
  if (!selectedFile) {
    return (
      <div className="analysis-panel analysis-center">
        <div className="analysis-empty-icon">
          <Code size={28} className="text-gray-600" />
        </div>
        <p className="text-sm font-medium text-gray-400 mt-4">Select a file to analyse</p>
        <p className="text-xs text-gray-600 mt-1 text-center max-w-xs">
          Click any <span className="text-lime-300">highlighted</span> file in the tree to run
          instant AI code review, or use <strong>"Scan All"</strong> for a full repo report.
        </p>
      </div>
    );
  }

  /* ── Analysing a file ── */
  if (analyzing) {
    return (
      <div className="analysis-panel analysis-center">
        <Loader2 size={26} className="spin text-lime-300 mb-3" />
        <p className="text-sm text-gray-400">Analysing <span className="text-white">{selectedFile.name}</span>…</p>
      </div>
    );
  }

  if (!analysis) return null;

  const isClean = analysis.status === 'clean';
  const isError = !!analysis.error;

  return (
    <div className="analysis-panel">
      {/* File header */}
      <div className="analysis-file-header">
        <div className="flex items-center gap-3 min-w-0">
          <div className="file-icon-badge" style={{ background: extColor(analysis.path) + '22', color: extColor(analysis.path) }}>
            <FileCode2 size={14} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">{selectedFile.name}</p>
            <p className="text-xs text-gray-500 font-mono truncate">{analysis.path}</p>
          </div>
        </div>
        {analysis.linesCount && (
          <span className="text-xs text-gray-600 shrink-0">{analysis.linesCount.toLocaleString()} lines</span>
        )}
      </div>

      {isError ? (
        <div className="analysis-error-box">
          <AlertTriangle size={15} className="text-amber-400 shrink-0" />
          <span>{analysis.error}</span>
        </div>
      ) : (
        <>
          {/* Status card */}
          <div className={`analysis-status-card ${isClean ? 'status-clean' : 'status-issue'}`}>
            <div className="flex items-center gap-3">
              {isClean
                ? <CheckCircle size={22} className="text-emerald-400 shrink-0" />
                : <XCircle     size={22} className="text-red-400 shrink-0" />}
              <div>
                <p className={`text-sm font-bold ${isClean ? 'text-emerald-400' : 'text-red-400'}`}>
                  {isClean ? 'Clean — No Issues Found' : 'Issues Detected'}
                </p>
                <p className="text-xs text-gray-400 mt-0.5 leading-snug">{analysis.comment}</p>
              </div>
            </div>
          </div>

          {/* Meta chips */}
          <div className="analysis-meta-row">
            {analysis.severity && analysis.severity !== 'none' && (
              <div className="analysis-meta-chip">
                <AlertTriangle size={11} />
                Severity: <strong className={`severity-text-${analysis.severity}`}>{analysis.severity.toUpperCase()}</strong>
              </div>
            )}
            {analysis.category && (
              <div className="analysis-meta-chip">
                <Code size={11} />
                {analysis.category}
              </div>
            )}
            {analysis.confidence !== undefined && (
              <div className="analysis-meta-chip">
                <Shield size={11} />
                {(analysis.confidence * 100).toFixed(0)}% confidence
              </div>
            )}
            {analysis.model_loaded === false && (
              <div className="analysis-meta-chip chip-demo">
                <AlertCircle size={11} />
                Demo mode
              </div>
            )}
            {analysis.truncated && (
              <div className="analysis-meta-chip chip-warn">
                <AlertTriangle size={11} />
                File truncated (50 KB limit)
              </div>
            )}
          </div>

          {/* Confidence bar */}
          {analysis.confidence !== undefined && (
            <div className="confidence-bar-wrapper">
              <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                <span>AI Confidence</span>
                <span>{(analysis.confidence * 100).toFixed(1)}%</span>
              </div>
              <div className="confidence-bar-bg">
                <div
                  className={`confidence-bar-fill ${isClean ? 'bar-clean' : 'bar-issue'}`}
                  style={{ width: `${(analysis.confidence * 100).toFixed(1)}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Code Preview ── */}
          {analysis.contentPreview && (
            <div className="code-preview-wrapper">
              <div className="code-preview-header">
                <span className="flex items-center gap-1.5">
                  <Code size={12} />
                  File Content
                </span>
                <span className="text-gray-600">
                  {analysis.contentPreviewTruncated
                    ? `First 120 of ${analysis.linesCount} lines`
                    : `${analysis.linesCount} lines`}
                </span>
              </div>
              <div className="code-preview-scroll">
                <table className="code-table">
                  <tbody>
                    {analysis.contentPreview.split('\n').map((line, i) => (
                      <tr key={i} className="code-row">
                        <td className="code-lineno">{i + 1}</td>
                        <td className="code-line">{line || ' '}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {analysis.contentPreviewTruncated && (
                  <p className="code-truncated-notice">
                    … {analysis.linesCount - 120} more lines not shown
                  </p>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────
export default function RepoScanner({ onScanComplete }) {
  const [repoUrl,     setRepoUrl]     = useState('');
  const [repoData,    setRepoData]    = useState(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError,   setTreeError]   = useState(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [analysis,     setAnalysis]     = useState(null);
  const [analyzing,    setAnalyzing]    = useState(false);

  const [scanning,    setScanning]    = useState(false);
  const [scanResult,  setScanResult]  = useState(null);

  const [expanded,   setExpanded]   = useState({});
  const [filterText, setFilterText] = useState('');

  // Build tree from (possibly filtered) file list
  const visibleFiles = repoData
    ? (filterText
        ? repoData.files.filter(f => f.path.toLowerCase().includes(filterText.toLowerCase()))
        : repoData.files)
    : [];

  const fileTree  = repoData ? buildFileTree(visibleFiles) : null;
  const codeCount = repoData ? repoData.files.filter(f => f.isCode).length : 0;

  // Quick lookup: path → scan result
  const scanMap = {};
  if (scanResult) scanResult.results.forEach(r => { scanMap[r.path] = r; });

  /* ── Load repo tree ── */
  const loadRepo = useCallback(async () => {
    const url = repoUrl.trim();
    if (!url) return;
    setLoadingTree(true);
    setTreeError(null);
    setRepoData(null);
    setScanResult(null);
    setSelectedFile(null);
    setAnalysis(null);
    setFilterText('');

    try {
      const res  = await fetch('/api/repo/tree', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load repository');
      setRepoData(data);
      // Expand top-level dirs by default
      const init = {};
      data.files.forEach(f => {
        const top = f.path.split('/')[0];
        if (f.path.includes('/')) init[top] = true;
      });
      setExpanded(init);
    } catch (err) {
      setTreeError(err.message);
    } finally {
      setLoadingTree(false);
    }
  }, [repoUrl]);

  /* ── Analyse a single file ── */
  const analyzeFile = useCallback(async (file) => {
    if (!repoData) return;
    setSelectedFile(file);
    setAnalyzing(true);
    setAnalysis(null);
    setScanResult(null);

    try {
      const res  = await fetch('/api/repo/analyze-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: repoData.owner, repo: repoData.repo, path: file.path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      setAnalysis(data);
    } catch (err) {
      setAnalysis({ error: err.message, path: file.path, status: 'error' });
    } finally {
      setAnalyzing(false);
    }
  }, [repoData]);

  /* ── Batch scan all code files ── */
  const scanAll = useCallback(async () => {
    const url = repoUrl.trim();
    if (!url) return;
    setScanning(true);
    setScanResult(null);
    setSelectedFile(null);
    setAnalysis(null);

    try {
      const res  = await fetch('/api/scan-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      setScanResult(data);
      if (onScanComplete) onScanComplete();
    } catch (err) {
      setTreeError(err.message);
    } finally {
      setScanning(false);
    }
  }, [repoUrl, onScanComplete]);

  const toggleDir = useCallback((key) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const EXAMPLES = [
    'https://github.com/expressjs/express',
    'https://github.com/tiangolo/fastapi',
    'https://github.com/pallets/flask',
  ];

  return (
    <div className="scanner-wrapper">

      {/* ── URL input bar ── */}
      <div className="scanner-input-bar">
        <div className="scanner-url-wrap">
          <GitBranch size={15} className="scanner-url-icon" />
          <input
            id="repo-url-input"
            type="text"
            className="scanner-url-input"
            placeholder="owner/repo  or  https://github.com/owner/repo"
            value={repoUrl}
            onChange={e => setRepoUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadRepo()}
          />
        </div>
        <button
          id="load-repo-btn"
          className="btn-load-repo"
          onClick={loadRepo}
          disabled={loadingTree || !repoUrl.trim()}
        >
          {loadingTree ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
          {loadingTree ? 'Loading…' : 'Load Repo'}
        </button>
        {repoData && (
          <button
            id="scan-all-btn"
            className="btn-scan-all"
            onClick={scanAll}
            disabled={scanning}
          >
            {scanning ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
            {scanning ? 'Scanning…' : `Scan All (${codeCount} files)`}
          </button>
        )}
      </div>

      {/* ── Error banner ── */}
      {treeError && (
        <div className="error-banner mt-3">
          <AlertCircle size={15} />
          <span>{treeError}</span>
        </div>
      )}

      {/* ── Repo info bar ── */}
      {repoData && (
        <div className="scanner-repo-bar">
          <div className="flex items-center gap-2">
            <GitBranch size={13} className="text-lime-300" />
            <span className="text-sm font-semibold text-white">{repoData.owner}/{repoData.repo}</span>
            <span className="text-xs text-gray-500">on <span className="text-lime-300/70 font-mono">{repoData.branch}</span></span>
          </div>
          <div className="flex items-center gap-5 text-xs text-gray-500">
            <span><span className="text-white font-medium">{repoData.files.length}</span> total</span>
            <span><span className="text-lime-300 font-medium">{codeCount}</span> code files</span>
            {repoData.truncated && <span className="text-amber-400">⚠ Tree truncated</span>}
          </div>
        </div>
      )}

      {/* ── Main split layout ── */}
      {repoData && (
        <div className="scanner-layout">

          {/* Left: file tree */}
          <div className="file-tree-panel">
            <div className="file-tree-search-bar">
              <Search size={12} className="text-gray-500 shrink-0" />
              <input
                type="text"
                className="file-tree-search-input"
                placeholder="Filter files…"
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
              />
              {filterText && (
                <button className="text-gray-500 hover:text-gray-300" onClick={() => setFilterText('')}>✕</button>
              )}
            </div>

            <div className="file-tree-scroll">
              {fileTree && fileTree.children.map((node, i) => (
                <TreeNode
                  key={node.path || node.name + i}
                  node={node} depth={0}
                  selectedPath={selectedFile?.path}
                  onFileClick={analyzeFile}
                  scanMap={scanMap}
                  expanded={expanded}
                  toggleDir={toggleDir}
                />
              ))}
              {visibleFiles.length === 0 && (
                <p className="text-xs text-gray-600 p-4 text-center">No files match "{filterText}"</p>
              )}
            </div>

            <div className="file-tree-legend">
              <span className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />Clean
              </span>
              <span className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className="w-2 h-2 rounded-full bg-red-400" />Issues
              </span>
              <span className="text-xs text-gray-700">Click files to analyse</span>
            </div>
          </div>

          {/* Right: analysis */}
          <AnalysisPanel
            selectedFile={selectedFile}
            analysis={analysis}
            analyzing={analyzing}
            scanResult={scanResult}
            scanning={scanning}
          />
        </div>
      )}

      {/* ── Empty state ── */}
      {!repoData && !loadingTree && !treeError && (
        <div className="scanner-empty-state">
          <div className="scanner-empty-icon">
            <GitBranch size={32} className="text-gray-600" />
          </div>
          <h3 className="text-base font-semibold text-gray-400 mt-4">Load a GitHub Repository</h3>
          <p className="text-sm text-gray-600 mt-1 max-w-sm text-center">
            Paste any public GitHub repo URL above and click <strong className="text-gray-400">Load Repo</strong> to browse
            files and run AI code review on any file.
          </p>
          <div className="mt-6">
            <p className="text-xs text-gray-600 mb-2 text-center">Try an example:</p>
            <div className="flex flex-col gap-2 items-center">
              {EXAMPLES.map(url => (
                <button
                  key={url}
                  className="example-url-btn"
                  onClick={() => setRepoUrl(url)}
                >
                  {url.replace('https://github.com/', 'github.com/')}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
