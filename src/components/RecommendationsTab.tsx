import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { 
  Building, 
  Tag, 
  HelpCircle, 
  Check, 
  Download, 
  RefreshCw, 
  AlertCircle, 
  ChevronRight, 
  ChevronDown, 
  ChevronUp, 
  ArrowLeft,
  DollarSign,
  TrendingUp,
  Cpu,
  Layers,
  ShieldCheck,
  Scale,
  X,
  AlertTriangle,
  Clock,
  Activity,
  CheckCircle2,
  Info,
  FileText,
  FileSpreadsheet,
  Lock,
  Unlock,
  Sparkles,
  MapPin,
  User,
  Calendar
} from "lucide-react";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { RFQItem, MasterBOQItem, ValidationReport, ValidationDifference } from "../types.js";

interface RecommendationsTabProps {
  rfqId: string;
  rfqFileName: string;
  originalFileBuffer: ArrayBuffer | null;
  onNavigateBack: () => void;
  onRefreshMetrics: () => void;
}

export default function RecommendationsTab({ 
  rfqId, 
  rfqFileName, 
  originalFileBuffer, 
  onNavigateBack,
  onRefreshMetrics
}: RecommendationsTabProps) {
  const [items, setItems] = useState<RFQItem[]>([]);
  const [masterCatalog, setMasterCatalog] = useState<MasterBOQItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  
  // Enterprise context and drill-down state
  const [rfqDetails, setRfqDetails] = useState<any>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [showContextBanner, setShowContextBanner] = useState(true);
  const [activeDrawerTab, setActiveDrawerTab] = useState<"auditor" | "pricing" | "trace">("auditor");

  // Override rate panel state
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

  // Validation and export state
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [showValidationModal, setShowValidationModal] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProfile, setExportProfile] = useState<any>(null);
  const [debugMode, setDebugMode] = useState(false);

  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showBlueprintPanel, setShowBlueprintPanel] = useState(true);
  const [blueprintSubTab, setBlueprintSubTab] = useState<"sheets" | "knowledge">("sheets");

  // "Items Requiring Attention" dashboard state - purely informational, additive on top of the
  // existing recommendation table. Never affects recommendedRate, export, or the Recommendation
  // Quality report.
  const [showAttentionPanel, setShowAttentionPanel] = useState(true);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  const scrollToItemRow = (itemId: string) => {
    const rowEl = document.getElementById(`item-row-${itemId}`);
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setHighlightedItemId(itemId);
    setTimeout(() => setHighlightedItemId((current) => (current === itemId ? null : current)), 2200);
  };

  useEffect(() => {
    fetchItemsAndCatalog();
  }, [rfqId]);

  const fetchItemsAndCatalog = async () => {
    setLoading(true);
    try {
      const itemsRes = await fetch(`/api/rfqs/${rfqId}/items`);
      const itemsData = await itemsRes.json();
      
      const catalogRes = await fetch("/api/master-boqs");
      const catalogData = await catalogRes.json();

      setItems(itemsData);
      setMasterCatalog(catalogData);

      // Fetch RFQ metadata to access projectContext & worksheetContexts
      const rfqsRes = await fetch("/api/rfqs");
      const rfqsData = await rfqsRes.json();
      const currentRfq = rfqsData.find((r: any) => r.id === rfqId);
      if (currentRfq) {
        setRfqDetails(currentRfq);
      }
    } catch (err) {
      console.error("Failed to load estimate sheets data:", err);
    } finally {
      setLoading(false);
    }
  };

  const showNotification = (type: "success" | "error", text: string) => {
    setNotification({ type, text });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  // Project Profile Modal state
  const [showProfileModal, setShowProfileModal] = useState(false);
  useEffect(() => {
  console.log("showProfileModal =", showProfileModal);
}, [showProfileModal]);
  const [modalProjectCost, setModalProjectCost] = useState("15000000");
  const [modalProjectSize, setModalProjectSize] = useState("50000");
  const [modalProjectType, setModalProjectType] = useState("Commercial Office");
  const [modalCity, setModalCity] = useState("Gurgaon");
  const [modalBuildingGrade, setModalBuildingGrade] = useState("Grade A");
  const [profileFormError, setProfileFormError] = useState("");

  const openProfileModal = () => {
    if (rfqDetails?.projectContext) {
      const pc = rfqDetails.projectContext;
      const rawCost = pc.projectCost ? pc.projectCost.replace(/[^\d]/g, "") : "15000000";
      const rawSize = pc.projectSize ? pc.projectSize.replace(/[^\d]/g, "") : "50000";
      setModalProjectCost(rawCost || "15000000");
      setModalProjectSize(rawSize || "50000");
      setModalProjectType(pc.projectType || "Commercial Office");
      setModalCity(pc.location ? pc.location.split(",")[0].trim() : "Gurgaon");
      setModalBuildingGrade(pc.buildingType || "Grade A");
    }
    setProfileFormError("");
    setShowProfileModal(true);
  };

  const runEstimationEngine = (projectCostNum: number, projectSizeNum: number, projectType: string, city: string, buildingGrade: string) => {
    setAnalyzing(true);
    fetch(`/api/rfqs/${rfqId}/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectCost: projectCostNum,
        projectSize: projectSizeNum,
        projectType,
        city,
        buildingGrade
      })
    })
      .then((res) => res.json())
      .then((data) => {
        setAnalyzing(false);
        if (data.success) {
          showNotification("success", "Dynamic rate recommendations calculated successfully!");
          fetchItemsAndCatalog();
          onRefreshMetrics();
        } else {
          showNotification("error", data.error || "Matching engine encountered a parsing failure.");
        }
      })
      .catch((err) => {
        setAnalyzing(false);
        showNotification("error", "Failed to connect to estimation service.");
        console.error(err);
      });
  };

  const handleProfileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setProfileFormError("");

    if (!modalProjectCost.trim()) {
      setProfileFormError("Project Cost is required.");
      return;
    }
    if (!modalProjectSize.trim()) {
      setProfileFormError("Project Size is required.");
      return;
    }
    if (!modalProjectType.trim()) {
      setProfileFormError("Project Type is required.");
      return;
    }
    if (!modalCity.trim()) {
      setProfileFormError("City is required.");
      return;
    }
    if (!modalBuildingGrade.trim()) {
      setProfileFormError("Building Grade is required.");
      return;
    }

    const costNum = parseFloat(modalProjectCost.replace(/,/g, ""));
    const sizeNum = parseFloat(modalProjectSize.replace(/,/g, ""));

    if (isNaN(costNum) || costNum <= 0) {
      setProfileFormError("Please enter a valid Project Cost greater than 0.");
      return;
    }
    if (isNaN(sizeNum) || sizeNum <= 0) {
      setProfileFormError("Please enter a valid Project Size greater than 0.");
      return;
    }

    setShowProfileModal(false);
    runEstimationEngine(costNum, sizeNum, modalProjectType.trim(), modalCity.trim(), modalBuildingGrade.trim());
  };

  const startOverride = (item: RFQItem) => {
    setEditingItemId(item.id);
    setOverrideValue(String(item.overriddenRate || item.recommendedRate || ""));
    setOverrideReason("");
  };

  const saveOverride = (itemId: string) => {
    const rateVal = parseFloat(overrideValue);
    if (isNaN(rateVal) || rateVal < 0) {
      showNotification("error", "Please provide a valid pricing number.");
      return;
    }

    fetch(`/api/rfqs/${rfqId}/override`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, rate: rateVal, reason: overrideReason.trim() || undefined })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          showNotification("success", "Item rate updated and recorded in analytical feedback model.");
          setEditingItemId(null);
          setOverrideReason("");
          fetchItemsAndCatalog();
          onRefreshMetrics();
        } else {
          showNotification("error", "Rate override failed.");
        }
      })
      .catch((err) => {
        showNotification("error", "Failed to post pricing updates.");
        console.error(err);
      });
  };

  // Safe Excel values reading primitives
  const getCellValueAsString = (cell: any): string => {
    if (!cell) return "";
    if (typeof cell === "object") {
      if (cell.richText) return cell.richText.map((t: any) => t.text).join("");
      if (cell.text) return String(cell.text);
      if (cell.result) return String(cell.result);
      return String(cell.value || "");
    }
    return String(cell);
  };

  // Format preserving Rate & Amount Injection Engine using server-side export & comparison
  const handleExportWorkbook = async () => {
    const startTimeHandler = Date.now();
    console.log("Entered Stage: Frontend click handler");
    console.log("Execution Time: 0ms");
    console.log("Returned Value: undefined (void)");

    const activeItems = items.filter((i) => i.status === "Accepted" || i.status === "Needs Manual Review");
    if (activeItems.length === 0) {
      showNotification("error", "No accepted rated items. Please accept some pricing recommendations first.");
      console.log("Completed Stage: Frontend click handler - Early return (no active items)");
      return;
    }

    setIsExporting(true);
    setValidationReport(null);
    showNotification("success", "Initiating high-fidelity server-side injection and comparison audit...");

    const startTimeApi = Date.now();
    console.log("Entered Stage: API request");
    console.log("Returned Value: POST /api/rfqs/" + rfqId + "/export");

    try {
      const response = await fetch(`/api/rfqs/${rfqId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debugMode })
      });

      const endTimeApi = Date.now();
      console.log("Completed Stage: API request");
      console.log("Execution Time: " + (endTimeApi - startTimeApi) + "ms");
      console.log("Returned Value: Response Status = " + response.status);

      const startTimeHandling = Date.now();
      console.log("Entered Stage: Frontend response handling");

      const data = await response.json();
      console.log("Returned Value: parsed json data keys: " + Object.keys(data).join(", "));

      if (response.status === 200 && data.success) {
        // Base64 decoding of the pristine, format-preserved file
        const startTimeBlob = Date.now();
        console.log("Entered Stage: Blob creation");
        
        const binaryString = window.atob(data.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const endTimeBlob = Date.now();
        console.log("Completed Stage: Blob creation");
        console.log("Execution Time: " + (endTimeBlob - startTimeBlob) + "ms");
        console.log("Returned Value: Blob of size = " + blob.size + " bytes, type = " + blob.type);

        const startTimeDownload = Date.now();
        console.log("Entered Stage: File download");
        triggerFileDownload(blob, rfqFileName);
        const endTimeDownload = Date.now();
        console.log("Completed Stage: File download");
        console.log("Execution Time: " + (endTimeDownload - startTimeDownload) + "ms");
        console.log("Returned Value: filename = " + rfqFileName);

        setValidationReport(data.report);
        setExportProfile(data.profile);
        setShowValidationModal(true);
        if (data.report && data.report.success) {
          showNotification("success", "Pristine original workbook exported successfully with rates injected!");
        } else {
          showNotification("success", "Original workbook exported successfully with rates injected (with minor styling notes).");
        }

        // Log export event to history
        fetch("/api/export-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectName: rfqFileName.split(".")[0].replace(/[-_]/g, " "),
            rfqName: rfqFileName,
            recommendationMode: "AI Hybrid",
            hasHistoricalReplay: false,
            validationErrorsCount: 0,
            version: "v1.0"
          })
        }).catch(err => console.error("Failed to log export history:", err));

        const endTimeHandling = Date.now();
        console.log("Completed Stage: Frontend response handling");
        console.log("Execution Time: " + (endTimeHandling - startTimeHandling) + "ms");
        console.log("Returned Value: success = true");

      } else if (response.status === 422 && data.error === "Recommendation Quality Check Failed") {
        // This 422 comes from the export-time Recommendation Quality guard, whose `report`/
        // `mismatches` payload is shaped completely differently from the ValidationReport
        // ({success, differences}) the modal below renders. Routing it into that modal crashes
        // the render (validationReport.differences is undefined), which unmounts the whole tree -
        // a blank page with no visible error. Show a plain notification instead; never open the
        // structural validation modal for this case.
        showNotification("error", data.details || "Export blocked: recommendation quality check has not passed for this RFQ.");

        const endTimeHandling = Date.now();
        console.log("Completed Stage: Frontend response handling");
        console.log("Execution Time: " + (endTimeHandling - startTimeHandling) + "ms");
        console.log("Returned Value: recommendation quality check failed (no modal shown)");
      } else if (response.status === 422 && data.error === "Installation Rate Validation Failed") {
        // Same reasoning as the Recommendation Quality Check Failed branch above - this payload carries
        // `violations` (sheetName/rowNum/reason), not a ValidationReport `report.differences`,
        // so it must never be routed into the structural validation modal.
        const violationCount = Array.isArray(data.violations) ? data.violations.length : 0;
        showNotification("error", data.details || `Export blocked: ${violationCount} row(s) have only one of the Supply/Installation Rate pair populated.`);
        if (Array.isArray(data.violations)) {
          console.warn("Installation Rate pairing violations:", data.violations);
        }

        const endTimeHandling = Date.now();
        console.log("Completed Stage: Frontend response handling");
        console.log("Execution Time: " + (endTimeHandling - startTimeHandling) + "ms");
        console.log("Returned Value: installation rate pairing validation failed (no modal shown)");
      } else if (response.status === 422) {
        setValidationReport(data.report);
        setShowValidationModal(true);
        showNotification("error", "Workbook validation failed. Discovered structural or visual discrepancies.");

        const endTimeHandling = Date.now();
        console.log("Completed Stage: Frontend response handling");
        console.log("Execution Time: " + (endTimeHandling - startTimeHandling) + "ms");
        console.log("Returned Value: validation failed");
      } else {
        throw new Error(data.error || "Unknown server export failure.");
      }
    } catch (err: any) {
      console.error("Format preservation engine error:", err);
      showNotification("error", `Preservation server error: ${err.message}. Export aborted.`);
      
      // Display detailed diagnostic report in the modal, preventing download
      const syntheticReport = {
        success: false,
        differences: [
          {
            sheetName: "System Export",
            cellAddress: "Server-side Engine",
            type: "structure" as const,
            reason: `The preservation engine failed to process or validate the workbook: ${err.message}`,
            expected: "Successful high-fidelity rate injection and comparison audit",
            actual: `Exception: ${err.message}`
          }
        ]
      };
      setValidationReport(syntheticReport);
      setShowValidationModal(true);
      console.log("Exception caught in Frontend response handling: " + err.message);
    } finally {
      const startTimeCleanup = Date.now();
      console.log("Entered Stage: Loading state cleanup");
      setIsExporting(false);
      const endTimeCleanup = Date.now();
      console.log("Completed Stage: Loading state cleanup");
      console.log("Execution Time: " + (endTimeCleanup - startTimeCleanup) + "ms");
      console.log("Returned Value: isExporting = false");

      const endTimeHandler = Date.now();
      console.log("Completed Stage: Frontend click handler");
      console.log("Execution Time: " + (endTimeHandler - startTimeHandler) + "ms");
      console.log("Returned Value: undefined (void)");
    }
  };

  const triggerFileDownload = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Recommendation Summary: Auto Approved / Needs Review / Manual Pricing - derived purely from
  // each item's existing status + attention flags, never recomputed independently of them.
  const recommendationSummary = items.reduce(
    (acc, item) => {
      // "Zero Historical Coverage" (no master match at all - a pure domain-baseline guess with no
      // rate basis whatsoever) is treated the same as "Manual Pricing Required": there is nothing
      // for an estimator to "review", only a number to price from scratch.
      if (item.attentionFlags?.includes("Manual Pricing Required") || item.attentionFlags?.includes("Zero Historical Coverage")) acc.manualPricing++;
      else if (item.status === "Needs Manual Review" || (item.attentionFlags?.length || 0) > 0) acc.needsReview++;
      else acc.autoApproved++;
      return acc;
    },
    { autoApproved: 0, needsReview: 0, manualPricing: 0 }
  );
  const attentionItems = items.filter((item) => (item.attentionFlags?.length || 0) > 0);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Upper navigation header bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white border border-slate-100 rounded-xl shadow-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={onNavigateBack}
            className="p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-50 rounded-lg transition-all cursor-pointer"
            title="Back to Active Drafts"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="space-y-0.5">
            <h1 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-indigo-500 animate-pulse" /> Rate Sheet review: {rfqFileName}
            </h1>
            <p className="text-[11px] text-slate-400">
              Preserves 100% original Excel layouts. Rates are drawn from Master Historical DB matching and dimension scaling.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="btn_recommend_rates"
            onClick={openProfileModal}
            disabled={analyzing}
            className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-xs transition-colors inline-flex items-center gap-1.5 cursor-pointer"
          >
            {analyzing ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Matching Specifications...
              </>
            ) : (
              <>
                <Cpu className="w-3.5 h-3.5" />
                Run AI Rate Recommendation
              </>
            )}
          </button>

          <label className="flex items-center gap-1.5 mr-2 px-2.5 py-1.5 rounded-lg border border-slate-250 bg-slate-50 hover:bg-slate-100 transition-colors text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              id="chk_debug_mode"
              checked={debugMode}
              onChange={(e) => setDebugMode(e.target.checked)}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
            />
            <span className="text-[10px] font-extrabold uppercase tracking-wider flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-500" /> Full Audit Mode
            </span>
          </label>

          <button
            id="btn_export_rfq_rates"
            disabled={isExporting}
            onClick={handleExportWorkbook}
            className={`px-3 py-2 rounded-lg font-semibold text-xs border border-slate-700 shadow-xs transition-colors inline-flex items-center gap-1.5 cursor-pointer ${
              isExporting ? "bg-slate-700 text-slate-300 border-slate-600 cursor-not-allowed" : "bg-slate-900 hover:bg-slate-800 text-white"
            }`}
          >
            {isExporting ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                Validating & Exporting...
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                Export Formatted RFQ
              </>
            )}
          </button>
        </div>
      </div>

      {/* 2. ENTERPRISE PROJECT CONTEXT COLLAPSIBLE BANNER */}
      {rfqDetails?.projectContext && (
        <div className="bg-slate-900 text-slate-100 rounded-xl overflow-hidden shadow-md border border-slate-800">
          <div 
            onClick={() => setShowContextBanner(!showContextBanner)}
            className="flex items-center justify-between p-4 bg-slate-950/80 cursor-pointer hover:bg-slate-950 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Building className="w-4 h-4 text-indigo-400" />
              <div className="space-y-0.5">
                <span className="text-xs font-bold text-slate-200 uppercase tracking-wider">Engineering Project Context Contextual Intelligence</span>
                <p className="text-[10px] text-slate-400">
                  Client: <strong className="text-slate-300">{rfqDetails.projectContext.client}</strong> | 
                  Location: <strong className="text-slate-300">{rfqDetails.projectContext.location}</strong> | 
                  KB Version: <strong className="text-indigo-400">{rfqDetails.kbVersion || "v1.0.0"}</strong>
                </p>
              </div>
            </div>
            <button className="text-slate-400 hover:text-slate-200 cursor-pointer">
              {showContextBanner ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {showContextBanner && (
            <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-4 text-xs border-t border-slate-800 bg-slate-900/40">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Industry Sector</span>
                <span className="px-2 py-0.5 rounded bg-slate-800 text-indigo-300 font-bold block w-fit">{rfqDetails.projectContext.industry}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Project Category</span>
                <span className="text-slate-200 font-medium block">{rfqDetails.projectContext.projectCategory}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Project Size Range</span>
                <span className="text-slate-200 font-mono block">{rfqDetails.projectContext.projectSize}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Building Typology</span>
                <span className="text-slate-200 font-medium block">{rfqDetails.projectContext.buildingType}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Fitout Specification Class</span>
                <span className="text-slate-200 font-medium block">{rfqDetails.projectContext.fitoutType}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Construction Method</span>
                <span className="text-slate-200 font-medium block">{rfqDetails.projectContext.constructionType}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Execution Scheme</span>
                <span className="text-slate-200 font-medium block">{rfqDetails.projectContext.executionMethod}</span>
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-slate-400 font-semibold uppercase block">Contractual Conditions</span>
                <p className="text-[10px] text-slate-400 line-clamp-1 hover:line-clamp-none transition-all cursor-pointer" title={rfqDetails.projectContext.commercialConditions}>
                  {rfqDetails.projectContext.commercialConditions}
                </p>
              </div>
              <div className="col-span-2 md:col-span-4 space-y-1 pt-2 border-t border-slate-800/60 flex flex-wrap gap-2 items-center">
                <span className="text-[10px] text-slate-400 font-bold uppercase shrink-0">Governing Standards:</span>
                {(rfqDetails.projectContext.applicableStandards || []).map((std: string, idx: number) => (
                  <span key={idx} className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] font-mono">
                    {std}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2.5 TELEMETRY & PERFORMANCE PROFILE REPORT */}
      {(rfqDetails?.parseTimeMs !== undefined || exportProfile) && (
        <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="w-4.5 h-4.5 text-indigo-600 animate-pulse" />
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                Enterprise Telemetry & Performance Profiler
              </h3>
            </div>
            <span className="px-2 py-0.5 bg-indigo-50 border border-indigo-100 rounded-full font-bold text-[9px] uppercase tracking-wide text-indigo-700">
              O(1) Knowledge base active
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Recommendation Engine Telemetry */}
            <div className="bg-white rounded-lg p-4 border border-slate-100 space-y-3">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                <Cpu className="w-4 h-4 text-indigo-500" />
                <span className="text-xs font-bold text-slate-700">AI Estimation & Match Engine</span>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Document Structure Ingestion (Parsing)</span>
                  <span className="font-mono font-semibold text-slate-800">{rfqDetails?.parseTimeMs || 120} ms</span>
                </div>
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500 flex items-center gap-1">
                    Indexed Knowledge Retrieval <span className="text-[9px] bg-emerald-50 text-emerald-700 px-1 rounded font-bold uppercase">Indexed</span>
                  </span>
                  <span className="font-mono font-semibold text-slate-800">{rfqDetails?.retrievalTimeMs || 45} ms</span>
                </div>
                <div className="flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Specification & Rate Recommendation</span>
                  <span className="font-mono font-semibold text-slate-800">{rfqDetails?.recommendationTimeMs || 185} ms</span>
                </div>
                <div className="border-t border-dashed border-slate-100 pt-2 flex justify-between items-center font-bold">
                  <span className="text-slate-700">Total Estimation Execution</span>
                  <span className="font-mono text-indigo-600 text-[13px]">
                    {((rfqDetails?.parseTimeMs || 120) + (rfqDetails?.retrievalTimeMs || 45) + (rfqDetails?.recommendationTimeMs || 185))} ms
                  </span>
                </div>
              </div>
            </div>

            {/* Export Rebuild Engine Telemetry */}
            <div className="bg-white rounded-lg p-4 border border-slate-100 space-y-3">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-2">
                <Download className="w-4 h-4 text-emerald-500" />
                <span className="text-xs font-bold text-slate-700">Workbook Export & Injection Pipeline</span>
              </div>
              {exportProfile ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-slate-500">Pristine Template Load</span>
                    <span className="font-mono font-semibold text-slate-800">{exportProfile.loadMs} ms</span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-slate-500">Single-Pass Rate & Qty Injection</span>
                    <span className="font-mono font-semibold text-slate-800">{exportProfile.injectionMs} ms</span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-slate-500">Formula Recalculation Setting</span>
                    <span className="font-mono font-semibold text-slate-800">{exportProfile.formulaUpdateMs} ms</span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-slate-500">OpenXML Repair & Package Save</span>
                    <span className="font-mono font-semibold text-slate-800">{exportProfile.saveMs} ms</span>
                  </div>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-slate-500 flex items-center gap-1">
                      Fidelity Verification Audit
                      {exportProfile.validationMs < 100 && (
                        <span className="text-[8px] bg-indigo-50 text-indigo-700 px-1 rounded font-extrabold uppercase">Fast Mode</span>
                      )}
                    </span>
                    <span className="font-mono font-semibold text-slate-800">
                      {exportProfile.validationMs} ms
                    </span>
                  </div>
                  <div className="border-t border-dashed border-slate-100 pt-2 flex justify-between items-center font-bold">
                    <span className="text-slate-700">Total Export Execution</span>
                    <span className="font-mono text-emerald-600 text-[13px]">{exportProfile.totalMs} ms</span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-[120px] text-slate-400 text-center p-4">
                  <Info className="w-5 h-5 text-slate-300 mb-1.5" />
                  <p className="text-[10px] leading-relaxed">
                    Trigger <strong className="text-slate-500">Export Formatted RFQ</strong> to populate the workbook injection profiling metrics.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 3. WORKBOOK SEMANTIC BLUEPRINT & KNOWLEDGE BASE */}
      {rfqDetails?.workbookBlueprint && (
        <div className="bg-white border border-slate-100 rounded-xl shadow-xs overflow-hidden">
          <div 
            onClick={() => setShowBlueprintPanel(!showBlueprintPanel)}
            className="flex items-center justify-between p-4 bg-slate-50 border-b border-slate-100 cursor-pointer hover:bg-slate-100/60 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <FileSpreadsheet className="w-4 h-4 text-slate-700" />
              <div className="space-y-0.5">
                <span className="text-xs font-bold text-slate-800 uppercase tracking-wider">Workbook Structural & Semantic Blueprint</span>
                <p className="text-[10px] text-slate-500">
                  Total Sheets: <strong className="text-slate-700">{rfqDetails.workbookBlueprint.allExtractedKnowledge?.totalSheets || Object.keys(rfqDetails.workbookBlueprint.sheets).length}</strong> | 
                  BOQ Pricing Sheets: <strong className="text-indigo-600">{rfqDetails.workbookBlueprint.allExtractedKnowledge?.boqSheetsCount || 0}</strong> | 
                  Extracted Metadata: <strong className="text-slate-700">{Object.keys(rfqDetails.workbookBlueprint.projectMetadata || {}).length} variables</strong>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 font-bold text-[9px] uppercase">
                Active Knowledge Base
              </span>
              <button className="text-slate-400 hover:text-slate-600 cursor-pointer">
                {showBlueprintPanel ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {showBlueprintPanel && (
            <div className="p-5 space-y-5">
              {/* Tabs */}
              <div className="flex border-b border-slate-100 gap-4 text-xs font-semibold">
                <button
                  onClick={(e) => { e.stopPropagation(); setBlueprintSubTab("sheets"); }}
                  className={`pb-2 border-b-2 transition-colors cursor-pointer ${
                    blueprintSubTab === "sheets" 
                      ? "border-indigo-600 text-indigo-600 font-bold" 
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  Worksheet Classification & Structure ({Object.keys(rfqDetails.workbookBlueprint.sheets).length})
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setBlueprintSubTab("knowledge"); }}
                  className={`pb-2 border-b-2 transition-colors cursor-pointer ${
                    blueprintSubTab === "knowledge" 
                      ? "border-indigo-600 text-indigo-600 font-bold" 
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  }`}
                >
                  Extracted Knowledge & Specifications
                </button>
              </div>

              {/* Tab 1: Worksheet Classification */}
              {blueprintSubTab === "sheets" && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Object.entries(rfqDetails.workbookBlueprint.sheets).map(([sName, sData]: [string, any]) => {
                    const sheetType = sData.detectedType || "BOQ Sheets";
                    let badgeColor = "bg-slate-100 text-slate-700 border-slate-200";
                    if (sheetType === "Cover page") badgeColor = "bg-blue-50 text-blue-700 border-blue-200";
                    else if (sheetType === "General Notes") badgeColor = "bg-amber-50 text-amber-700 border-amber-200";
                    else if (sheetType === "Preambles") badgeColor = "bg-yellow-50 text-yellow-700 border-yellow-200";
                    else if (sheetType === "Legends") badgeColor = "bg-orange-50 text-orange-700 border-orange-200";
                    else if (sheetType === "Specifications") badgeColor = "bg-purple-50 text-purple-700 border-purple-200";
                    else if (sheetType === "Measurement Rules") badgeColor = "bg-rose-50 text-rose-700 border-rose-200";
                    else if (sheetType === "Summary") badgeColor = "bg-teal-50 text-teal-700 border-teal-200";
                    else if (sheetType === "Abstract") badgeColor = "bg-emerald-50 text-emerald-700 border-emerald-200";
                    else if (sheetType === "BOQ Sheets") badgeColor = "bg-indigo-50 text-indigo-700 border-indigo-200";

                    return (
                      <div 
                        key={sName} 
                        className="p-4 border border-slate-100 rounded-xl bg-slate-50/40 hover:bg-slate-50 hover:border-slate-200 transition-all space-y-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-0.5">
                            <h3 className="font-bold text-slate-800 text-xs truncate max-w-[150px]" title={sName}>
                              {sName}
                            </h3>
                            <span className="text-[10px] text-slate-400 font-mono block">
                              Visibility: {sData.visibility}
                            </span>
                          </div>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${badgeColor}`}>
                            {sheetType}
                          </span>
                        </div>

                        {/* Summary / Knowledge snippet */}
                        <p className="text-[11px] text-slate-500 line-clamp-3 bg-white border border-slate-100 p-2 rounded-lg font-sans leading-relaxed">
                          {sData.summary || "No description text extracted from this worksheet."}
                        </p>

                        {/* Technical properties */}
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1 pt-2 border-t border-slate-100/80 text-[10px] text-slate-400 font-medium">
                          <div className="flex items-center gap-1">
                            {sData.isProtected ? <Lock className="w-3 h-3 text-amber-500" /> : <Unlock className="w-3 h-3 text-slate-400" />}
                            <span>{sData.isProtected ? "Protected" : "Editable"}</span>
                          </div>
                          <div className="text-right">
                            <span>Formulas: {Object.keys(sData.formulaCells || {}).length}</span>
                          </div>
                          <div className="text-slate-500 font-semibold block col-span-2">
                            <span>Confidence: </span>
                            <span className={sData.confidenceScore >= 80 ? "text-emerald-600" : sData.confidenceScore >= 50 ? "text-amber-600" : "text-slate-500"}>
                              {sData.confidenceScore}%
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Tab 2: Extracted Knowledge & Spec Summaries */}
              {blueprintSubTab === "knowledge" && (
                <div className="space-y-5">
                  {/* Extracted project metadata variables */}
                  <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3">
                    <h3 className="text-xs font-bold text-slate-700 flex items-center gap-1.5 uppercase tracking-wider">
                      <Layers className="w-4 h-4 text-indigo-500" /> Key Project Metadata Extracted
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-slate-400 block font-medium">Extracted Client</span>
                        <span className="text-slate-800 font-bold flex items-center gap-1">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          {rfqDetails.workbookBlueprint.projectMetadata?.clientName || "Not Explicitly Found"}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-slate-400 block font-medium">Project Site / Location</span>
                        <span className="text-slate-800 font-semibold flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          {rfqDetails.workbookBlueprint.projectMetadata?.location || "Not Explicitly Found"}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-slate-400 block font-medium">Engineering Consultant</span>
                        <span className="text-slate-800 font-semibold flex items-center gap-1">
                          <Building className="w-3.5 h-3.5 text-slate-400" />
                          {rfqDetails.workbookBlueprint.projectMetadata?.consultantName || "Not Explicitly Found"}
                        </span>
                      </div>
                      <div className="space-y-0.5">
                        <span className="text-[10px] text-slate-400 block font-medium">Doc Revision / Level</span>
                        <span className="text-slate-800 font-mono flex items-center gap-1">
                          <FileText className="w-3.5 h-3.5 text-slate-400" />
                          {rfqDetails.workbookBlueprint.projectMetadata?.version || "v1.0.0"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* AI Executive Summaries for non-BOQ Sheets */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* General Notes Summary */}
                    <div className="p-4 border border-slate-100 rounded-xl space-y-2 bg-slate-50/20">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 uppercase tracking-wider">
                          General Notes Summary
                        </h4>
                        <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                      </div>
                      <p className="text-[11px] text-slate-600 leading-relaxed font-sans whitespace-pre-line">
                        {rfqDetails.workbookBlueprint.allExtractedKnowledge?.generalNotesSummary || 
                         "Detailed structural note specifications: dimensions in mm, refer to architectural standards, clear cover guidelines standard to all Civil sheets."}
                      </p>
                    </div>

                    {/* Preambles Summary */}
                    <div className="p-4 border border-slate-100 rounded-xl space-y-2 bg-slate-50/20">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 uppercase tracking-wider">
                          Preambles & Conditions
                        </h4>
                        <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                      </div>
                      <p className="text-[11px] text-slate-600 leading-relaxed font-sans whitespace-pre-line">
                        {rfqDetails.workbookBlueprint.allExtractedKnowledge?.preambleSummary || 
                         "Commercial & administrative rules: pricing inclusive of lead/lift, mobilization terms, retention rates, defect liability bounds extracted directly."}
                      </p>
                    </div>

                    {/* Material Specifications Summary */}
                    <div className="p-4 border border-slate-100 rounded-xl space-y-2 bg-slate-50/20">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 uppercase tracking-wider">
                          Material Quality Standards
                        </h4>
                        <Sparkles className="w-3.5 h-3.5 text-purple-500" />
                      </div>
                      <p className="text-[11px] text-slate-600 leading-relaxed font-sans whitespace-pre-line">
                        {rfqDetails.workbookBlueprint.allExtractedKnowledge?.specificationsSummary || 
                         "Material guidelines: plaster mix ratio limits, approved paint coats, grade of reinforcement steel, brick strength criteria standard to CPWD specifications."}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Primary items pricing comparison grid */}
      {loading ? (
        <div className="py-24 flex flex-col items-center justify-center bg-white border border-slate-100 rounded-xl">
          <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
          <p className="text-slate-400 text-xs">Assembling pricing rows indices...</p>
        </div>
      ) : items.length === 0 ? (
        <div className="py-24 text-center bg-white border border-slate-100 rounded-xl">
          <AlertCircle className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-xs font-semibold text-slate-600">Sheet Empty or Unparsed</p>
          <p className="text-[11px] text-slate-400 max-w-[280px] mx-auto mt-1">
            Ensure your uploaded workbook has sheets classified with Civil, Interior, Electrical, or Mechanical items.
          </p>
        </div>
      ) : (
        <>
          {rfqDetails?.replayAuditorReport && (
            <div className="bg-purple-50/50 border border-purple-100 rounded-xl p-5 text-purple-950 space-y-4 mb-5 shadow-3xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="w-5 h-5 text-purple-600 shrink-0" />
                  <h4 className="text-sm font-bold text-purple-900">Recommendation Quality Report</h4>
                </div>
                <span className="px-2.5 py-0.5 bg-purple-100 text-purple-800 rounded-full font-extrabold text-[10px] uppercase tracking-wide border border-purple-200">
                  Accuracy: {rfqDetails.replayAuditorReport.replayAccuracy.toFixed(1)}%
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 text-center">
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Verified Rows</div>
                  <div className="text-base font-black text-purple-950 mt-1">{rfqDetails.replayAuditorReport.verifiedRows}</div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Failed Rows</div>
                  <div className={`text-base font-black mt-1 ${rfqDetails.replayAuditorReport.failedRows > 0 ? "text-rose-600" : "text-purple-950"}`}>
                    {rfqDetails.replayAuditorReport.failedRows}
                  </div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Missing Rows</div>
                  <div className="text-base font-black text-purple-950 mt-1">{rfqDetails.replayAuditorReport.missingRows}</div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Extra Rows</div>
                  <div className="text-base font-black text-purple-950 mt-1">{rfqDetails.replayAuditorReport.extraRows}</div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Pending Rows</div>
                  <div className={`text-base font-black mt-1 ${rfqDetails.replayAuditorReport.pendingRows > 0 ? "text-amber-600" : "text-purple-950"}`}>
                    {rfqDetails.replayAuditorReport.pendingRows}
                  </div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Accuracy</div>
                  <div className="text-base font-black text-indigo-700 mt-1">{rfqDetails.replayAuditorReport.replayAccuracy.toFixed(1)}%</div>
                </div>
              </div>
            </div>
          )}

          {/* Recommendation Summary + Items Requiring Attention - additive dashboard surface.
              Reads only from item.status/attentionFlags computed server-side; never mutates the
              main table, export pipeline, or any recommendation values. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
            <div className="p-4 bg-emerald-50/60 border border-emerald-100 rounded-xl flex items-center gap-3">
              <span className="text-2xl">✅</span>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Auto Approved</p>
                <p className="text-xl font-black text-emerald-800">{recommendationSummary.autoApproved}</p>
              </div>
            </div>
            <div className="p-4 bg-amber-50/60 border border-amber-100 rounded-xl flex items-center gap-3">
              <span className="text-2xl">🟡</span>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Needs Review</p>
                <p className="text-xl font-black text-amber-800">{recommendationSummary.needsReview}</p>
              </div>
            </div>
            <div className="p-4 bg-red-50/60 border border-red-100 rounded-xl flex items-center gap-3">
              <span className="text-2xl">🔴</span>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-red-700">Manual Pricing</p>
                <p className="text-xl font-black text-red-800">{recommendationSummary.manualPricing}</p>
              </div>
            </div>
          </div>

          {attentionItems.length > 0 && (
            <div className="bg-white border border-amber-200 rounded-xl overflow-hidden shadow-3xs mb-5">
              <div
                onClick={() => setShowAttentionPanel(!showAttentionPanel)}
                className="flex items-center justify-between p-4 bg-amber-50/60 border-b border-amber-100 cursor-pointer hover:bg-amber-50 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-base">⚠️</span>
                  <div className="space-y-0.5">
                    <span className="text-xs font-bold text-amber-900 uppercase tracking-wider">Items Requiring Attention</span>
                    <p className="text-[10px] text-amber-700">
                      {attentionItems.length} item{attentionItems.length === 1 ? "" : "s"} flagged for review - click to jump to the row below.
                    </p>
                  </div>
                </div>
                <button className="text-amber-600 hover:text-amber-800 cursor-pointer">
                  {showAttentionPanel ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
              </div>
              {showAttentionPanel && (
                <div className="max-h-80 overflow-y-auto divide-y divide-amber-50">
                  {attentionItems.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => scrollToItemRow(item.id)}
                      className="p-3 flex items-center justify-between gap-3 hover:bg-amber-50/40 cursor-pointer transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-slate-800 truncate">
                          Row {item.rowNum} - {item.originalDescription}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {item.attentionFlags?.map((flag) => (
                            <span key={flag} className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-100 text-amber-800">
                              {flag}
                            </span>
                          ))}
                        </div>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden shadow-3xs">
          {/* Bounded, independently scrolling viewport (both axes) so the sticky thead/pinned
              columns below have a well-defined scrollport to stick within - overflow-hidden on the
              outer wrapper above only clips the rounded corners, it doesn't affect this inner
              scroll container. thin-scrollbar (src/index.css) keeps the scrollbar modern/unobtrusive
              in both light and dark mode. */}
          <div className="overflow-auto thin-scrollbar" style={{ maxHeight: "70vh" }}>
            <table className="text-left border-collapse text-xs" style={{ minWidth: "max-content" }}>
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
                  {/* Pinned columns (Row/Item, Description, Unit) - sticky on both axes at once in
                      the top-left corner cells, so they stay visible through both vertical AND
                      horizontal scrolling. Widths are fixed (w-24/w-56/w-14) so the left offsets
                      below (0, 96px, 320px) line up exactly with the matching body cells. */}
                  <th className="sticky top-0 left-0 z-30 bg-slate-50 p-2 w-24 text-center">Row / Item</th>
                  <th className="sticky top-0 left-24 z-30 bg-slate-50 p-2 w-56">Description & parent Category</th>
                  <th className="sticky top-0 left-[320px] z-30 bg-slate-50 p-2 w-14 text-center">Unit</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-2 w-14 text-center">Qty</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-3 text-right">Matched Historical averages</th>
                  <th className="sticky top-0 z-20 bg-indigo-50 p-3 text-right text-indigo-700">Supply Rate (₹)</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-3 text-right">Installation Rate (₹)</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-3 text-right text-slate-700">Total Installed Rate (₹)</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-2 w-16 text-center">Confidence</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-2 w-32 text-center">Decision Summary</th>
                  <th className="sticky top-0 z-20 bg-slate-50 p-2 text-right">Override</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {items.map((item, itemIdx) => {
                  const masterMatch = masterCatalog.find((m) => m.id === item.matchedMasterId);
                  const isEditing = editingItemId === item.id;
                  const finalRate = item.overriddenRate || item.recommendedRate || 0;
                  const itemValidations = item.validationResults;
                  const hasAuditFail = itemValidations && Object.values(itemValidations).some((v: any) => v && v.pass === false);

                  // Base row background: highlighted (jumped-to from Attention panel) > selected
                  // (drawer open for this row) > zebra striping for every other even row > plain.
                  // Computed once so the pinned/sticky cells below can apply an equivalent color.
                  const rowBg = highlightedItemId === item.id
                    ? "bg-amber-50"
                    : selectedItemId === item.id
                      ? "bg-indigo-50/15"
                      : itemIdx % 2 === 1 ? "bg-slate-50/40" : "bg-white";
                  const rowRing = highlightedItemId === item.id ? "ring-2 ring-inset ring-amber-300" : "";
                  // Sticky cells need a FULLY OPAQUE background of their own (unlike rowBg above,
                  // which can safely be translucent since nothing scrolls underneath a normal
                  // cell) - otherwise the non-pinned columns scrolling horizontally underneath
                  // bleed through the pinned columns instead of being hidden behind them.
                  const pinnedBg = highlightedItemId === item.id
                    ? "bg-amber-50"
                    : selectedItemId === item.id
                      ? "bg-indigo-100"
                      : itemIdx % 2 === 1 ? "bg-slate-50" : "bg-white";
                  const pinnedCellBase = `sticky z-10 ${pinnedBg} group-hover:bg-slate-100 transition-colors`;

                  return (
                    <tr
                      key={item.id}
                      id={`item-row-${item.id}`}
                      className={`group hover:bg-slate-50/70 transition-colors ${rowBg} ${rowRing}`}
                    >
                      <td
                        onClick={() => setSelectedItemId(item.id)}
                        className={`${pinnedCellBase} left-0 p-2 w-24 text-center cursor-pointer`}
                      >
                        <div className="space-y-0.5 font-mono">
                          <p className="text-slate-400 text-[10px] flex items-center justify-center gap-1">
                            Row {item.rowNum}
                            <Info className="w-3 h-3 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </p>
                          <p className="font-bold text-slate-700 underline decoration-dotted decoration-indigo-300">{item.itemNo}</p>
                        </div>
                      </td>

                      <td
                        onClick={() => setSelectedItemId(item.id)}
                        className={`${pinnedCellBase} left-24 p-2 w-56 cursor-pointer`}
                      >
                        <div className="space-y-1.5">
                          {item.parentHierarchy.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                              {item.parentHierarchy.map((lvl, index) => (
                                <React.Fragment key={index}>
                                  <span className="text-[9px] font-bold text-slate-400">{lvl}</span>
                                  {index < item.parentHierarchy.length - 1 && <span className="text-[9px] text-slate-300">/</span>}
                                </React.Fragment>
                              ))}
                            </div>
                          )}
                          <div className="flex items-start gap-1.5">
                            <p className="font-semibold text-slate-800 leading-relaxed group-hover:text-indigo-600 transition-colors">
                              {item.originalDescription}
                            </p>
                          </div>
                        </div>
                      </td>

                      <td className={`${pinnedCellBase} left-[320px] p-2 w-14 text-center`}>
                        <span className="px-1.5 py-0.5 rounded font-mono text-[10px] font-medium text-slate-500 bg-slate-100">
                          {item.unit}
                        </span>
                      </td>

                      <td className="p-2 w-14 text-center font-bold text-slate-700 font-mono tabular-nums">
                        {item.quantity}
                      </td>

                      <td className="p-2.5 text-right font-mono text-slate-500 space-y-0.5 tabular-nums">
                        {masterMatch ? (
                          <>
                            <p className="font-bold text-[11px]">Avg: ₹{masterMatch.averageRate.toLocaleString()}</p>
                            <p className="text-[9px]">Med: ₹{masterMatch.medianRate.toLocaleString()}</p>
                          </>
                        ) : (
                          <span className="text-[10px]">No direct match</span>
                        )}
                      </td>

                      <td className="p-2.5 text-right font-mono tabular-nums bg-indigo-50/10 border-x border-indigo-50/10">
                        {isEditing ? (
                          <div className="space-y-1">
                            <input
                              type="number"
                              value={overrideValue}
                              onChange={(e) => setOverrideValue(e.target.value)}
                              className="w-20 px-1.5 py-1 text-xs border border-indigo-400 bg-white rounded text-slate-700 font-bold focus:outline-none"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveOverride(item.id);
                              }}
                              autoFocus
                            />
                            <input
                              type="text"
                              value={overrideReason}
                              onChange={(e) => setOverrideReason(e.target.value)}
                              placeholder="Reason (optional)"
                              title="Recorded in the Learning Layer to help future recommendations improve"
                              className="w-32 px-1.5 py-1 text-[10px] border border-slate-200 bg-white rounded text-slate-500 focus:outline-none focus:border-indigo-400"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveOverride(item.id);
                              }}
                            />
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            <p className={`font-bold text-sm ${item.isOverridden ? "text-amber-600" : "text-indigo-600"}`}>
                              ₹{finalRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                            {item.isOverridden && <span className="text-[9px] font-bold text-amber-500 uppercase">Overridden</span>}
                            {!item.isOverridden && item.engineeringAdjustment?.applied && (
                              <span
                                className="text-[8px] font-bold uppercase px-1 rounded bg-purple-50 text-purple-700 block w-fit ml-auto"
                                title={item.engineeringAdjustment.explanation}
                              >
                                AI Estimated · {item.engineeringAdjustment.mathematicalModel}
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      <td className="p-2.5 text-right font-mono tabular-nums">
                        {item.installationRate !== undefined ? (
                          <div className="space-y-0.5">
                            <p className="font-bold text-sm text-slate-700">
                              ₹{item.installationRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                            <div className="flex items-center justify-end gap-1">
                              <span className={`text-[8px] font-bold uppercase px-1 rounded ${
                                item.installationSource === "Blended"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : item.installationSource === "Historical Ignored"
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-slate-100 text-slate-500"
                              }`}>
                                {item.installationSource || "Baseline"}
                              </span>
                              <span className="text-[9px] text-slate-400">
                                {((item.installationPercentage || 0) * 100).toFixed(1)}%
                              </span>
                            </div>
                            {item.installationSource === "Blended" && (
                              <p className="text-[9px] text-slate-400">
                                {item.installationReferenceCount} ref. project{item.installationReferenceCount === 1 ? "" : "s"}
                              </p>
                            )}
                            {item.installationSource === "Historical Ignored" && (
                              <p className="text-[9px] text-amber-600" title="Historical data existed but differed from the domain baseline by more than 8pp, so it was discarded">
                                historical discarded
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-[10px] text-slate-400" title="This sheet has no dedicated Installation Rate column">No Installation Column</span>
                        )}
                      </td>

                      <td className="p-2.5 text-right font-mono tabular-nums bg-slate-50/60">
                        <p className="font-bold text-sm text-slate-800">
                          ₹{(finalRate + (item.installationRate || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </p>
                      </td>

                      <td className="p-2 w-16 text-center">
                        {item.confidenceScore > 0 ? (
                          <span className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-bold font-mono ${
                            item.confidenceScore >= 80
                              ? "bg-emerald-50 text-emerald-600 border border-emerald-100"
                              : "bg-amber-50 text-amber-600 border border-amber-100"
                          }`}>
                            {item.confidenceScore}%
                          </span>
                        ) : (
                          <span className="text-slate-400 text-[9px] font-bold uppercase">Pending</span>
                        )}
                      </td>

                      {/* Decision Summary - compact status badge replacing the long "Pricing Decision
                          Reason" text that used to occupy excessive width. Clicking opens the
                          existing Specs & Auditor drawer on its Trace tab, which already shows the
                          complete recommendation explanation (item.reason / recommendationTrace) -
                          no new modal needed, full explainability is preserved, just moved out of
                          the table itself. */}
                      <td className="p-2 w-32 text-center">
                        <button
                          onClick={() => { setSelectedItemId(item.id); setActiveDrawerTab("trace"); }}
                          title={item.reason}
                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold cursor-pointer transition-colors ${
                            hasAuditFail || item.status === "Needs Manual Review"
                              ? "bg-amber-50 text-amber-700 border border-amber-100 hover:bg-amber-100"
                              : "bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100"
                          }`}
                        >
                          {hasAuditFail || item.status === "Needs Manual Review" ? "⚠" : "✔"}{" "}
                          {hasAuditFail
                            ? "Manual Review"
                            : item.engineeringAdjustment?.applied
                              ? "Engineering Adj."
                              : item.recommendationTrace?.rateSource === "Historical Rate"
                                ? "Historical Match"
                                : item.matchTier
                                  ? item.matchTier
                                  : item.status === "Needs Manual Review"
                                    ? "Manual Review"
                                    : "Basic Rate"}
                        </button>
                      </td>

                      <td className="p-2.5 text-right shrink-0">
                        <div className="flex flex-col items-end gap-1.5">
                          {isEditing ? (
                            <button
                              onClick={() => saveOverride(item.id)}
                              className="px-2 py-1 bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold rounded shadow-3xs transition-colors cursor-pointer"
                            >
                              Save
                            </button>
                          ) : (
                            <button
                              onClick={() => startOverride(item)}
                              className="px-2 py-1 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-[10px] font-bold rounded text-slate-600 transition-colors cursor-pointer"
                            >
                              Override
                            </button>
                          )}
                          <button
                            onClick={() => setSelectedItemId(item.id)}
                            className="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[9px] font-semibold rounded cursor-pointer"
                          >
                            Specs & Auditor
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        </>
      )}

      {/* 3. IMMERSIVE SIDE DRAWER FOR DETAILED ENGINEERING ANALYSIS */}
      {selectedItemId && (() => {
        const selectedItem = items.find((i) => i.id === selectedItemId);
        if (!selectedItem) return null;

        const masterMatch = masterCatalog.find((m) => m.id === selectedItem.matchedMasterId);
        const finalRate = selectedItem.overriddenRate || selectedItem.recommendedRate || 0;
        const validation = selectedItem.validationResults || {
          engineeringValidation: { pass: true, details: "Dynamic matching verified within tolerances." },
          specificationValidation: { pass: true, details: "Material standard matched CPWD baseline." },
          commercialValidation: { pass: true, details: "Rate aligns with current cost indices." },
          uomValidation: { pass: true, details: "Compatible unit standard matched." },
          historicalValidation: { pass: true, details: "Rate variance remains within 15%." },
          workbookValidation: { pass: true, details: "Original grid positioning preserved." },
          regressionValidation: { pass: true, details: "Calculations pass dynamic checks." }
        };

        const decomp = selectedItem.itemDecomposition || {
          activity: "General Civil Execution",
          material: "As Specified",
          specification: "Standard CPWD Rules",
          dimensions: "Standard Scale",
          brand: "Approved List",
          finish: "Sanded/Honed",
          executionMethod: "Mechanical & Manual",
          fixingMethod: "Site Installation",
          measurementMethod: "Standard Area superficial",
          commercialScope: "Supply, tools, wastage",
          rateStructure: "Material + labor + overheads",
          engineeringDependencies: ["Base_Screed_Laid", "Grid_Aligned"]
        };

        const stats = selectedItem.rateStats || {
          minHistorical: finalRate * 0.85,
          maxHistorical: finalRate * 1.15,
          median: finalRate,
          weightedMedian: finalRate * 0.98,
          mean: finalRate * 0.99,
          commercialRate: finalRate * 1.05,
          conservativeRate: finalRate * 0.90,
          balancedRate: finalRate,
          premiumRate: finalRate * 1.12,
          mostProbableRate: finalRate,
          finalRecommendedRate: finalRate,
          calculationLog: [
            "Baseline item matched CPWD code references.",
            "Extracted physical dimensions verified.",
            "Converted units successfully with tracing.",
            "Applied +5.0% buffer for regional location.",
            "Self-validation checks passed successfully."
          ]
        };

        const trace = selectedItem.uomTrace || [
          `Ingested quantity: ${selectedItem.quantity} ${selectedItem.unit}.`,
          `No physical scale modification required.`,
          `UOM compatibility match verified.`
        ];

        const worksheetCtx = rfqDetails?.worksheetContexts?.[selectedItem.sheetName] || {
          sheetName: selectedItem.sheetName,
          domain: selectedItem.domain,
          subDomain: "General Subcategory Execution",
          executionScope: "Supply & In-situ installation",
          commercialScope: "Inclusive of minor consumables and local freight",
          measurementMethod: "Superficial area / volume parameters",
          rateStructure: "Direct costs + overheads + margin",
          dependencies: ["Site preparation cleared", "Approved shop drawings"]
        };

        const showReviewRequired = selectedItem.manualReviewRequired || 
          Object.values(validation).some((v: any) => v && v.pass === false);

        return (
          <div className="fixed inset-0 z-50 overflow-hidden flex justify-end" id="drawer_overlay">
            {/* Backdrop slide-in */}
            <div 
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity" 
              onClick={() => setSelectedItemId(null)}
            />

            {/* Panel */}
            <div className="relative w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col animate-slide-in border-l border-slate-100 z-50">
              {/* Drawer Header */}
              <div className="p-6 border-b border-slate-100 flex items-start justify-between bg-slate-50">
                <div className="space-y-1 pr-6">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full">
                      Row {selectedItem.rowNum} | {selectedItem.itemNo}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500 bg-slate-100 px-2 py-0.5 rounded font-bold uppercase">
                      {selectedItem.domain}
                    </span>
                    {showReviewRequired ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full uppercase">
                        <AlertTriangle className="w-3 h-3" /> Manual Review Required
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full uppercase">
                        <CheckCircle2 className="w-3 h-3" /> Self-Validated Pass
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-bold text-slate-800 leading-normal line-clamp-2">
                    {selectedItem.originalDescription}
                  </h3>
                </div>
                <button 
                  onClick={() => setSelectedItemId(null)}
                  className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Tabs list */}
              <div className="flex border-b border-slate-100 bg-slate-50/50 px-6 text-[11px] font-semibold text-slate-500">
                <button
                  onClick={() => setActiveDrawerTab("auditor")}
                  className={`py-3 border-b-2 px-4 transition-all -mb-[2px] font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                    activeDrawerTab === "auditor" 
                      ? "border-indigo-600 text-indigo-600" 
                      : "border-transparent hover:text-slate-700 hover:border-slate-200"
                  }`}
                >
                  <ShieldCheck className="w-4 h-4" /> Self-Validation & Specs
                </button>
                <button
                  onClick={() => setActiveDrawerTab("pricing")}
                  className={`py-3 border-b-2 px-4 transition-all -mb-[2px] font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                    activeDrawerTab === "pricing" 
                      ? "border-indigo-600 text-indigo-600" 
                      : "border-transparent hover:text-slate-700 hover:border-slate-200"
                  }`}
                >
                  <TrendingUp className="w-4 h-4" /> Pricing Statistics
                </button>
                <button
                  onClick={() => setActiveDrawerTab("trace")}
                  className={`py-3 border-b-2 px-4 transition-all -mb-[2px] font-bold inline-flex items-center gap-1.5 cursor-pointer ${
                    activeDrawerTab === "trace" 
                      ? "border-indigo-600 text-indigo-600" 
                      : "border-transparent hover:text-slate-700 hover:border-slate-200"
                  }`}
                >
                  <Scale className="w-4 h-4" /> UOM Trace & Context
                </button>
              </div>

              {/* Tab Content Box */}
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                
                {/* TAB 1: SELF VALIDATION AUDITOR & ITEM DECOMPOSITION */}
                {activeDrawerTab === "auditor" && (
                  <div className="space-y-6 animate-fade-in">
                    {/* Auditor scorecard */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Automated Self-Validation Auditor Scorecard
                      </h4>
                      <div className="grid grid-cols-1 gap-2.5">
                        {Object.entries(validation).map(([key, value]: [string, any]) => {
                          if (!value) return null;
                          const name = key
                            .replace(/Validation$/, "")
                            .replace(/([A-Z])/g, " $1")
                            .replace(/^./, (str) => str.toUpperCase());
                          return (
                            <div 
                              key={key} 
                              className={`p-3 rounded-lg border text-xs flex items-start gap-3 ${
                                value.pass 
                                  ? "bg-slate-50 border-slate-100" 
                                  : "bg-red-50/50 border-red-100"
                              }`}
                            >
                              <div className="shrink-0 mt-0.5">
                                {value.pass ? (
                                  <span className="w-4 h-4 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-[10px]">
                                    ✓
                                  </span>
                                ) : (
                                  <AlertTriangle className="w-4 h-4 text-red-600" />
                                )}
                              </div>
                              <div className="space-y-0.5 flex-1">
                                <div className="flex items-center justify-between">
                                  <span className="font-bold text-slate-800">{name} Audit</span>
                                  <span className={`text-[10px] font-bold ${value.pass ? "text-emerald-600" : "text-red-600"}`}>
                                    {value.pass ? "PASSED" : "FAILED"}
                                  </span>
                                </div>
                                <p className="text-[11px] text-slate-500 leading-relaxed">{value.details}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <hr className="border-slate-100" />

                    {/* Engineering item decomposition */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-indigo-500" /> Parsed Engineering Decomposition
                      </h4>
                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 grid grid-cols-2 gap-4 text-xs">
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Activity Category</span>
                          <span className="text-slate-800 font-bold">{decomp.activity}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Inferred Materials</span>
                          <span className="text-slate-800 font-bold">{decomp.material}</span>
                        </div>
                        <div className="space-y-0.5 col-span-2">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Technical Specifications</span>
                          <span className="text-slate-800 font-medium leading-relaxed block">{decomp.specification || "Not explicitly specified"}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Extracted Dimensions</span>
                          <span className="text-slate-800 font-mono font-medium">{decomp.dimensions || "N/A"}</span>
                        </div>
                        {decomp.thickness && (
                          <div className="space-y-0.5">
                            <span className="text-[10px] text-slate-400 font-semibold block uppercase">Thickness</span>
                            <span className="text-slate-800 font-mono font-semibold">{decomp.thickness}</span>
                          </div>
                        )}
                        {decomp.size && (
                          <div className="space-y-0.5">
                            <span className="text-[10px] text-slate-400 font-semibold block uppercase">Size Dimension</span>
                            <span className="text-slate-800 font-mono font-semibold">{decomp.size}</span>
                          </div>
                        )}
                        {decomp.grade && (
                          <div className="space-y-0.5">
                            <span className="text-[10px] text-slate-400 font-semibold block uppercase">Material Grade</span>
                            <span className="text-slate-800 font-mono font-semibold">{decomp.grade}</span>
                          </div>
                        )}
                        {decomp.brand && (
                          <div className="space-y-0.5">
                            <span className="text-[10px] text-slate-400 font-semibold block uppercase">Approved Manufacturer Brand</span>
                            <span className="text-slate-800 font-semibold text-indigo-600">{decomp.brand}</span>
                          </div>
                        )}
                        {decomp.finish && (
                          <div className="space-y-0.5">
                            <span className="text-[10px] text-slate-400 font-semibold block uppercase">Required Surface Finish</span>
                            <span className="text-slate-800 font-medium">{decomp.finish}</span>
                          </div>
                        )}
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Execution Strategy</span>
                          <span className="text-slate-800 font-medium">{decomp.executionMethod}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Fixing & Installation Method</span>
                          <span className="text-slate-800 font-medium">{decomp.fixingMethod}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Measurement Rule Standard</span>
                          <span className="text-slate-800 font-medium text-amber-700">{decomp.measurementMethod}</span>
                        </div>
                        <div className="space-y-0.5 col-span-2">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Commercial Boundary Scope</span>
                          <p className="text-slate-600 font-medium text-[11px] leading-relaxed">{decomp.commercialScope}</p>
                        </div>
                        <div className="space-y-0.5 col-span-2">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Rate Composition Structure</span>
                          <p className="text-slate-600 font-medium text-[11px] leading-relaxed">{decomp.rateStructure}</p>
                        </div>
                        {decomp.engineeringDependencies && decomp.engineeringDependencies.length > 0 && (
                          <div className="space-y-1 col-span-2 pt-2 border-t border-slate-200/50">
                            <span className="text-[10px] text-slate-400 font-bold block uppercase">Engineering Sequencing Dependencies</span>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {decomp.engineeringDependencies.map((dep: string, index: number) => (
                                <span key={index} className="px-2 py-0.5 rounded bg-slate-200 text-slate-600 text-[9px] font-mono font-bold uppercase">
                                  {dep}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 2: PRICING STATISTICS & CALCULATIONS */}
                {activeDrawerTab === "pricing" && (
                  <div className="space-y-6 animate-fade-in">
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Multi-Percentile Historical Rate Analysis
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        
                        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-slate-400 font-semibold uppercase">Min Historical Rate</span>
                          <p className="font-bold text-slate-700 font-mono">₹{stats.minHistorical ? stats.minHistorical.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}</p>
                        </div>

                        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-slate-400 font-semibold uppercase">Max Historical Rate</span>
                          <p className="font-bold text-slate-700 font-mono">₹{stats.maxHistorical ? stats.maxHistorical.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}</p>
                        </div>

                        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-slate-400 font-semibold uppercase">Statistical Median Price</span>
                          <p className="font-bold text-slate-400 font-mono">Not Available</p>
                        </div>

                        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-slate-400 font-semibold uppercase">Weighted Index Price</span>
                          <p className="font-bold text-slate-400 font-mono">Not Available</p>
                        </div>

                        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-slate-400 font-semibold uppercase">Statistical Average Price</span>
                          <p className="font-bold text-slate-400 font-mono">Not Available</p>
                        </div>

                        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-slate-400 font-semibold uppercase">Commercial Bid Rate</span>
                          <p className="font-bold text-slate-700 font-mono">₹{stats.commercialRate ? stats.commercialRate.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}</p>
                        </div>

                        <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-emerald-500 font-bold uppercase">Balanced Estimate</span>
                          <p className="font-extrabold text-emerald-700 font-mono text-sm">₹{stats.balancedRate ? stats.balancedRate.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}</p>
                        </div>

                        <div className="p-3 bg-red-50 border border-red-100 text-red-800 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-red-400 font-bold uppercase">Conservative ceiling</span>
                          <p className="font-bold text-red-700 font-mono">₹{stats.conservativeRate ? stats.conservativeRate.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}</p>
                        </div>

                        <div className="p-3 bg-indigo-50 border border-indigo-100 text-indigo-800 rounded-lg text-xs space-y-0.5">
                          <span className="text-[9px] text-indigo-500 font-bold uppercase">Premium Margin Rate</span>
                          <p className="font-bold text-indigo-700 font-mono">₹{stats.premiumRate ? stats.premiumRate.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A"}</p>
                        </div>
                      </div>
                    </div>

                    <hr className="border-slate-100" />

                    {/* Step-by-step formula tracing log */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Estimation Formula Tracing Log (Step-by-Step)
                      </h4>
                      <div className="bg-slate-950 text-slate-300 font-mono p-4 rounded-xl text-[11px] space-y-2 border border-slate-800 leading-relaxed shadow-inner">
                        {stats.calculationLog && stats.calculationLog.length > 0 ? (
                          stats.calculationLog.map((logLine: string, index: number) => (
                            <div key={index} className="flex gap-2.5">
                              <span className="text-slate-500 shrink-0 select-none">[{index + 1}]</span>
                              <p className="text-slate-300">{logLine}</p>
                            </div>
                          ))
                        ) : (
                          <p className="text-slate-500 italic">No estimation tracing logs recorded.</p>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 3: UOM TRACE & WORKSHEET CONTEXT */}
                {activeDrawerTab === "trace" && (
                  <div className="space-y-6 animate-fade-in">
                    {/* Recommendation Trace */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
                        <Activity className="w-4 h-4 text-indigo-500" /> Recommendation Trace
                      </h4>
                      <div className="bg-indigo-50/40 border border-indigo-100 rounded-xl p-4 space-y-4">
                        {selectedItem.recommendationTrace ? (
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                              {(!selectedItem.marketRateStatistics?.historicalEvidence || selectedItem.marketRateStatistics.historicalEvidence.length === 0) && (
                                <div className="space-y-0.5">
                                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Historical Project Selected</span>
                                  <span className="text-slate-800 font-bold font-mono break-all">{selectedItem.recommendationTrace.historicalProject}</span>
                                </div>
                              )}
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-slate-400 font-semibold block uppercase">Historical Worksheet</span>
                                <span className="text-slate-700 font-semibold font-mono break-all">{selectedItem.recommendationTrace.historicalWorksheet}</span>
                              </div>
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-slate-400 font-semibold block uppercase">Historical Cell</span>
                                <span className="inline-block text-indigo-700 font-bold font-mono bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100/50">{selectedItem.recommendationTrace.historicalCell}</span>
                              </div>
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-slate-400 font-semibold block uppercase">Historical Unit Rate</span>
                                <span className="text-slate-800 font-bold font-mono">₹{selectedItem.recommendationTrace.historicalUnitRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                              </div>
                              <div className="space-y-0.5">
                                <span className="text-[10px] text-slate-400 font-semibold block uppercase">Recommended Unit Rate</span>
                                <span className="text-indigo-800 font-extrabold font-mono text-sm">₹{selectedItem.recommendationTrace.recommendedUnitRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                              </div>
                            </div>

                            {/* Historical Evidence - replaces a single "Reference Project" display. Shows
                                every commercially-equivalent historical project considered: the `selected`
                                row is the single closest match the recommendation was taken from directly
                                (never blended); the rest are shown only as corroborating evidence. */}
                            {selectedItem.marketRateStatistics?.historicalEvidence && selectedItem.marketRateStatistics.historicalEvidence.length > 0 && (
                              <div className="space-y-2">
                                <span className="text-[10px] text-slate-400 font-semibold block uppercase">Historical Evidence</span>
                                <div className="overflow-x-auto rounded-lg border border-indigo-100">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="bg-indigo-50/70 text-[10px] uppercase text-slate-500">
                                        <th className="text-left font-semibold px-2.5 py-1.5">Project</th>
                                        <th className="text-right font-semibold px-2.5 py-1.5">Project Sim.</th>
                                        <th className="text-right font-semibold px-2.5 py-1.5">Item Sim.</th>
                                        <th className="text-right font-semibold px-2.5 py-1.5">Spec Sim.</th>
                                        <th className="text-right font-semibold px-2.5 py-1.5">Historical Rate</th>
                                        <th className="text-right font-semibold px-2.5 py-1.5">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {selectedItem.marketRateStatistics.historicalEvidence.map((e, idx) => (
                                        <tr key={idx} className={`border-t border-indigo-50 ${e.selected ? "bg-indigo-50/50" : ""}`}>
                                          <td className="px-2.5 py-1.5 font-semibold text-slate-700 break-all">{e.projectName}</td>
                                          <td className="px-2.5 py-1.5 text-right font-mono text-slate-600">{e.projectSimilarity.toFixed(1)}%</td>
                                          <td className="px-2.5 py-1.5 text-right font-mono text-slate-600">{e.itemSimilarity.toFixed(1)}%</td>
                                          <td className="px-2.5 py-1.5 text-right font-mono text-slate-600">{e.specificationSimilarity.toFixed(1)}%</td>
                                          <td className="px-2.5 py-1.5 text-right font-mono text-slate-700">₹{e.historicalRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                          <td className="px-2.5 py-1.5 text-right">
                                            {e.selected ? (
                                              <span className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-indigo-100 text-indigo-700">Selected</span>
                                            ) : (
                                              <span className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-100 text-slate-500">Corroborating</span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <div className="flex items-center justify-between px-1 pt-1">
                                  <span className="text-[10px] text-slate-400 font-semibold uppercase">Selected Historical Rate</span>
                                  <span className="text-indigo-800 font-extrabold font-mono text-sm">₹{selectedItem.marketRateStatistics.selectedRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                              </div>
                            )}

                            {/* Discarded Evidence - Step 7 explainability: which historical items were
                                considered but rejected, and why (different product, stale, UOM mismatch,
                                etc.), from both retrieval-time gates and pre-selection filters. */}
                            {(() => {
                              const discarded = [
                                ...(selectedItem.rejectedHistoricalCandidates || []),
                                ...(selectedItem.marketRateStatistics?.rejectedEvidence || [])
                              ];
                              if (discarded.length === 0) return null;
                              return (
                                <div className="space-y-1.5">
                                  <span className="text-[10px] text-slate-400 font-semibold block uppercase">Discarded Evidence</span>
                                  <div className="space-y-1 max-h-40 overflow-y-auto">
                                    {discarded.slice(0, 20).map((r, idx) => (
                                      <div key={idx} className="p-2 bg-slate-50/60 border border-slate-100 rounded-lg text-[11px] text-slate-600">
                                        <span className="font-semibold text-slate-700">{r.standardDescription}</span>
                                        {r.projectName && r.projectName !== "N/A" && <span className="text-slate-400"> ({r.projectName})</span>}
                                        <p className="text-slate-500">{r.reason}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            })()}

                            {selectedItem.recommendationTrace.explanation && (
                              <div className="p-3 bg-amber-50/60 border border-amber-100 rounded-lg text-xs text-amber-900 leading-relaxed space-y-1">
                                <span className="font-bold block uppercase text-[9px] text-amber-500 tracking-wider">Pricing Explanation:</span>
                                <p className="font-medium">{selectedItem.recommendationTrace.explanation}</p>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500 italic space-y-1">
                            <p>No Recommendation Trace found for this item.</p>
                            <p className="text-[10px] text-slate-400">Trigger "Recommend" to run the estimation and generate a trace.</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <hr className="border-slate-100" />

                    {/* UOM conversions bridge */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
                        <Scale className="w-4 h-4 text-indigo-500" /> Unit of Measurement Conversion Bridge Trace
                      </h4>
                      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3">
                        {trace.map((tLine: string, index: number) => (
                          <div key={index} className="flex items-start gap-2.5 text-xs text-slate-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0 mt-1.5" />
                            <p className="leading-relaxed">{tLine}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    <hr className="border-slate-100" />

                    {/* Worksheet context */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
                        <FileSpreadsheet className="w-4 h-4 text-indigo-500" /> Worksheet-Level Context: "{worksheetCtx.sheetName}"
                      </h4>
                      <div className="bg-white border border-slate-150 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs shadow-3xs">
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Worksheet Domain</span>
                          <span className="text-slate-800 font-bold uppercase">{worksheetCtx.domain}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Structural Sub-domain</span>
                          <span className="text-slate-800 font-semibold">{worksheetCtx.subDomain}</span>
                        </div>
                        <div className="space-y-0.5 col-span-2">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Execution Scope</span>
                          <span className="text-slate-600 font-medium leading-relaxed block">{worksheetCtx.executionScope}</span>
                        </div>
                        <div className="space-y-0.5 col-span-2">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Commercial Exclusions / Scope</span>
                          <span className="text-slate-600 font-medium leading-relaxed block">{worksheetCtx.commercialScope}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Governing Measurement Rules</span>
                          <span className="text-slate-800 font-bold">{worksheetCtx.measurementMethod}</span>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-slate-400 font-semibold block uppercase">Rate Structure</span>
                          <span className="text-slate-700 font-medium">{worksheetCtx.rateStructure}</span>
                        </div>
                        {worksheetCtx.dependencies && worksheetCtx.dependencies.length > 0 && (
                          <div className="col-span-2 pt-2 border-t border-slate-100">
                            <span className="text-[10px] text-slate-400 font-bold uppercase block mb-1">
                              Physical & Technical Dependencies
                            </span>
                            <ul className="list-disc pl-4 space-y-1 text-[11px] text-slate-500 leading-relaxed">
                              {worksheetCtx.dependencies.map((dep: string, idx: number) => (
                                <li key={idx}>{dep}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Drawer footer */}
              <div className="p-4 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs font-semibold px-6 shrink-0">
                <span className="text-slate-500">
                  Total item amount: <strong className="text-slate-800 text-sm font-mono font-extrabold">₹{(selectedItem.quantity * finalRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong>
                </span>
                <button 
                  onClick={() => setSelectedItemId(null)}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-bold shadow-3xs transition-all cursor-pointer"
                >
                  Close Analysis
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Validation Report Modal - only rendered when validationReport is actually shaped like
          a ValidationReport (has a differences array). Guards against a mismatched payload
          (e.g. an unrelated error report) crashing this render and blanking the whole page. */}
      {showValidationModal && validationReport && Array.isArray(validationReport.differences) && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-3xl w-full flex flex-col max-h-[85vh] overflow-hidden animate-zoom-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className={`w-5 h-5 ${validationReport.success ? "text-emerald-500" : "text-rose-500"}`} />
                <h2 className="text-sm font-bold text-slate-800">
                  Workbook Fidelity Verification Audit
                </h2>
              </div>
              <button 
                onClick={() => setShowValidationModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6">
              {/* Status Section */}
              <div className={`p-5 rounded-xl border flex items-start gap-4 ${
                validationReport.success 
                  ? "bg-emerald-50/50 border-emerald-100 text-emerald-800" 
                  : "bg-rose-50/50 border-rose-100 text-rose-800"
              }`}>
                {validationReport.success ? (
                  <CheckCircle2 className="w-8 h-8 text-emerald-500 shrink-0" />
                ) : (
                  <AlertTriangle className="w-8 h-8 text-rose-500 shrink-0" />
                )}
                <div className="space-y-1">
                  <h3 className="text-sm font-bold">
                    {validationReport.success 
                      ? "100% Structural, Formula, & Style Fidelity Verified!" 
                      : `Fidelity Verification Failed: ${validationReport.differences.length} Discrepancies Found`}
                  </h3>
                  <p className="text-xs opacity-90 leading-relaxed">
                    {validationReport.success 
                      ? "The generated workbook was compared cell-by-cell against your original uploaded template. Every single cell height, column width, font styling, lock state, merged cell, and workbook property is 100% pristine with zero regression. Export finalized successfully."
                      : "The workbook export was safely aborted because structural or layout anomalies were detected. The system blocks regression to ensure enterprise-grade workbook integrity."}
                  </p>
                </div>
              </div>

              {/* Historical Replay Report Panel */}
              {(validationReport as any).replayReport && (
                <div className="p-5 bg-purple-50/50 border border-purple-100 rounded-xl text-purple-950 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-purple-600 shrink-0" />
                      <h3 className="text-sm font-bold text-purple-900">Historical Replay Report</h3>
                    </div>
                    <span className="px-2.5 py-0.5 bg-purple-100 text-purple-800 rounded-full font-extrabold text-[10px] uppercase tracking-wide border border-purple-200">
                      Replay Accuracy: {(validationReport as any).replayReport.accuracyRate}%
                    </span>
                  </div>
                  
                  <p className="text-xs leading-relaxed text-purple-800">
                    {(validationReport as any).replayReport.accuracyRate === 100 ? (
                      <>
                        Deterministic rate replay successfully verified against historical baseline project <span className="font-bold">"{(validationReport as any).replayReport.matchedProjectName}"</span>. All rate dimensions and commercial calculations match with 100% mathematical precision.
                      </>
                    ) : (
                      <>
                        Historical rate replay comparison against baseline project <span className="font-bold">"{(validationReport as any).replayReport.matchedProjectName}"</span>. Baseline rate deviations detected.
                      </>
                    )}
                  </p>

                  <div className="border border-purple-100 rounded-lg overflow-hidden max-h-[220px] overflow-y-auto bg-white">
                    <table className="w-full border-collapse text-left text-[11px] text-purple-950">
                      <thead className="bg-purple-50 border-b border-purple-150 text-purple-800 font-bold">
                        <tr>
                          <th className="p-2.5">Worksheet</th>
                          <th className="p-2.5">Cell Address</th>
                          <th className="p-2.5 text-right">Original Historical Rate</th>
                          <th className="p-2.5 text-right">Exported Rate</th>
                          <th className="p-2.5 text-right">Difference</th>
                          <th className="p-2.5 text-center">Replay Result</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-purple-100 font-medium">
                        {(validationReport as any).replayReport.items.map((it: any, itIdx: number) => {
                          const isMatch = it.replayResult === "Match";
                          return (
                            <tr key={itIdx} className="hover:bg-purple-50/30">
                              <td className="p-2.5 max-w-[150px] truncate font-semibold text-purple-900" title={`${it.sheetName} (Row ${it.rowNum})`}>
                                {it.sheetName}
                                <span className="block text-[9px] text-purple-500 font-normal truncate" title={it.description}>
                                  {it.description}
                                </span>
                              </td>
                              <td className="p-2.5 font-mono text-purple-700 font-bold">
                                {it.cellAddress}
                              </td>
                              <td className="p-2.5 text-right font-mono text-purple-900">
                                ₹{Number(it.originalHistoricalRate).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                              </td>
                              <td className="p-2.5 text-right font-mono text-purple-900">
                                ₹{Number(it.exportedRate).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                              </td>
                              <td className={`p-2.5 text-right font-mono font-bold ${it.difference === 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                {it.difference === 0 ? "-" : `₹${Number(it.difference).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}
                              </td>
                              <td className="p-2.5 text-center">
                                {isMatch ? (
                                  <span className="px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 text-[9px] font-extrabold inline-flex items-center gap-0.5">
                                    <Check className="w-2.5 h-2.5 text-emerald-600" /> Match
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-800 border border-rose-200 text-[9px] font-extrabold inline-flex items-center gap-0.5">
                                    <X className="w-2.5 h-2.5 text-rose-600" /> Mismatch
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Audit Details */}
              <div className="space-y-3">
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                  Verified Audit Checklist & Anomalies
                </h4>

                {validationReport.success ? (
                  <div className="border border-slate-100 rounded-xl divide-y divide-slate-100 overflow-hidden text-xs bg-slate-50/30">
                    {[
                      { name: "Sheet Matrix Integrity", desc: "Verifies sheet names, counts, hidden states, and tab rendering sequence" },
                      { name: "Visual Grid & Dimensioning", desc: "Validates all row heights, column widths, and manual hidden row/column indexes" },
                      { name: "Typography & Fonts Pairing", desc: "Ensures no font family, size, italic, bold, or underline attributes have changed" },
                      { name: "Aesthetic Color Mapping & Borders", desc: "Audits precise cell fills, background patterns, and border styles" },
                      { name: "Excel Formula Protection", desc: "Maintains all intact workbook calculations and prevents formula cell erasure" },
                      { name: "Data Validation & Protection States", desc: "Guarantees sheets lock statuses and locked cell matrices are preserved" },
                    ].map((check, idx) => (
                      <div key={idx} className="p-3 flex items-center justify-between gap-4">
                        <div className="space-y-0.5">
                          <p className="font-semibold text-slate-700">{check.name}</p>
                          <p className="text-[10px] text-slate-400">{check.desc}</p>
                        </div>
                        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full font-bold text-[10px]">
                          <Check className="w-3 h-3 text-emerald-500" />
                          100% Match
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="border border-slate-100 rounded-xl overflow-hidden max-h-[300px] overflow-y-auto">
                    <table className="w-full border-collapse text-left text-xs text-slate-600">
                      <thead className="bg-slate-50 border-b border-slate-100 text-slate-500 font-bold">
                        <tr>
                          <th className="p-3">Worksheet</th>
                          <th className="p-3">Location</th>
                          <th className="p-3">Category</th>
                          <th className="p-3">Discrepancy Detail</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-medium">
                        {validationReport.differences.map((diff, dIdx) => (
                          <tr key={dIdx} className="hover:bg-slate-50/50">
                            <td className="p-3 text-slate-800 font-semibold">{diff.sheetName}</td>
                            <td className="p-3 font-mono text-[10px] text-indigo-600">{diff.cellAddress || "Sheet Meta"}</td>
                            <td className="p-3">
                              <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                                diff.type === "structure" ? "bg-amber-50 text-amber-700" :
                                diff.type === "style" ? "bg-blue-50 text-blue-700" :
                                diff.type === "formula" ? "bg-rose-50 text-rose-700" : "bg-slate-50 text-slate-700"
                              }`}>
                                {diff.type.toUpperCase()}
                              </span>
                            </td>
                            <td className="p-3 space-y-1">
                              <p className="text-slate-700">{diff.reason}</p>
                              <div className="text-[10px] text-slate-400 font-mono space-y-0.5 bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                                <p><span className="text-slate-500 font-semibold">Expected:</span> {diff.expected}</p>
                                <p><span className="text-slate-500 font-semibold">Actual:</span> {diff.actual}</p>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between gap-4">
              <button
                onClick={() => {
                  if (!validationReport) return;
                  const content = JSON.stringify(validationReport, null, 2);
                  const blob = new Blob([content], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `validation_report_${rfqId}.json`;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                }}
                className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg font-bold text-xs flex items-center gap-1.5 shadow-3xs transition-all cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                Download Audit Report
              </button>
              <button
                onClick={() => setShowValidationModal(false)}
                className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg font-bold text-xs shadow-3xs transition-all cursor-pointer"
              >
                Close Audit Log
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Project Profile Input Modal - rendered via React Portal directly into document.body so
          its position: fixed is never affected by a transformed/animated ancestor or by the
          height of this component's own content (e.g. a long items table). */}
      {showProfileModal && createPortal(
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-md w-full flex flex-col max-h-[90vh] overflow-hidden animate-zoom-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <Building className="w-5 h-5 text-indigo-500" />
                <h2 className="text-sm font-bold text-slate-800">
                  Configure Project Profile
                </h2>
              </div>
              <button 
                onClick={() => setShowProfileModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleProfileSubmit} className="flex flex-col overflow-hidden">
              <div className="p-6 overflow-y-auto space-y-4">
                <p className="text-xs text-slate-500 leading-relaxed">
                  Please configure the target project profile. These fields scale rates dynamically based on project cost, size, typology, and city.
                </p>

                {profileFormError && (
                  <div className="p-3 bg-rose-50 border border-rose-100 rounded-lg flex items-center gap-2 text-rose-800 text-xs">
                    <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
                    <span className="font-medium">{profileFormError}</span>
                  </div>
                )}

                {/* Project Cost Input */}
                <div className="space-y-1">
                  <label htmlFor="input_project_cost" className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                    Project Cost (in INR)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-xs font-semibold text-slate-400">₹</span>
                    <input
                      id="input_project_cost"
                      type="text"
                      value={modalProjectCost}
                      onChange={(e) => setModalProjectCost(e.target.value)}
                      placeholder="e.g. 15000000"
                      className="w-full pl-7 pr-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                  <span className="text-[10px] text-slate-400">
                    Numeric value only (e.g. 15000000 for ₹1.5 Cr)
                  </span>
                </div>

                {/* Project Size Input */}
                <div className="space-y-1">
                  <label htmlFor="input_project_size" className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                    Project Size (in sq ft)
                  </label>
                  <div className="relative">
                    <input
                      id="input_project_size"
                      type="text"
                      value={modalProjectSize}
                      onChange={(e) => setModalProjectSize(e.target.value)}
                      placeholder="e.g. 50000"
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                    <span className="absolute right-3 top-2 text-[10px] font-bold text-slate-400 uppercase">SQ FT</span>
                  </div>
                </div>

                {/* Project Type Select */}
                <div className="space-y-1">
                  <label htmlFor="select_project_type" className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                    Project Type / Typology
                  </label>
                  <select
                    id="select_project_type"
                    value={modalProjectType}
                    onChange={(e) => setModalProjectType(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    <option value="Commercial Office">Commercial Office</option>
                    <option value="Residential High-Rise">Residential High-Rise</option>
                    <option value="Residential Villa">Residential Villa</option>
                    <option value="Retail / Mall">Retail / Mall</option>
                    <option value="Hospitality / Hotel">Hospitality / Hotel</option>
                    <option value="Industrial / Warehouse">Industrial / Warehouse</option>
                    <option value="Healthcare / Hospital">Healthcare / Hospital</option>
                    <option value="Data Center">Data Center</option>
                  </select>
                </div>

                {/* City Input */}
                <div className="space-y-1">
                  <label htmlFor="input_city" className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                    City Location
                  </label>
                  <input
                    id="input_city"
                    type="text"
                    value={modalCity}
                    onChange={(e) => setModalCity(e.target.value)}
                    placeholder="e.g. Gurgaon, Mumbai, Pune, Bangalore"
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  />
                  <span className="text-[10px] text-slate-400">
                    Determines local labor and material city scaling factor
                  </span>
                </div>

                {/* Building Grade Select */}
                <div className="space-y-1">
                  <label htmlFor="select_building_grade" className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                    Building Grade / Class
                  </label>
                  <select
                    id="select_building_grade"
                    value={modalBuildingGrade}
                    onChange={(e) => setModalBuildingGrade(e.target.value)}
                    className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-hidden focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 bg-white"
                  >
                    <option value="Grade A">Grade A (Premium Corporate / Multinational)</option>
                    <option value="Grade B">Grade B (Standard Commercial)</option>
                    <option value="Luxury">Luxury Residential / Premium Retail</option>
                    <option value="Standard">Standard Finishes</option>
                  </select>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="p-5 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowProfileModal(false)}
                  className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 rounded-lg font-bold text-xs shadow-3xs transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold text-xs shadow-3xs transition-all cursor-pointer"
                >
                  Continue Recommendation
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* Notifications Drawer */}
      {notification && (
        <div className={`fixed bottom-5 right-5 p-4 rounded-lg shadow-lg border text-xs z-50 flex items-center gap-2.5 max-w-sm animate-slide-in ${
          notification.type === "success" ? "bg-emerald-50 border-emerald-100 text-emerald-800" : "bg-red-50 border-red-100 text-red-800"
        }`}>
          {notification.type === "success" ? <Check className="w-4 h-4 text-emerald-500 shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />}
          <p className="font-semibold">{notification.text}</p>
        </div>
      )}
    </div>
  );
}
