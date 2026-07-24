import React, { useState, useEffect } from "react";
import { 
  FileSpreadsheet, 
  Upload, 
  Trash2, 
  Play, 
  CheckCircle, 
  AlertCircle,
  Briefcase,
  Plus,
  BookOpen,
  Calendar,
  Layers,
  ChevronRight
} from "lucide-react";
import * as XLSX from "xlsx";
import { RFQ, Domain } from "../types.js";

interface UploadRFQTabProps {
  onNavigateToRecommendations: (rfqId: string, rfqFileBuffer: ArrayBuffer | null, rfqFileName: string) => void;
  loadTrigger: number;
  onRefreshLoadTrigger: () => void;
}

export default function UploadRFQTab({ onNavigateToRecommendations, loadTrigger, onRefreshLoadTrigger }: UploadRFQTabProps) {
  const [projectName, setProjectName] = useState("");
  const [preambleText, setPreambleText] = useState("");
  const [rfqFile, setRfqFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  
  const [draftsList, setDraftsList] = useState<RFQ[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(true);

  // Deletion Modal state
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Custom Clear All Confirmation Modal state
  const [showClearAllModal, setShowClearAllModal] = useState(false);
  const [isClearingAll, setIsClearingAll] = useState(false);

  // Status notification alert
  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Upload Diagnostics - the detailed per-worksheet parsing log from the Universal BOQ Parser,
  // shown so a failed/partial upload can be debugged without digging through server logs.
  const [lastUploadLog, setLastUploadLog] = useState<any | null>(null);
  const [showUploadLog, setShowUploadLog] = useState(false);

  // Keep a local in-memory store of the raw ArrayBuffers of uploaded RFQs
  // This is critical because when exporting, we must load the *original* Excel formatting!
  // Since we operate completely client-side in React, we can store these raw files in a mapping state!
  const [fileBuffers, setFileBuffers] = useState<Record<string, { buffer: ArrayBuffer; name: string }>>({});

  useEffect(() => {
    fetchDrafts();
  }, [loadTrigger]);

  const fetchDrafts = () => {
    setLoadingDrafts(true);
    fetch("/api/rfqs")
      .then((res) => res.json())
      .then((data) => {
        setDraftsList(data);
        setLoadingDrafts(false);
      })
      .catch((err) => {
        console.error("Error loading RFQ drafts:", err);
        setLoadingDrafts(false);
      });
  };

  const showNotification = (type: "success" | "error", text: string) => {
    setNotification({ type, text });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setRfqFile(e.target.files[0]);
      if (!projectName) {
        // Auto-fill project name from file name
        const name = e.target.files[0].name.split(".")[0].replace(/[-_]/g, " ");
        setProjectName(name.charAt(0).toUpperCase() + name.slice(1));
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setRfqFile(e.dataTransfer.files[0]);
      if (!projectName) {
        const name = e.dataTransfer.files[0].name.split(".")[0].replace(/[-_]/g, " ");
        setProjectName(name.charAt(0).toUpperCase() + name.slice(1));
      }
    }
  };

  // Parse Excel sheets & Send rows metadata to server
  const handleUploadRFQ = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName.trim()) {
      showNotification("error", "Please provide a Project Name.");
      return;
    }
    if (!rfqFile) {
      showNotification("error", "Please drag or select an unrated RFQ Excel workbook.");
      return;
    }

    setParsing(true);

    try {
      // 1. Read file as ArrayBuffer first to preserve original styles/formulas on Export!
      const fileReader = new FileReader();
      
      const fileBufferPromise = new Promise<ArrayBuffer>((resolve, reject) => {
        fileReader.onload = (event) => {
          if (event.target?.result) {
            resolve(event.target.result as ArrayBuffer);
          } else {
            reject(new Error("Unable to read file buffer"));
          }
        };
        fileReader.onerror = () => reject(new Error("File reader error"));
        fileReader.readAsArrayBuffer(rfqFile);
      });

      const buffer = await fileBufferPromise;

      // 2. Parse workbook to rows structure for backend parsing using SheetJS
      const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
      const sheetsData = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];
        return { sheetName, rows };
      });

      // 3. Post structural payload to API
      const response = await fetch("/api/rfqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName,
          fileName: rfqFile.name,
          preambleText,
          sheets: sheetsData,
          originalBase64: arrayBufferToBase64(buffer)
        })
      });

      const data = await response.json();
      const uploadLog = data.uploadLog || data.rfq?.uploadLog || null;
      setLastUploadLog(uploadLog);
      if (uploadLog?.metadataWarning || uploadLog?.warnings?.length > 0) {
        setShowUploadLog(true);
      }

      if (response.ok && data.success) {
        showNotification(
          "success",
          uploadLog?.metadataWarning
            ? `RFQ Ingested! Parsed ${data.itemsCount} line items. Note: excessive workbook metadata was detected and cleaned - see Upload Diagnostics below.`
            : `RFQ Ingested! Parsed ${data.itemsCount} payable estimating line items.`
        );

        // Store raw ArrayBuffer matching this RFQ ID for client-side Rate preservation on Export!
        const rfqId = data.rfq.id;
        const updatedBuffers = { ...fileBuffers, [rfqId]: { buffer, name: rfqFile.name } };
        setFileBuffers(updatedBuffers);

        // Also save to Session/LocalStorage so it survives individual page tab switches
        // (IndexedDB or State is ideal, session storage holds base64)
        try {
          const base64 = arrayBufferToBase64(buffer);
          sessionStorage.setItem(`rfq_raw_${rfqId}`, JSON.stringify({ base64, name: rfqFile.name }));
        } catch (storageErr) {
          console.warn("Storage warning: original binary is too large for sessionStorage, falls back to memory state only", storageErr);
        }

        // Clean form states
        setProjectName("");
        setPreambleText("");
        setRfqFile(null);

        onRefreshLoadTrigger();
        fetchDrafts();
      } else {
        throw new Error(data.error || "Ingestion error");
      }
    } catch (err: any) {
      showNotification("error", "Spreadsheet ingestion failed: " + err.message);
      console.error(err);
    } finally {
      setParsing(false);
    }
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  };

  const triggerDelete = (id: string) => {
    setDeleteTargetId(id);
  };

  const confirmDelete = () => {
    if (!deleteTargetId) return;
    setIsDeleting(true);

    fetch("/api/rfqs/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: deleteTargetId })
    })
      .then((res) => res.json())
      .then((data) => {
        setIsDeleting(false);
        setDeleteTargetId(null);
        if (data.success) {
          showNotification("success", "Unrated estimate draft discarded.");
          onRefreshLoadTrigger();
          fetchDrafts();
        } else {
          showNotification("error", "Failed to discard draft.");
        }
      })
      .catch((err) => {
        setIsDeleting(false);
        setDeleteTargetId(null);
        showNotification("error", "Server communication failed");
      });
  };

  const confirmClearAll = () => {
    setIsClearingAll(true);
    fetch("/api/rfqs/clear-all", { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        setIsClearingAll(false);
        setShowClearAllModal(false);
        if (data.success) {
          showNotification("success", "All active estimation drafts cleared successfully.");
          onRefreshLoadTrigger();
          fetchDrafts();
        } else {
          showNotification("error", "Failed to clear drafts.");
        }
      })
      .catch((err) => {
        setIsClearingAll(false);
        setShowClearAllModal(false);
        showNotification("error", "Server communication failed");
      });
  };

  const handleRateDraft = (rfq: RFQ) => {
    // Attempt to pull raw ArrayBuffer from memory state or sessionStorage
    let bufferObj = fileBuffers[rfq.id] || null;
    if (!bufferObj) {
      const stored = sessionStorage.getItem(`rfq_raw_${rfq.id}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          const binary = window.atob(parsed.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          bufferObj = { buffer: bytes.buffer, name: parsed.name };
        } catch (e) {
          console.error("Failed to restore stored arrayBuffer:", e);
        }
      }
    }

    onNavigateToRecommendations(rfq.id, bufferObj ? bufferObj.buffer : null, rfq.fileName);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-fade-in">
      {/* Upload unrated RFQ (1/3 columns width) */}
      <div className="lg:col-span-1 p-6 bg-white border border-slate-100 rounded-xl space-y-5 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
            <Upload className="w-4 h-4 text-indigo-500" /> New Estimating Draft
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            Create an unrated commercial draft by dropping a client RFQ sheet. Pasting Preamble notes enhances matching metrics.
          </p>
        </div>

        <form onSubmit={handleUploadRFQ} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Project / Estimation Name</label>
            <input
              id="input_rfq_project"
              type="text"
              required
              placeholder="e.g., Brigade Woods Phase 2"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              disabled={parsing}
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-100 rounded-lg focus:outline-none focus:border-indigo-500 focus:bg-white text-slate-700 font-semibold"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Preamble / General Notes (Optional)</label>
            <textarea
              id="textarea_preamble"
              placeholder="Paste contract specifications, material grades, paint coats details, or thickness guidelines here to boost matching accuracy..."
              value={preambleText}
              onChange={(e) => setPreambleText(e.target.value)}
              disabled={parsing}
              rows={4}
              className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-100 rounded-lg focus:outline-none focus:border-indigo-500 focus:bg-white text-slate-600 leading-relaxed font-sans"
            ></textarea>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider block">RFQ Excel File</label>
            <div
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              className={`border-2 border-dashed border-slate-200 hover:border-indigo-400 rounded-xl p-6 transition-colors flex flex-col items-center justify-center text-center cursor-pointer ${
                rfqFile ? "bg-indigo-50/20 border-indigo-200" : "bg-slate-50/50"
              }`}
              onClick={() => document.getElementById("rfq_file_selector")?.click()}
            >
              <input
                id="rfq_file_selector"
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={handleFileChange}
                disabled={parsing}
              />
              <div className={`p-2.5 rounded-full shadow-3xs border text-indigo-500 mb-2 ${rfqFile ? "bg-indigo-500 text-white" : "bg-white"}`}>
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              {rfqFile ? (
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-indigo-800 truncate max-w-[180px]">{rfqFile.name}</p>
                  <p className="text-[10px] text-indigo-400">Ready to ingest</p>
                </div>
              ) : (
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold text-slate-700">Drop Unrated RFQ Sheet</p>
                  <p className="text-[10px] text-slate-400">xlsx, xls (Civil, Interior, MEP)</p>
                </div>
              )}
            </div>
          </div>

          <button
            id="btn_submit_rfq_ingest"
            type="submit"
            disabled={parsing}
            className="w-full py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-400 text-white font-semibold text-xs shadow-xs transition-colors inline-flex items-center justify-center gap-2"
          >
            {parsing ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Parsing Structural Cells...
              </>
            ) : (
              <>Create Estimation Draft</>
            )}
          </button>
        </form>
      </div>

      {/* Drafts List Column (2/3 columns width) */}
      <div className="lg:col-span-2 p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-indigo-500" /> Active Estimation Drafts
            </h2>
            <p className="text-xs text-slate-400">
              Current estimating projects under review. Rate them dynamically or export formatted price sheets.
            </p>
          </div>
          {draftsList.length > 0 && (
            <button
              id="btn_clear_all_rfqs"
              onClick={() => setShowClearAllModal(true)}
              className="px-2.5 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 rounded-lg text-[11px] font-bold transition-all cursor-pointer inline-flex items-center gap-1.5 shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear All Drafts
            </button>
          )}
        </div>

        {loadingDrafts ? (
          <div className="py-20 flex flex-col items-center justify-center">
            <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
            <p className="text-slate-400 text-xs">Querying draft databases indices...</p>
          </div>
        ) : draftsList.length === 0 ? (
          <div className="py-16 text-center border-2 border-dashed border-slate-100 rounded-xl bg-slate-50/50">
            <Briefcase className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="text-xs font-semibold text-slate-600">No Active Estimates</p>
            <p className="text-[11px] text-slate-400 max-w-[280px] mx-auto mt-1">
              Create an estimation project by uploading an unrated RFQ Excel spreadsheet on the left panel.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {draftsList.map((draft: any) => (
              <div
                key={draft.id}
                className="p-5 bg-slate-50 border border-slate-100 rounded-xl hover:border-slate-200 hover:bg-slate-50/80 transition-all flex flex-col justify-between gap-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5">
                      <h3 className="text-xs font-bold text-slate-800 truncate max-w-[160px]" title={draft.projectName}>
                        {draft.projectName}
                      </h3>
                      <p className="text-[10px] text-slate-400 font-mono flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> {draft.uploadDate}
                      </p>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                      draft.status === "Rated" ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : "bg-indigo-50 text-indigo-600 border border-indigo-100"
                    }`}>
                      {draft.status === "Rated" ? "Rated (100%)" : "Draft (Unrated)"}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-500 truncate" title={draft.fileName}>
                    File: <span className="font-semibold">{draft.fileName}</span>
                  </p>

                  <div className="flex flex-wrap gap-1">
                    {draft.domains.map((dom: string) => (
                      <span key={dom} className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-100 text-slate-500 border border-slate-200">
                        {dom}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                  <span className="text-[11px] text-slate-400 font-bold">
                    {draft.itemCount} Payable Items
                  </span>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => triggerDelete(draft.id)}
                      className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                      title="Discard estimate draft"
                    >
                      <Trash2 className="w-4.5 h-4.5" />
                    </button>
                    <button
                      onClick={() => handleRateDraft(draft)}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-[11px] inline-flex items-center gap-1.5 shadow-3xs"
                    >
                      Rate Sheet <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upload Diagnostics - detailed per-worksheet parsing log from the Universal BOQ Parser */}
      {lastUploadLog && (
        <div className="bg-white border border-slate-100 rounded-xl shadow-xs overflow-hidden">
          <div
            onClick={() => setShowUploadLog(!showUploadLog)}
            className="flex items-center justify-between p-4 bg-slate-50 border-b border-slate-100 cursor-pointer hover:bg-slate-100/60 transition-colors"
          >
            <div className="space-y-0.5">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">Upload Diagnostics</span>
              <p className="text-[10px] text-slate-500">
                {lastUploadLog.worksheetsParsed?.length || 0}/{lastUploadLog.worksheetsFound?.length || 0} worksheets parsed &middot;{" "}
                {lastUploadLog.totalRowsParsed || 0} rows extracted &middot; {lastUploadLog.totalRowsSkipped || 0} rows skipped &middot;{" "}
                {lastUploadLog.parsingTimeMs || 0}ms
              </p>
            </div>
            <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${showUploadLog ? "rotate-90" : ""}`} />
          </div>

          {showUploadLog && (
            <div className="p-4 space-y-4 text-xs">
              {lastUploadLog.errors?.length > 0 && (
                <div className="space-y-1">
                  <p className="font-bold text-red-600 uppercase text-[10px] tracking-wider">Errors</p>
                  {lastUploadLog.errors.map((e: string, idx: number) => (
                    <p key={idx} className="text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1">{e}</p>
                  ))}
                </div>
              )}
              {lastUploadLog.warnings?.length > 0 && (
                <div className="space-y-1">
                  <p className="font-bold text-amber-600 uppercase text-[10px] tracking-wider">Warnings</p>
                  {lastUploadLog.warnings.map((w: string, idx: number) => (
                    <p key={idx} className="text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">{w}</p>
                  ))}
                </div>
              )}
              {lastUploadLog.worksheetsSkipped?.length > 0 && (
                <div className="space-y-1">
                  <p className="font-bold text-slate-500 uppercase text-[10px] tracking-wider">Worksheets Skipped</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {lastUploadLog.worksheetsSkipped.map((s: { sheetName: string; reason: string }, idx: number) => (
                      <div key={idx} className="bg-slate-50 border border-slate-100 rounded px-2 py-1">
                        <span className="font-semibold text-slate-700">{s.sheetName}</span>
                        <span className="text-slate-400"> - {s.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {lastUploadLog.skippedReasonSummary && Object.keys(lastUploadLog.skippedReasonSummary).length > 0 && (
                <div className="space-y-1">
                  <p className="font-bold text-slate-500 uppercase text-[10px] tracking-wider">Skipped Row Reasons</p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(lastUploadLog.skippedReasonSummary).map(([reason, count]) => (
                      <span key={reason} className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[10px] font-medium">
                        {reason}: {count as number}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="space-y-1">
                <p className="font-bold text-slate-500 uppercase text-[10px] tracking-wider">Worksheets Found</p>
                <p className="text-slate-500">{lastUploadLog.worksheetsFound?.join(", ") || "-"}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Notifications Drawer */}
      {notification && (
        <div className={`fixed bottom-5 right-5 p-4 rounded-lg shadow-lg border text-xs z-50 flex items-center gap-2.5 max-w-sm animate-slide-in ${
          notification.type === "success" ? "bg-emerald-50 border-emerald-100 text-emerald-800" : "bg-red-50 border-red-100 text-red-800"
        }`}>
          {notification.type === "success" ? <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />}
          <p className="font-semibold">{notification.text}</p>
        </div>
      )}

      {/* Discard Confirmation Modal */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setDeleteTargetId(null)}></div>
          <div className="relative bg-white border border-slate-100 rounded-xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-scale-in text-center">
            <div className="p-3 bg-red-50 rounded-full text-red-500 w-12 h-12 flex items-center justify-center mx-auto border border-red-100">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-800">Discard Estimating Draft</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Are you sure you want to discard this unrated estimation draft? All pricing rows progress and pasted preamble spec notes data will be permanently cleared.
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
                  "Discard Draft"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Clear All Confirmation Modal */}
      {showClearAllModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setShowClearAllModal(false)}></div>
          <div className="relative bg-white border border-slate-100 rounded-xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-scale-in text-center">
            <div className="p-3 bg-red-50 rounded-full text-red-500 w-12 h-12 flex items-center justify-center mx-auto border border-red-100">
              <Trash2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-slate-800">Clear All Estimation Drafts</h3>
              <p className="text-xs text-slate-500 leading-relaxed">
                Are you sure you want to clear ALL active estimation drafts? This will permanently delete all drafts and their corresponding payable rows from your workspace. This action is irreversible.
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
                id="btn_confirm_clear_all_rfqs"
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
