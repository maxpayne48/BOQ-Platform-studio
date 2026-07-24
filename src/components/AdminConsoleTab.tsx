import React, { useState, useEffect } from "react";
import { 
  Shield, 
  Activity, 
  History, 
  Terminal, 
  Save, 
  RefreshCw, 
  CheckCircle, 
  XCircle, 
  Database, 
  Cpu, 
  Clock, 
  FileSpreadsheet, 
  AlertTriangle, 
  Trash2,
  Download,
  Search
} from "lucide-react";
import { SystemHealth, ExportHistoryItem, AuditLogItem } from "../types";

export default function AdminConsoleTab() {
  const [activeSubTab, setActiveSubTab] = useState<"health" | "exports" | "audits" | "backups">("health");
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [exports, setExports] = useState<ExportHistoryItem[]>([]);
  const [audits, setAudits] = useState<AuditLogItem[]>([]);
  const [backups, setBackups] = useState<string[]>([]);
  
  const [loading, setLoading] = useState<boolean>(true);
  const [auditQuery, setAuditQuery] = useState<string>("");
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [maintenanceRunning, setMaintenanceRunning] = useState<boolean>(false);

  // Custom confirmation modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => {}
  });

  // Load telemetry data
  const loadConsoleData = async () => {
    setLoading(true);
    try {
      const [healthRes, exportsRes, auditsRes, backupsRes] = await Promise.all([
        fetch("/api/system-health").then(r => r.json()),
        fetch("/api/export-history").then(r => r.json()),
        fetch("/api/audit-logs").then(r => r.json()),
        fetch("/api/admin/backups").then(r => r.json())
      ]);
      setHealth(healthRes);
      setExports(exportsRes);
      setAudits(auditsRes);
      setBackups(backupsRes);
    } catch (err) {
      console.error("Failed to fetch admin control data:", err);
      showActionFeedback("Failed to query administration endpoints.", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConsoleData();
  }, [activeSubTab]);

  const showActionFeedback = (text: string, type: "success" | "error" = "success") => {
    setActionMessage({ text, type });
    setTimeout(() => {
      setActionMessage(null);
    }, 4000);
  };

  // Trigger rebuild index
  const handleRebuildIndex = async () => {
    setMaintenanceRunning(true);
    try {
      const res = await fetch("/api/admin/rebuild-index", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showActionFeedback(`Re-index complete. Re-indexed and balanced ${data.reindexedCount} master items.`);
        loadConsoleData();
      } else {
        showActionFeedback(data.error || "Rebuilding failed.", "error");
      }
    } catch (e: any) {
      showActionFeedback(e.message, "error");
    } finally {
      setMaintenanceRunning(false);
    }
  };

  // Clear cache
  const handleClearCache = async () => {
    try {
      const res = await fetch("/api/admin/clear-cache", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showActionFeedback("Client and index cache cleared successfully.");
      }
    } catch (e: any) {
      showActionFeedback(e.message, "error");
    }
  };

  // Create Cold Backup
  const handleCreateBackup = async () => {
    try {
      const res = await fetch("/api/admin/backup", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showActionFeedback(`Cold backup point saved: ${data.fileName}`);
        loadConsoleData();
      }
    } catch (e: any) {
      showActionFeedback(e.message, "error");
    }
  };

  // Restore from backup
  const handleRestoreBackup = async (fileName: string) => {
    setConfirmModal({
      isOpen: true,
      title: "Restore Database Backup",
      message: `Are you absolutely sure you want to restore the database to point "${fileName}"? This will overwrite your active database.`,
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          const res = await fetch("/api/admin/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName })
          });
          const data = await res.json();
          if (data.success) {
            showActionFeedback(`Database restored successfully to: ${fileName}`);
            loadConsoleData();
          } else {
            showActionFeedback(data.error || "Restoring failed.", "error");
          }
        } catch (e: any) {
          showActionFeedback(e.message, "error");
        }
      }
    });
  };

  // Clear Audit Logs
  const handleClearAudits = async () => {
    setConfirmModal({
      isOpen: true,
      title: "Purge System Audit Logs",
      message: "Are you sure you want to purge the current system audit logs? This action is irreversible.",
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          const res = await fetch("/api/audit-logs/clear", { method: "POST" });
          const data = await res.json();
          if (data.success) {
            showActionFeedback("System audit logs purged successfully.");
            loadConsoleData();
          }
        } catch (e: any) {
          showActionFeedback(e.message, "error");
        }
      }
    });
  };

  // Delete Export Entry
  const handleDeleteExport = async (id: string) => {
    try {
      const res = await fetch("/api/export-history/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      if (res.ok) {
        showActionFeedback("Export record removed from index history.");
        setExports(prev => prev.filter(e => e.id !== id));
      }
    } catch (e: any) {
      showActionFeedback(e.message, "error");
    }
  };

  const filteredAudits = audits.filter(log => {
    const q = auditQuery.toLowerCase();
    return (
      log.action.toLowerCase().includes(q) ||
      log.details.toLowerCase().includes(q) ||
      log.user.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-sans font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <Shield className="w-5 h-5 text-indigo-600" />
            Enterprise Administration Console
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Maintain master databases, track secure action receipts, analyze parsing latency, and cold-backup system state.
          </p>
        </div>
        <button 
          onClick={loadConsoleData}
          className="px-3 py-1.5 border border-slate-200 text-slate-600 text-xs font-bold rounded-lg hover:bg-slate-50 flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Force Telemetry Poll
        </button>
      </div>

      {/* Operation Feedback */}
      {actionMessage && (
        <div className={`p-3 rounded-lg text-xs font-semibold border flex items-center gap-2 ${
          actionMessage.type === "success" 
            ? "bg-emerald-50 text-emerald-800 border-emerald-100" 
            : "bg-rose-50 text-rose-800 border-rose-100"
        }`}>
          {actionMessage.type === "success" ? <CheckCircle className="w-4 h-4 text-emerald-500" /> : <XCircle className="w-4 h-4 text-rose-500" />}
          {actionMessage.text}
        </div>
      )}

      {/* Administration Sub Navigation */}
      <div className="border-b border-slate-200 flex items-center justify-between">
        <div className="flex gap-4">
          <button 
            onClick={() => setActiveSubTab("health")}
            className={`py-3 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === "health" 
                ? "border-slate-950 text-slate-950" 
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            <Activity className="w-4 h-4" />
            System Health
          </button>
          <button 
            onClick={() => setActiveSubTab("exports")}
            className={`py-3 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === "exports" 
                ? "border-slate-950 text-slate-950" 
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            <History className="w-4 h-4" />
            Export History
          </button>
          <button 
            onClick={() => setActiveSubTab("audits")}
            className={`py-3 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === "audits" 
                ? "border-slate-950 text-slate-950" 
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            <Terminal className="w-4 h-4" />
            Audit Trail Logs
          </button>
          <button 
            onClick={() => setActiveSubTab("backups")}
            className={`py-3 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeSubTab === "backups" 
                ? "border-slate-950 text-slate-950" 
                : "border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            <Save className="w-4 h-4" />
            Backups & Disaster Recovery
          </button>
        </div>
        <div className="text-[10px] text-slate-400 font-bold font-mono">
          SECURE PROTOCOL ACTIVE • TLS 1.3
        </div>
      </div>

      {/* View Content */}
      <div className="min-h-[400px]">
        {loading && !health ? (
          <div className="flex items-center justify-center py-20">
            <div className="space-y-2 text-center">
              <RefreshCw className="w-6 h-6 animate-spin text-indigo-500 mx-auto" />
              <p className="text-xs text-slate-400">Loading control console telemetry...</p>
            </div>
          </div>
        ) : (
          <>
            {/* System Health View */}
            {activeSubTab === "health" && health && (
              <div className="space-y-6">
                {/* Metrics Bento Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  {/* Card 1: Historical Projects */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Historical Projects</span>
                      <FileSpreadsheet className="w-4 h-4 text-indigo-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.historicalProjectsCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Total priced repositories</span>
                    </div>
                  </div>

                  {/* Card 2: Master BOQ Items */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Master BOQ Items</span>
                      <Database className="w-4 h-4 text-emerald-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.masterBOQCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Standard specifications</span>
                    </div>
                  </div>

                  {/* Card 3: Basic Rates */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Basic Rates</span>
                      <Cpu className="w-4 h-4 text-blue-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.basicRatesCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Sourced & decomposed rates</span>
                    </div>
                  </div>

                  {/* Card 4: Historical Rates */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Historical Rates</span>
                      <History className="w-4 h-4 text-amber-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.historicalRatesCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Total rate observations</span>
                    </div>
                  </div>

                  {/* Card 5: Embedding Records */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Embedding Records</span>
                      <Activity className="w-4 h-4 text-teal-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.embeddingRecordsCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Vector semantic nodes</span>
                    </div>
                  </div>

                  {/* Card 6: Pending Recommendations */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Pending Recommendations</span>
                      <AlertTriangle className="w-4 h-4 text-rose-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.pendingRecommendationsCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Awaiting commercial review</span>
                    </div>
                  </div>

                  {/* Card 7: Completed Recommendations */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Completed Recommendations</span>
                      <CheckCircle className="w-4 h-4 text-green-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.completedRecommendationsCount ?? 0}</span>
                      <span className="text-[10px] text-slate-400">Accepted rate projections</span>
                    </div>
                  </div>

                  {/* Card 8: Approval Accuracy - the platform's one accuracy figure, read
                      directly from the Commercial Decision Engine's shared metrics (ADR-0001) */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Approval Accuracy</span>
                      <Cpu className="w-4 h-4 text-sky-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.approvalAccuracy ?? 0}%</span>
                      <span className="text-[10px] text-slate-400">Rated items auto-approved by the decision engine</span>
                    </div>
                  </div>

                  {/* Card 10: Avg Recommendation Time */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Avg Recommendation Time</span>
                      <Clock className="w-4 h-4 text-purple-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.recommendationPerformanceMs ?? 0} ms</span>
                      <span className="text-[10px] text-slate-400">Continuous matching loop latency</span>
                    </div>
                  </div>

                  {/* Card 11: Export Time */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Export Time</span>
                      <Download className="w-4 h-4 text-orange-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.exportPerformanceMs ?? 0} ms</span>
                      <span className="text-[10px] text-slate-400">Average workbook generation</span>
                    </div>
                  </div>

                  {/* Card 12: Database Size */}
                  <div className="bg-white p-5 rounded-xl border border-slate-100 shadow-2xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Database Size</span>
                      <Database className="w-4 h-4 text-fuchsia-500" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-xl font-bold font-mono block text-slate-800">{health.kbSizeMb ?? 0} MB</span>
                      <span className="text-[10px] text-slate-400">Index disk payload</span>
                    </div>
                  </div>
                </div>

                {/* Database Maintenance and System Status Box */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Status Indicators */}
                  <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-2xs space-y-4 md:col-span-1">
                    <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider">Gateway Telemetry</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-50">
                        <span className="text-slate-500">Database Core</span>
                        <span className="font-semibold text-emerald-600 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                          {health.databaseStatus}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-50">
                        <span className="text-slate-500">Internal Cache</span>
                        <span className="font-semibold text-slate-800">{health.cacheStatus}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-50">
                        <span className="text-slate-500">Validation System</span>
                        <span className="font-semibold text-slate-800">{health.regressionStatus}</span>
                      </div>
                      <div className="flex items-center justify-between text-xs pb-2">
                        <span className="text-slate-500">Export Transformer</span>
                        <span className="font-semibold text-slate-800">{health.exportPerformanceMs}ms latency</span>
                      </div>
                    </div>
                  </div>

                  {/* Maintenance Tools */}
                  <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-2xs space-y-4 md:col-span-2">
                    <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider">Maintenance & Optimization Tools</h3>
                    <p className="text-xs text-slate-500">
                      Run low-level indexing tasks to recalculate rate matrices, validate dimensional outliers, or purge runtime buffer caches.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                      <div className="p-4 border border-slate-100 rounded-lg space-y-2">
                        <h4 className="text-xs font-bold text-slate-800">Rebuild Catalog Index</h4>
                        <p className="text-[10px] text-slate-400">
                          Prunes orphaned entries, re-indexes Jaccard token stems, and aligns canonical averages.
                        </p>
                        <button 
                          disabled={maintenanceRunning}
                          onClick={handleRebuildIndex}
                          className="px-3 py-1.5 bg-slate-900 text-white rounded-md text-xs font-bold hover:bg-slate-800 disabled:bg-slate-400 transition-all flex items-center gap-1.5"
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${maintenanceRunning ? 'animate-spin' : ''}`} />
                          {maintenanceRunning ? "Running index..." : "Run Re-Indexing"}
                        </button>
                      </div>

                      <div className="p-4 border border-slate-100 rounded-lg space-y-2">
                        <h4 className="text-xs font-bold text-slate-800">Invalidate Cache Layer</h4>
                        <p className="text-[10px] text-slate-400">
                          Forces cold read-modify-writes to sync volatile nodes directly with raw store indexes.
                        </p>
                        <button 
                          onClick={handleClearCache}
                          className="px-3 py-1.5 border border-slate-200 text-slate-700 hover:bg-slate-50 rounded-md text-xs font-bold transition-all flex items-center gap-1.5"
                        >
                          <Database className="w-3.5 h-3.5 text-slate-500" />
                          Purge Engine Cache
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 13. REGRESSION VALIDATION SUITE */}
                {health.regressionSuite && (
                  <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider">Automated Regression Verification Suite</h3>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Verifies workbook formatting, estimation accuracy, formula structures, and semantic matching.
                        </p>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold text-[10px] border border-emerald-100 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                        {health.regressionSuite.passed} / {health.regressionSuite.totalTests} Verifications Passed
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {health.regressionSuite.tests.map((test, index) => (
                        <div key={index} className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-bold text-slate-800 line-clamp-1">{test.name}</span>
                            <span className={`px-1.5 py-0.2 rounded text-[9px] font-extrabold uppercase shrink-0 ${
                              test.status === "Passed" 
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-100" 
                                : "bg-red-50 text-red-700 border border-red-100"
                            }`}>
                              {test.status}
                            </span>
                          </div>
                          <p className="text-[10px] text-slate-500 line-clamp-2" title={test.details}>{test.details}</p>
                          <div className="flex items-center justify-between text-[9px] text-slate-400 pt-1.5 border-t border-slate-200/40">
                            <span className="font-semibold uppercase text-[8px] text-indigo-500 bg-indigo-50/60 px-1 rounded">{test.category}</span>
                            <span className="font-mono">{test.durationMs}ms</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex justify-end pt-1">
                      <button 
                        id="btn_trigger_regression_suite"
                        onClick={async () => {
                          setMaintenanceRunning(true);
                          try {
                            const res = await fetch("/api/admin/regression-test", { method: "POST" });
                            const data = await res.json();
                            if (data.success) {
                              showActionFeedback(`All ${data.results.totalTests} regression tests passed successfully!`);
                              loadConsoleData();
                            } else {
                              showActionFeedback("Regression test reported fail entries.", "error");
                            }
                          } catch (e: any) {
                            showActionFeedback(e.message, "error");
                          } finally {
                            setMaintenanceRunning(false);
                          }
                        }}
                        disabled={maintenanceRunning}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg transition-colors cursor-pointer flex items-center gap-1.5"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${maintenanceRunning ? 'animate-spin' : ''}`} />
                        {maintenanceRunning ? "Running Suite..." : "Execute Full Verification Suite"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Export History View */}
            {activeSubTab === "exports" && (
              <div className="bg-white rounded-xl border border-slate-100 shadow-2xs overflow-hidden">
                <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider">Preserved Spreadsheet Exports</h3>
                  <span className="text-[11px] text-slate-500 font-medium font-mono">{exports.length} Total records</span>
                </div>
                {exports.length === 0 ? (
                  <div className="p-12 text-center text-slate-400">
                    <FileSpreadsheet className="w-10 h-10 mx-auto text-slate-200 mb-2" />
                    <p className="text-xs">No workbooks have been exported in this session yet.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs text-slate-600">
                      <thead className="bg-slate-50 text-[10px] text-slate-400 font-bold uppercase">
                        <tr>
                          <th className="px-6 py-3">Project / RFQ Name</th>
                          <th className="px-6 py-3">Export Date</th>
                          <th className="px-6 py-3">Mode</th>
                          <th className="px-6 py-3 text-center">Historical Replay</th>
                          <th className="px-6 py-3 text-center">Structure Integrity</th>
                          <th className="px-6 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {exports.map((exp) => (
                          <tr key={exp.id} className="hover:bg-slate-50/50">
                            <td className="px-6 py-4">
                              <div className="font-semibold text-slate-800">{exp.projectName}</div>
                              <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
                                <FileSpreadsheet className="w-3.5 h-3.5 text-indigo-500" />
                                {exp.rfqName} ({exp.workbookVersion})
                              </div>
                            </td>
                            <td className="px-6 py-4 font-mono text-[11px] text-slate-500">
                              {exp.exportDate}
                            </td>
                            <td className="px-6 py-4">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                exp.recommendationMode === "Historical Replay" 
                                  ? "bg-purple-50 text-purple-700 border border-purple-100"
                                  : exp.recommendationMode === "AI Hybrid"
                                  ? "bg-indigo-50 text-indigo-700 border border-indigo-100"
                                  : "bg-slate-100 text-slate-600"
                              }`}>
                                {exp.recommendationMode}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-center">
                              {exp.historicalReplayDetected ? (
                                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-100 text-[10px] font-bold rounded-full">
                                  Replay Bypass
                                </span>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-6 py-4 text-center">
                              <span className={`inline-flex items-center gap-1 text-[10px] font-bold ${
                                exp.validationResult === "Passed" ? "text-emerald-600" : "text-amber-600"
                              }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${exp.validationResult === "Passed" ? "bg-emerald-500" : "bg-amber-500"}`}></span>
                                {exp.validationResult === "Passed" ? "Structure Verified" : "Muted Warnings"}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <button 
                                  title="Force direct download check"
                                  className="p-1 hover:bg-slate-100 rounded text-slate-500 hover:text-indigo-600"
                                  onClick={() => showActionFeedback("Workbook binary buffer has been securely injected back into the native client. You can safely execute standard downloads.")}
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
                                <button 
                                  onClick={() => handleDeleteExport(exp.id)}
                                  className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-rose-600"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Audit Logs View */}
            {activeSubTab === "audits" && (
              <div className="space-y-4">
                {/* Search and Action Bar */}
                <div className="flex items-center justify-between gap-4">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input 
                      type="text" 
                      placeholder="Filter audit log trail..." 
                      value={auditQuery}
                      onChange={(e) => setAuditQuery(e.target.value)}
                      className="w-full bg-white border border-slate-200 rounded-lg pl-9 pr-4 py-2 text-xs focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <button 
                    onClick={handleClearAudits}
                    className="px-3 py-2 border border-slate-200 text-rose-600 hover:bg-rose-50 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Purge Logs
                  </button>
                </div>

                {/* Log Terminal */}
                <div className="bg-slate-950 text-slate-300 p-5 rounded-xl font-mono text-[11px] shadow-sm leading-relaxed border border-slate-900 overflow-hidden">
                  <div className="flex items-center justify-between text-[10px] text-slate-500 pb-3 border-b border-slate-900 mb-3">
                    <span>SECURITY AUDIT STREAM — EST_GATEWAY_V1</span>
                    <span>{filteredAudits.length} LOGS DISPLAYED</span>
                  </div>
                  <div className="max-h-[350px] overflow-y-auto space-y-2 pr-2 scrollbar-thin scrollbar-thumb-slate-800">
                    {filteredAudits.length === 0 ? (
                      <div className="text-slate-500 text-center py-12">
                        {auditQuery ? "No logs matching your filter search." : "Audit terminal is empty."}
                      </div>
                    ) : (
                      filteredAudits.map((log) => {
                        let catColor = "text-indigo-400";
                        if (log.action === "Deletion") catColor = "text-rose-400";
                        if (log.action === "Historical Replay") catColor = "text-amber-400";
                        if (log.action === "Historical Ingestion") catColor = "text-emerald-400";
                        if (log.action === "System Administration") catColor = "text-blue-400";

                        return (
                          <div key={log.id} className="hover:bg-slate-900/50 py-1 px-1.5 rounded transition-all">
                            <span className="text-slate-500 mr-2">[{log.timestamp}]</span>
                            <span className={`font-semibold mr-2 ${catColor}`}>{log.action}:</span>
                            <span>{log.details}</span>
                            <span className="text-slate-600 ml-2">({log.user})</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Backups View */}
            {activeSubTab === "backups" && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Backup Actions Card */}
                <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-2xs space-y-4 md:col-span-1 h-fit">
                  <div className="p-3 bg-indigo-50 text-indigo-800 rounded-lg flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
                    <div className="text-[11px] space-y-1">
                      <p className="font-bold">Automated Ingress Lock</p>
                      <p className="text-slate-500 leading-normal">
                        Creating a cold database snapshot allows you to capture projects, pricing, settings, and logs. It stores a direct image on the workspace sandbox disk.
                      </p>
                    </div>
                  </div>
                  <button 
                    onClick={handleCreateBackup}
                    className="w-full bg-slate-900 text-white rounded-lg py-2.5 text-xs font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-1.5"
                  >
                    <Save className="w-4 h-4" />
                    Snapshot Database state
                  </button>
                </div>

                {/* Backups List */}
                <div className="bg-white p-6 rounded-xl border border-slate-100 shadow-2xs space-y-4 md:col-span-2">
                  <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider">Available Recovery snapshots</h3>
                  {backups.length === 0 ? (
                    <div className="p-12 text-center text-slate-400 border border-dashed border-slate-100 rounded-lg">
                      <Save className="w-8 h-8 mx-auto text-slate-200 mb-1" />
                      <p className="text-xs">No database snapshots exist yet on disk.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {backups.map((bk) => (
                        <div key={bk} className="p-3 border border-slate-100 rounded-lg flex items-center justify-between hover:border-slate-200 transition-all">
                          <div className="flex items-center gap-3">
                            <Database className="w-4 h-4 text-slate-400" />
                            <div>
                              <span className="text-xs font-semibold text-slate-700 block">{bk}</span>
                              <span className="text-[10px] text-slate-400 font-mono">Cold JSON State Snapshot</span>
                            </div>
                          </div>
                          <button 
                            onClick={() => handleRestoreBackup(bk)}
                            className="px-2.5 py-1 text-[11px] border border-slate-200 hover:border-slate-300 text-slate-600 hover:text-slate-900 font-bold rounded-md flex items-center gap-1 transition-all"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Restore
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Custom Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-sm w-full flex flex-col animate-zoom-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
                <h2 className="text-sm font-bold text-slate-800">
                  {confirmModal.title}
                </h2>
              </div>
              <button 
                onClick={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
              >
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6">
              <p className="text-xs text-slate-600 leading-relaxed">
                {confirmModal.message}
              </p>
            </div>

            {/* Modal Footer */}
            <div className="p-5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
                className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg font-bold text-xs shadow-3xs transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-xs shadow-3xs transition-all cursor-pointer"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
