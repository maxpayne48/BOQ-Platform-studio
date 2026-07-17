import React, { useState, useEffect } from "react";
import { 
  Upload, 
  Trash2, 
  FileSpreadsheet, 
  Check, 
  AlertCircle, 
  Layers,
  ChevronRight,
  Database,
  Briefcase,
  Plus,
  Activity
} from "lucide-react";
import * as XLSX from "xlsx";
import { HistoricalBOQ, Domain } from "../types.js";

interface HistoricalBOQsTabProps {
  onRefreshMetrics: () => void;
  loadTrigger: number;
  onRefreshLoadTrigger: () => void;
}

interface UploadQueueItem {
  id: string;
  file: File;
  projectName: string;
  contractorName: string;
  status: "pending" | "processing" | "success" | "error";
  progress: number;
  itemCount?: number;
  domains?: Domain[];
  errorMsg?: string;
}

export default function HistoricalBOQsTab({ onRefreshMetrics, loadTrigger, onRefreshLoadTrigger }: HistoricalBOQsTabProps) {
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [historicalList, setHistoricalList] = useState<HistoricalBOQ[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [bulkContractor, setBulkContractor] = useState("");
  const [bulkProject, setBulkProject] = useState("");

  // Real-time Upload Section Telemetry states
  const [healthStats, setHealthStats] = useState<any>(null);
  const [lastUploadTime, setLastUploadTime] = useState<string>(() => {
    return localStorage.getItem("last_upload_time") || "Never";
  });
  const [parsingProgress, setParsingProgress] = useState<number>(0);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [processingLogs, setProcessingLogs] = useState<string[]>([]);

  // Custom Confirmation Modal state
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Custom Clear All Confirmation Modal state
  const [showClearAllModal, setShowClearAllModal] = useState(false);
  const [isClearingAll, setIsClearingAll] = useState(false);

  // Status notification alert
  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const fetchHealthStats = () => {
    fetch("/api/system-health")
      .then((res) => res.json())
      .then((data) => setHealthStats(data))
      .catch((err) => console.error("Error loading system health stats inside HistoricalBOQs:", err));
  };

  useEffect(() => {
    fetchList();
    fetchHealthStats();
  }, [loadTrigger]);

  const fetchList = () => {
    setLoadingList(true);
    fetch("/api/historical-boqs")
      .then((res) => res.json())
      .then((data) => {
        setHistoricalList(data);
        setLoadingList(false);
      })
      .catch((err) => {
        console.error("Error fetching historical BOQs:", err);
        setLoadingList(false);
      });
  };

  const showNotification = (type: "success" | "error", text: string) => {
    setNotification({ type, text });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  // Drag and drop events
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      queueFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      queueFiles(Array.from(e.target.files));
    }
  };

  const queueFiles = (files: File[]) => {
    const validExtensions = [".xlsx", ".xls", ".csv"];
    const newItems: UploadQueueItem[] = [];

    files.forEach((file) => {
      const extension = file.name.substring(file.name.lastIndexOf(".")).toLowerCase();
      if (!validExtensions.includes(extension)) {
        showNotification("error", `File type "${extension}" is not supported. Please select Excel or CSV files.`);
        return;
      }

      // Automatically generate clean Project and Contractor names based on filename
      let autoProjName = file.name.split(".")[0].replace(/[-_]/g, " ");
      autoProjName = autoProjName.charAt(0).toUpperCase() + autoProjName.slice(1);

      newItems.push({
        id: "queue_" + Math.random().toString(36).substr(2, 9),
        file,
        projectName: bulkProject || autoProjName,
        contractorName: bulkContractor || "Unknown Contractor",
        status: "pending",
        progress: 0
      });
    });

    setQueue((prev) => [...prev, ...newItems]);
  };

  const removeQueueItem = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const updateQueueMetadata = (id: string, field: "projectName" | "contractorName", value: string) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  // Apply bulk inputs to all pending queue items
  const applyBulkMetadata = () => {
    setQueue((prev) =>
      prev.map((item) => {
        if (item.status === "pending") {
          return {
            ...item,
            projectName: bulkProject || item.projectName,
            contractorName: bulkContractor || item.contractorName
          };
        }
        return item;
      })
    );
    showNotification("success", "Bulk project / contractor inputs applied to queue");
  };

  // Ingest files one by one (Excel parsing & serialization)
  const processBulkIngest = async () => {
    const pendingItems = queue.filter((i) => i.status === "pending" || i.status === "error");

    if (pendingItems.length === 0) {
      showNotification("error", "No pending files in the upload queue.");
      return;
    }

    setProcessingLogs([]);

    for (const item of pendingItems) {
      const logMessage = (msg: string) => {
        const timeStr = new Date().toISOString().substring(11, 19);
        setProcessingLogs((prev) => [...prev, `[${timeStr}] ${msg}`]);
      };

      logMessage(`Starting ingestion of "${item.file.name}"...`);
      setParsingProgress(15);
      setUploadProgress(0);

      // Mark as processing
      setQueue((prev) =>
        prev.map((q) => (q.id === item.id ? { ...q, status: "processing", progress: 20 } : q))
      );

      try {
        logMessage(`Parsing binary sheets in-browser via ExcelReader...`);
        const sheetsData = await parseExcelInBrowser(item.file);
        logMessage(`Excel parsing successful. Extracted ${sheetsData.length} worksheets: ${sheetsData.map(s => s.sheetName).join(", ")}`);
        setParsingProgress(100);
        setUploadProgress(40);

        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, progress: 60 } : q))
        );

        logMessage(`Transmitting serialized payload to server-side ingestion handler...`);
        setUploadProgress(75);

        // Send to backend endpoint
        const response = await fetch("/api/historical-boqs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectName: item.projectName,
            contractorName: item.contractorName,
            fileName: item.file.name,
            sheets: sheetsData
          })
        });

        const resData = await response.json();

        if (response.ok && resData.success) {
          logMessage(`Successfully processed by backend engine. Created standard records and balanced indices!`);
          logMessage(`Registered ${resData.addedCount} items across domains: ${resData.domains.join(", ")}`);
          setUploadProgress(100);

          const timeStamp = new Date().toISOString().replace("T", " ").substring(0, 19);
          setLastUploadTime(timeStamp);
          localStorage.setItem("last_upload_time", timeStamp);

          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? {
                    ...q,
                    status: "success",
                    progress: 100,
                    itemCount: resData.addedCount,
                    domains: resData.domains
                  }
                : q
            )
          );
        } else {
          throw new Error(resData.error || "Failed to parse BOQ structural mapping on server.");
        }
      } catch (err: any) {
        logMessage(`ERROR during processing: ${err.message || String(err)}`);
        console.error("Error processing queue file:", err);
        setParsingProgress(0);
        setUploadProgress(0);
        setQueue((prev) =>
          prev.map((q) =>
            q.id === item.id
              ? {
                  ...q,
                  status: "error",
                  progress: 0,
                  errorMsg: err.message || "Spreadsheet processing failed"
                }
              : q
          )
        );
      }
    }

    // Refresh metrics & table list
    onRefreshMetrics();
    onRefreshLoadTrigger();
    fetchList();
    fetchHealthStats();
    showNotification("success", "Bulk historical BOQ ingestion completed.");
  };

  const parseExcelInBrowser = (file: File): Promise<{ sheetName: string; rows: any[][] }[]> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: "array" });

          const sheets = workbook.SheetNames.map((sheetName) => {
            const sheet = workbook.Sheets[sheetName];
            // Read spreadsheet with format parameters
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
            return { sheetName, rows };
          });
          resolve(sheets);
        } catch (err) {
          reject(new Error("Unable to read Excel workbook structure: " + String(err)));
        }
      };
      reader.onerror = () => reject(new Error("File reader error"));
      reader.readAsArrayBuffer(file);
    });
  };

  // Safe client-side deletion sequence (using custom confirmations)
  const triggerDelete = (id: string) => {
    setDeleteTargetId(id);
  };

  const confirmDelete = () => {
    if (!deleteTargetId) return;
    setIsDeleting(true);

    fetch("/api/historical-boqs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteTargetId })
    })
      .then((res) => res.json())
      .then((data) => {
        setIsDeleting(false);
        setDeleteTargetId(null);
        if (data.success) {
          showNotification("success", "Historical project removed and database cleaned.");
          onRefreshMetrics();
          onRefreshLoadTrigger();
          fetchList();
        } else {
          showNotification("error", data.error || "Failed to remove database records.");
        }
      })
      .catch((err) => {
        setIsDeleting(false);
        setDeleteTargetId(null);
        showNotification("error", "Network connection failure during records deletion.");
        console.error("Delete failed:", err);
      });
  };

  const confirmClearAll = () => {
    setIsClearingAll(true);
    fetch("/api/historical-boqs/clear-all", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        setIsClearingAll(false);
        setShowClearAllModal(false);
        if (data.success) {
          showNotification("success", "All historical BOQs have been cleared successfully.");
          onRefreshMetrics();
          onRefreshLoadTrigger();
          fetchList();
        } else {
          showNotification("error", data.error || "Failed to clear all records.");
        }
      })
      .catch((err) => {
        setIsClearingAll(false);
        setShowClearAllModal(false);
        showNotification("error", "Network connection failure during records clearing.");
        console.error("Clear all failed:", err);
      });
  };

  const [loadingStandard, setLoadingStandard] = useState(false);
  const handleLoadStandardMaster = () => {
    setLoadingStandard(true);
    fetch("/api/master/load-standard", { method: "POST" })
      .then(r => r.json())
      .then(data => {
        setLoadingStandard(false);
        if (data.success) {
          showNotification("success", `Standard Master BOQ catalog loaded! Seeding complete. Matches established.`);
          onRefreshMetrics();
          onRefreshLoadTrigger();
        } else {
          showNotification("error", "Seeding failed.");
        }
      })
      .catch(e => {
        setLoadingStandard(false);
        showNotification("error", "Server connection failed");
      });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-fade-in">
      {/* Upload Column (Left / 1/3 space) */}
      <div className="space-y-6 lg:col-span-1">
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-5 shadow-xs">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <Upload className="w-4 h-4 text-indigo-500" /> Ingest Contractor BOQs
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Upload priced estimation sheets (XLSX, XLS, or CSV). The platform automatically classifies worksheets and maps cells dynamically.
            </p>
          </div>

          {/* Bulk Meta Settings */}
          <div className="space-y-3 p-4 bg-slate-50 rounded-lg border border-slate-100">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
              Default Project / Contractor (Bulk autofill)
            </span>
            <div className="space-y-2">
              <input
                id="input_bulk_project"
                type="text"
                placeholder="Project Name (e.g., Godrej Central)"
                value={bulkProject}
                onChange={(e) => setBulkProject(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-indigo-500 text-slate-700"
              />
              <input
                id="input_bulk_contractor"
                type="text"
                placeholder="Executing Contractor (e.g., L&T Corp)"
                value={bulkContractor}
                onChange={(e) => setBulkContractor(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-indigo-500 text-slate-700"
              />
            </div>
            <button
              id="btn_apply_bulk_meta"
              onClick={applyBulkMetadata}
              className="w-full py-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-medium text-[11px] transition-colors"
            >
              Apply to Pending Files
            </button>
          </div>

          {/* Drag and Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-xl p-6 transition-colors flex flex-col items-center justify-center text-center cursor-pointer bg-slate-50/50"
            onClick={() => document.getElementById("file_selector")?.click()}
          >
            <input
              id="file_selector"
              type="file"
              multiple
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileChange}
            />
            <div className="p-3 bg-white rounded-full shadow-xs border border-slate-100 text-indigo-500 mb-3">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <p className="text-xs font-semibold text-slate-700 mb-1">
              Drag & Drop Multiple Excel Sheets
            </p>
            <p className="text-[10px] text-slate-400">
              xlsx, xls, csv (unlimited simultaneous uploads)
            </p>
          </div>
        </div>

        {/* Real-Time Ingestion Telemetry Summary Panel */}
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Activity className="w-4 h-4 text-violet-500 animate-pulse" /> Real-Time Ingestion Telemetry
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Live metadata index tracking and browser/server processing logs.
            </p>
          </div>

          {historicalList.length === 0 ? (
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-100 text-center">
              <p className="text-xs font-semibold text-slate-400">Awaiting Project Upload</p>
              <p className="text-[10px] text-slate-400 mt-1">Upload a priced BOQ to activate ingestion telemetry.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Projects</span>
                  <span className="text-lg font-bold font-mono text-indigo-600">{historicalList.length}</span>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Worksheets</span>
                  <span className="text-lg font-bold font-mono text-indigo-600">
                    {historicalList.reduce((acc, curr) => acc + (curr.worksheetsCount || 2), 0)}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">BOQ Items</span>
                  <span className="text-lg font-bold font-mono text-indigo-600">
                    {historicalList.reduce((acc, curr) => acc + (curr.itemCount || 0), 0)}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Master items</span>
                  <span className="text-lg font-bold font-mono text-emerald-600">
                    {healthStats?.masterBOQCount ?? "..."}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Hist Rates</span>
                  <span className="text-lg font-bold font-mono text-amber-600">
                    {healthStats?.historicalRatesCount ?? "..."}
                  </span>
                </div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">Basic Rates</span>
                  <span className="text-lg font-bold font-mono text-blue-600">
                    {healthStats?.basicRatesCount ?? "..."}
                  </span>
                </div>
              </div>

              <div className="space-y-2 p-3 bg-slate-50 rounded-lg border border-slate-100 text-[11px] text-slate-600">
                <div className="flex justify-between border-b border-slate-200/50 pb-1.5">
                  <span className="font-medium text-slate-400">Domains</span>
                  <span className="font-semibold text-slate-700 text-right truncate max-w-[140px]" title={Array.from(new Set(historicalList.flatMap(h => h.domains || []))).join(", ")}>
                    {Array.from(new Set(historicalList.flatMap(h => h.domains || []))).join(", ") || "None"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-medium text-slate-400">Last Upload</span>
                  <span className="font-mono font-semibold text-slate-700">{lastUploadTime}</span>
                </div>
              </div>

              {/* In-Browser Ingestion Progress Bars */}
              {(parsingProgress > 0 || uploadProgress > 0) && (
                <div className="space-y-2.5 p-3 bg-indigo-50/50 rounded-lg border border-indigo-100">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] font-bold text-indigo-700">
                      <span>PARSING (EXCEL)</span>
                      <span>{parsingProgress}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${parsingProgress}%` }} />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] font-bold text-indigo-700">
                      <span>UPLOADING & INDEXING</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                    </div>
                  </div>
                </div>
              )}

              {/* Processing Logs */}
              {processingLogs.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                    Processing Logs
                  </span>
                  <div className="bg-slate-900 text-[10px] text-slate-300 p-3 rounded-lg font-mono max-h-36 overflow-y-auto space-y-1 leading-relaxed">
                    {processingLogs.map((log, idx) => (
                      <div key={idx} className={log.includes("ERROR") ? "text-rose-400" : log.includes("Successfully") ? "text-emerald-400" : "text-slate-300"}>
                        {log}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Standard Master Setup Panel */}
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-500" /> Standard Master Setup
            </h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              Consolidate raw historical rows under standard CPWD specifications. Highly recommended after loading custom contractor pricing sheets.
            </p>
          </div>
          <button
            id="btn_load_standard_master"
            onClick={handleLoadStandardMaster}
            disabled={loadingStandard}
            className="w-full py-2 px-3 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-100 font-semibold text-xs transition-colors inline-flex items-center justify-center gap-2"
          >
            {loadingStandard ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-indigo-700 border-t-transparent rounded-full animate-spin"></span>
                Mapping Database...
              </>
            ) : (
              <>⚙️ Load Standard Master BOQ</>
            )}
          </button>
        </div>
      </div>

      {/* Queue and Catalogue list (Right / 2/3 space) */}
      <div className="lg:col-span-2 space-y-6">
        {/* Ingestion Queue Card */}
        {queue.length > 0 && (
          <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-500" /> Upload Queue ({queue.length} files)
              </h2>
              <div className="flex gap-2">
                <button
                  id="btn_clear_queue"
                  onClick={() => setQueue([])}
                  className="px-2.5 py-1 text-xs text-slate-500 hover:text-slate-700 font-medium border border-slate-200 rounded hover:bg-slate-50 transition-colors"
                >
                  Clear All
                </button>
                <button
                  id="btn_trigger_bulk_ingest"
                  onClick={processBulkIngest}
                  className="px-3 py-1 text-xs text-white bg-indigo-600 hover:bg-indigo-500 font-semibold rounded shadow-xs transition-colors inline-flex items-center gap-1"
                >
                  Bulk Ingest <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
              {queue.map((item) => (
                <div
                  key={item.id}
                  className="p-3 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-between gap-4 text-xs hover:border-slate-200 transition-colors"
                >
                  <div className="flex items-center gap-3 shrink-0">
                    <FileSpreadsheet className="w-5 h-5 text-indigo-500" />
                    <div className="space-y-0.5">
                      <p className="font-semibold text-slate-700 truncate max-w-[150px]">{item.file.name}</p>
                      <p className="text-[10px] text-slate-400">Size: {(item.file.size / 1024).toFixed(1)} KB</p>
                    </div>
                  </div>

                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="Project Name"
                      value={item.projectName}
                      onChange={(e) => updateQueueMetadata(item.id, "projectName", e.target.value)}
                      disabled={item.status === "processing" || item.status === "success"}
                      className="px-2 py-1 bg-white border border-slate-200 rounded text-[11px] text-slate-700 focus:outline-none focus:border-indigo-500"
                    />
                    <input
                      type="text"
                      placeholder="Contractor Name"
                      value={item.contractorName}
                      onChange={(e) => updateQueueMetadata(item.id, "contractorName", e.target.value)}
                      disabled={item.status === "processing" || item.status === "success"}
                      className="px-2 py-1 bg-white border border-slate-200 rounded text-[11px] text-slate-700 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {item.status === "pending" && (
                      <button
                        onClick={() => removeQueueItem(item.id)}
                        className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    {item.status === "processing" && (
                      <div className="flex items-center gap-1.5 text-indigo-600 font-semibold text-[11px]">
                        <span className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></span>
                        {item.progress}%
                      </div>
                    )}
                    {item.status === "success" && (
                      <div className="flex items-center gap-1 text-emerald-600 font-semibold text-[10px]">
                        <Check className="w-3.5 h-3.5" /> Mapped {item.itemCount} items
                      </div>
                    )}
                    {item.status === "error" && (
                      <div className="text-red-500 flex items-center gap-1 font-semibold text-[10px]" title={item.errorMsg}>
                        <AlertCircle className="w-3.5 h-3.5" /> Error
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Existing Historical Database List */}
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <h2 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                <Database className="w-4 h-4 text-indigo-500" /> Historical Price Library
              </h2>
              <p className="text-xs text-slate-400">
                Priced files that actively supply recommendations to the semantic mapping engine.
              </p>
            </div>
            {historicalList.length > 0 && (
              <button
                id="btn_clear_all_historical_boqs"
                onClick={() => setShowClearAllModal(true)}
                className="px-2.5 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-lg text-[11px] font-bold transition-all cursor-pointer inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear All BOQs
              </button>
            )}
          </div>

          {loadingList ? (
            <div className="py-12 flex flex-col items-center justify-center">
              <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
              <p className="text-slate-400 text-xs">Loading priced repositories...</p>
            </div>
          ) : historicalList.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-slate-100 rounded-xl bg-slate-50/50">
              <FileSpreadsheet className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-xs font-semibold text-slate-600">No Historical BOQs Uploaded</p>
              <p className="text-[11px] text-slate-400 max-w-[280px] mx-auto mt-1">
                Your database is currently empty. Upload priced Excel files to populate standard match averages.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-100 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50/70 border-b border-slate-100 text-slate-500 font-semibold uppercase tracking-wider text-[10px]">
                    <th className="p-3.5">Project / Contractor</th>
                    <th className="p-3.5">Filename</th>
                    <th className="p-3.5">Active Domains</th>
                    <th className="p-3.5 text-center">Items</th>
                    <th className="p-3.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {historicalList.map((boq) => (
                    <tr key={boq.id} className="hover:bg-slate-50/30 transition-colors">
                      <td className="p-3.5">
                        <div className="space-y-0.5">
                          <p className="font-semibold text-slate-800">{boq.projectName}</p>
                          <p className="text-[10px] text-slate-400 font-medium">Contr: {boq.contractorName}</p>
                        </div>
                      </td>
                      <td className="p-3.5 max-w-[120px] truncate" title={boq.fileName}>
                        {boq.fileName}
                      </td>
                      <td className="p-3.5">
                        <div className="flex flex-wrap gap-1">
                          {boq.domains.map((dom) => (
                            <span
                              key={dom}
                              className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-indigo-50 text-indigo-600 border border-indigo-100"
                            >
                              {dom}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-3.5 text-center font-bold text-slate-700">{boq.itemCount}</td>
                      <td className="p-3.5 text-right">
                        <button
                          onClick={() => triggerDelete(boq.id)}
                          className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors inline-flex"
                          title="Delete file and clean database"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Notifications Drawer */}
      {notification && (
        <div className={`fixed bottom-5 right-5 p-4 rounded-lg shadow-lg border text-xs z-50 flex items-center gap-2.5 max-w-sm animate-slide-in ${
          notification.type === "success" ? "bg-emerald-50 border-emerald-100 text-emerald-800" : "bg-red-50 border-red-100 text-red-800"
        }`}>
          {notification.type === "success" ? <Check className="w-4 h-4 text-emerald-500 shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />}
          <p className="font-semibold">{notification.text}</p>
        </div>
      )}

      {/* Custom Delete Confirmation Modal */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop Blur */}
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity" onClick={() => setDeleteTargetId(null)}></div>

          {/* Modal Container */}
          <div className="relative bg-white border border-slate-100 rounded-xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-scale-in text-center">
            <div className="p-3 bg-red-50 rounded-full text-red-500 w-12 h-12 flex items-center justify-center mx-auto border border-red-100">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-800">Clear Priced Record</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Are you sure you want to remove this historical project? Clustered rates contribution will be recalculate and permanently updated in the Master Database. This action is irreversible.
              </p>
            </div>
            <div className="flex gap-2 justify-center pt-2">
              <button
                onClick={() => setDeleteTargetId(null)}
                disabled={isDeleting}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold transition-colors focus:outline-none"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold transition-colors focus:outline-none inline-flex items-center gap-1"
              >
                {isDeleting ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Clearing...
                  </>
                ) : (
                  "Delete Record"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Clear All Confirmation Modal */}
      {showClearAllModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop Blur */}
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity" onClick={() => setShowClearAllModal(false)}></div>

          {/* Modal Container */}
          <div className="relative bg-white border border-slate-100 rounded-xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-scale-in text-center">
            <div className="p-3 bg-red-50 rounded-full text-red-500 w-12 h-12 flex items-center justify-center mx-auto border border-red-100">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-800">Clear All Priced Records</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Are you sure you want to clear ALL historical BOQs? This will fully reset the Knowledge Base and erase all priced libraries contributing to the semantic rate recommended engine. This action is irreversible.
              </p>
            </div>
            <div className="flex gap-2 justify-center pt-2">
              <button
                onClick={() => setShowClearAllModal(false)}
                disabled={isClearingAll}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-semibold transition-colors focus:outline-none"
              >
                Cancel
              </button>
              <button
                id="btn_confirm_clear_all_historical"
                onClick={confirmClearAll}
                disabled={isClearingAll}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold transition-colors focus:outline-none inline-flex items-center gap-1"
              >
                {isClearingAll ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    Clearing...
                  </>
                ) : (
                  "Clear All"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
