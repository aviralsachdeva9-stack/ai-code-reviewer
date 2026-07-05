import React, { useEffect, useState } from 'react';
import { Activity, ShieldCheck, AlertCircle, Github } from 'lucide-react';

function App() {
  const [stats, setStats] = useState([]);

  useEffect(() => {
    // Backend se reviews fetch karna
    fetch('http://localhost:5000/api/stats')
      .then(res => res.json())
      .then(data => setStats(data));
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-8 font-sans">
      {/* Header */}
      <header className="flex justify-between items-center mb-12">
        <div>
          <h1 className="text-4xl font-bold text-[#deff9a]">AI Code Review <span className="text-white">Ops</span></h1>
          <p className="text-gray-400 mt-2">Real-time AI analysis for GitHub Pull Requests</p>
        </div>
        <div className="bg-[#1a1a1a] p-3 rounded-full border border-gray-800">
          <Github size={28} />
        </div>
      </header>

      {/* Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
        <div className="bg-[#121212] p-6 rounded-2xl border border-gray-800">
          <Activity className="text-[#deff9a] mb-4" />
          <h3 className="text-gray-400 text-sm">Total PRs Scanned</h3>
          <p className="text-3xl font-bold">{stats.length}</p>
        </div>
        <div className="bg-[#121212] p-6 rounded-2xl border border-gray-800">
          <ShieldCheck className="text-green-400 mb-4" />
          <h3 className="text-gray-400 text-sm">Safe Code Merges</h3>
          <p className="text-3xl font-bold">{stats.filter(s => s.status === 'Clean').length}</p>
        </div>
        <div className="bg-[#121212] p-6 rounded-2xl border border-gray-800">
          <AlertCircle className="text-red-400 mb-4" />
          <h3 className="text-gray-400 text-sm">Vulnerabilities Caught</h3>
          <p className="text-3xl font-bold">{stats.filter(s => s.status === 'Issues Found').length}</p>
        </div>
      </div>

      {/* Recent Reviews Table */}
      <div className="bg-[#121212] rounded-2xl border border-gray-800 overflow-hidden">
        <div className="p-6 border-b border-gray-800">
          <h2 className="text-xl font-semibold">Recent AI Reviews</h2>
        </div>
        <table className="w-full text-left">
          <thead>
            <tr className="text-gray-500 text-sm border-b border-gray-800">
              <th className="p-4">Pull Request</th>
              <th className="p-4">Author</th>
              <th className="p-4">AI Status</th>
              <th className="p-4">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((item, index) => (
              <tr key={index} className="border-b border-gray-800 hover:bg-[#1a1a1a] transition-colors">
                <td className="p-4 font-medium">{item.prTitle}</td>
                <td className="p-4 text-gray-400">@{item.author}</td>
                <td className="p-4">
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${item.status === 'Clean' ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                    {item.status.toUpperCase()}
                  </span>
                </td>
                <td className="p-4 text-gray-500 text-sm">{new Date(item.timestamp).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default App;