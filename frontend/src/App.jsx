import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';
import {
  Activity, ShieldCheck, AlertCircle, Github,
  RefreshCw, Clock, GitPullRequest, Zap, TrendingUp,
  Code2, Server, Database, Wifi, WifiOff, Search,
} from 'lucide-react';
import RepoScanner from './RepoScanner';

// ─── Constants ───────────────────────────────────────────────────────────────
const API_BASE = '/api';
const REFRESH_INTERVAL_MS = 30_000;

const STATUS_COLORS = {
  Clean: '#4ade80',
  'Issues Found': '#f87171',
};

const PIE_COLORS = ['#4ade80', '#f87171'];

const SEVERITY_COLORS = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#3b82f6',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRelative(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function groupByDate(reviews) {
  const map = {};
  reviews.forEach(r => {
    const date = new Date(r.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (!map[date]) map[date] = { date, total: 0, clean: 0, issues: 0 };
    map[date].total += 1;
    if (r.status === 'Clean') map[date].clean += 1;
    else map[date].issues += 1;
  });
  return Object.values(map).slice(-14); // last 14 days
}

function groupByRepo(reviews) {
  const map = {};
  reviews.forEach(r => {
    if (!map[r.repoName]) map[r.repoName] = { repo: r.repoName, total: 0, clean: 0, issues: 0 };
    map[r.repoName].total += 1;
    if (r.status === 'Clean') map[r.repoName].clean += 1;
    else map[r.repoName].issues += 1;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

// ─── Sub-components ──────────────────────────────────────────────────────────
function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} />;
}

function StatusBadge({ status }) {
  const isClean = status === 'Clean';
  return (
    <span className={`badge ${isClean ? 'badge-clean' : 'badge-issue'}`}>
      {isClean ? <ShieldCheck size={11} /> : <AlertCircle size={11} />}
      {status.toUpperCase()}
    </span>
  );
}

function SeverityDot({ severity = 'low' }) {
  const colors = { high: 'bg-red-500', medium: 'bg-amber-400', low: 'bg-blue-500' };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[severity]}`} />;
}

function KpiCard({ icon: Icon, iconColor, label, value, sub, loading }) {
  return (
    <div className="kpi-card group">
      <div className={`kpi-icon ${iconColor}`}>
        <Icon size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="kpi-label">{label}</p>
        {loading ? (
          <Skeleton className="h-8 w-20 mt-1" />
        ) : (
          <p className="kpi-value">{value}</p>
        )}
        {sub && !loading && <p className="kpi-sub">{sub}</p>}
      </div>
    </div>
  );
}

function CustomTooltipPie({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <p style={{ color: payload[0].payload.fill }}>{payload[0].name}</p>
      <p className="text-white font-bold">{payload[0].value} PRs</p>
    </div>
  );
}

function CustomTooltipLine({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map(p => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: <span className="font-bold text-white">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

function ServiceStatus({ name, icon: Icon, online, detail }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${online ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
        <Icon size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white leading-none">{name}</p>
        <p className="text-xs text-gray-500 mt-0.5">{detail}</p>
      </div>
      <div className={`flex items-center gap-1.5 text-xs font-medium ${online ? 'text-emerald-400' : 'text-red-400'}`}>
        {online ? <Wifi size={12} /> : <WifiOff size={12} />}
        {online ? 'Online' : 'Offline'}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [services, setServices] = useState({ backend: false, fastapi: false, db: false });
  const [activeTab, setActiveTab] = useState('dashboard');

  // Stable ref so the interval closure always calls the latest version
  const isMountedRef = useRef(true);

  const fetchData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);

    // ── Fetch review stats from Node.js backend ──
    try {
      const res = await fetch(`${API_BASE}/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!isMountedRef.current) return;
      setReviews(data);
      setError(null);
      setServices(prev => ({ ...prev, backend: true, db: true }));
    } catch (e) {
      if (!isMountedRef.current) return;
      setError(e.message);
      setServices(prev => ({ ...prev, backend: false, db: false }));
    } finally {
      if (!isMountedRef.current) return;
      setLoading(false);
      setRefreshing(false);
      setLastRefresh(new Date());
    }

    // ── Check FastAPI health separately (non-blocking) ──
    try {
      const fastapiRes = await fetch('http://localhost:8000/health');
      if (isMountedRef.current) {
        setServices(prev => ({ ...prev, fastapi: fastapiRes.ok }));
      }
    } catch {
      if (isMountedRef.current) {
        setServices(prev => ({ ...prev, fastapi: false }));
      }
    }
  }, []); // stable — no deps that change

  useEffect(() => {
    isMountedRef.current = true;
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => {
      isMountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchData]);

  // ── Derived stats ──
  const totalPRs = reviews.length;
  const cleanCount = reviews.filter(r => r.status === 'Clean').length;
  const issuesCount = reviews.filter(r => r.status === 'Issues Found').length;
  const interceptRate = totalPRs > 0 ? ((issuesCount / totalPRs) * 100).toFixed(1) : '0.0';

  const pieData = [
    { name: 'Safe', value: cleanCount, fill: PIE_COLORS[0] },
    { name: 'Vulnerable', value: issuesCount, fill: PIE_COLORS[1] },
  ];

  const timelineData = groupByDate(reviews);
  const repoData = groupByRepo(reviews);

  return (
    <div className="app-shell">
      {/* ── Background glow ── */}
      <div className="bg-glow-1" />
      <div className="bg-glow-2" />

      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <div className="logo-badge">
            <Zap size={18} className="text-lime-300" />
          </div>
          <div>
            <h1 className="header-title">
              AI Code Review <span className="text-lime-300">Ops</span>
            </h1>
            <p className="header-sub">Real-time CodeBERT analysis for GitHub Pull Requests</p>
          </div>
        </div>

        <div className="header-right">
          {lastRefresh && (
            <span className="last-refresh">
              <Clock size={12} />
              {formatRelative(lastRefresh)}
            </span>
          )}
          {activeTab === 'dashboard' && (
            <button
              id="refresh-btn"
              className="btn-refresh"
              onClick={() => fetchData(true)}
              disabled={refreshing}
            >
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
              Refresh
            </button>
          )}
          <div className="github-badge">
            <Github size={20} />
          </div>
        </div>
      </header>

      {/* ── Tab Navigation ── */}
      <nav className="tab-nav" aria-label="Main navigation">
        <button
          id="tab-dashboard"
          className={`tab-btn ${activeTab === 'dashboard' ? 'tab-btn-active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <Activity size={14} />
          Dashboard
        </button>
        <button
          id="tab-scanner"
          className={`tab-btn ${activeTab === 'scanner' ? 'tab-btn-active' : ''}`}
          onClick={() => setActiveTab('scanner')}
        >
          <Search size={14} />
          Repo Scanner
        </button>
      </nav>

      {activeTab === 'scanner' && (
        <RepoScanner onScanComplete={() => fetchData(true)} />
      )}

      {activeTab === 'dashboard' && <main className="main-content">

        {/* ── Error banner ── */}
        {error && (
          <div className="error-banner">
            <AlertCircle size={16} />
            <span>Backend connection failed — showing cached data. <strong>{error}</strong></span>
          </div>
        )}

        {/* ── KPI Cards ── */}
        <section className="kpi-grid" aria-label="Key Performance Indicators">
          <KpiCard
            icon={GitPullRequest} iconColor="text-lime-300 bg-lime-300/10"
            label="Total PRs Scanned" loading={loading}
            value={totalPRs.toLocaleString()}
            sub="All-time automated reviews"
          />
          <KpiCard
            icon={ShieldCheck} iconColor="text-emerald-400 bg-emerald-400/10"
            label="Safe Merges" loading={loading}
            value={cleanCount.toLocaleString()}
            sub={totalPRs > 0 ? `${((cleanCount/totalPRs)*100).toFixed(1)}% of all PRs` : '—'}
          />
          <KpiCard
            icon={AlertCircle} iconColor="text-red-400 bg-red-400/10"
            label="Vulnerabilities Caught" loading={loading}
            value={issuesCount.toLocaleString()}
            sub="Security, logic & code smells"
          />
          <KpiCard
            icon={TrendingUp} iconColor="text-purple-400 bg-purple-400/10"
            label="Intercept Rate" loading={loading}
            value={`${interceptRate}%`}
            sub="% of PRs with issues flagged"
          />
        </section>

        {/* ── Charts Row ── */}
        <section className="charts-grid" aria-label="Analytics Charts">

          {/* Pie Chart */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Code Health Split</h2>
              <span className="card-badge">Live</span>
            </div>
            {loading ? (
              <Skeleton className="h-56 w-full" />
            ) : totalPRs === 0 ? (
              <div className="empty-state">No review data yet</div>
            ) : (
              <div className="flex flex-col items-center">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={4}
                      dataKey="value"
                    >
                      {pieData.map((entry, i) => (
                        <Cell key={i} fill={entry.fill} strokeWidth={0} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomTooltipPie />} />
                  </PieChart>
                </ResponsiveContainer>
                {/* Legend */}
                <div className="flex gap-6 mt-2">
                  {pieData.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="w-3 h-3 rounded-full" style={{ background: d.fill }} />
                      <span className="text-gray-400">{d.name}</span>
                      <span className="text-white font-semibold">{d.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Line Chart — Timeline */}
          <div className="card col-span-2">
            <div className="card-header">
              <h2 className="card-title">PR Activity Timeline</h2>
              <span className="card-badge">Last 14 days</span>
            </div>
            {loading ? (
              <Skeleton className="h-56 w-full" />
            ) : timelineData.length === 0 ? (
              <div className="empty-state">No timeline data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={timelineData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltipLine />} />
                  <Legend wrapperStyle={{ color: '#9ca3af', fontSize: 12 }} />
                  <Line type="monotone" dataKey="clean" stroke="#4ade80" strokeWidth={2} dot={false} name="Safe" />
                  <Line type="monotone" dataKey="issues" stroke="#f87171" strokeWidth={2} dot={false} name="Issues" />
                  <Line type="monotone" dataKey="total" stroke="#a78bfa" strokeWidth={2} dot={false} name="Total" strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* ── Repo Bar Chart + Service Status ── */}
        <section className="charts-grid-2" aria-label="Repository Breakdown">

          {/* Bar Chart by Repo */}
          <div className="card col-span-2">
            <div className="card-header">
              <h2 className="card-title">Repository Breakdown</h2>
            </div>
            {loading ? (
              <Skeleton className="h-48 w-full" />
            ) : repoData.length === 0 ? (
              <div className="empty-state">No repository data yet</div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={repoData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="repo" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltipLine />} />
                  <Legend wrapperStyle={{ color: '#9ca3af', fontSize: 12 }} />
                  <Bar dataKey="clean" name="Safe" fill="#4ade80" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="issues" name="Issues" fill="#f87171" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Service Status Panel */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">System Status</h2>
            </div>
            <div className="flex flex-col gap-3">
              <ServiceStatus
                name="Node.js Webhook"
                icon={Server}
                online={services.backend}
                detail="Port 5000 — Express"
              />
              <ServiceStatus
                name="FastAPI + CodeBERT"
                icon={Code2}
                online={services.fastapi}
                detail="Port 8000 — AI Analysis"
              />
              <ServiceStatus
                name="MongoDB Atlas"
                icon={Database}
                online={services.db}
                detail="Review logs & metrics"
              />
            </div>
            <div className="mt-4 pt-4 border-t border-white/10">
              <p className="text-xs text-gray-500">
                Auto-refreshes every <span className="text-lime-300 font-medium">30s</span>
              </p>
            </div>
          </div>
        </section>

        {/* ── Recent Reviews Table ── */}
        <section className="card" aria-label="Recent AI Reviews">
          <div className="card-header">
            <h2 className="card-title">
              <Activity size={16} className="text-lime-300" />
              Recent AI Reviews
            </h2>
            <span className="text-xs text-gray-500">{totalPRs} total</span>
          </div>

          <div className="table-wrapper">
            <table className="reviews-table" id="reviews-table">
              <thead>
                <tr>
                  <th>Pull Request</th>
                  <th>Repository</th>
                  <th>Author</th>
                  <th>AI Status</th>
                  <th>AI Comment</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 6 }).map((_, j) => (
                        <td key={j}><Skeleton className="h-4 w-full" /></td>
                      ))}
                    </tr>
                  ))
                ) : reviews.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-16 text-gray-600">
                      <GitPullRequest size={32} className="mx-auto mb-3 opacity-30" />
                      <p>No reviews yet — open a PR to trigger the pipeline</p>
                    </td>
                  </tr>
                ) : (
                  reviews.map((item, index) => (
                    <tr key={item._id || index} className="table-row">
                      <td>
                        <div className="flex items-center gap-2">
                          <GitPullRequest size={13} className="text-purple-400 shrink-0" />
                          <span className="font-medium text-white truncate max-w-[200px]">{item.prTitle}</span>
                        </div>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-gray-400">{item.repoName}</span>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-[10px] font-bold shrink-0">
                            {item.author?.[0]?.toUpperCase() ?? '?'}
                          </div>
                          <span className="text-gray-300 text-sm">@{item.author}</span>
                        </div>
                      </td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>
                        <p className="text-xs text-gray-400 truncate max-w-[220px]" title={item.comment}>
                          {item.comment}
                        </p>
                      </td>
                      <td>
                        <span className="text-xs text-gray-500" title={formatTime(item.timestamp)}>
                          {formatRelative(item.timestamp)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

      </main>}

      {/* ── Footer ── */}
      <footer className="footer">
        <p>AI Code Review Ops &nbsp;·&nbsp; Powered by <span className="text-lime-300">CodeBERT</span> + <span className="text-purple-400">FastAPI</span> + <span className="text-blue-400">MongoDB</span></p>
      </footer>
    </div>
  );
}