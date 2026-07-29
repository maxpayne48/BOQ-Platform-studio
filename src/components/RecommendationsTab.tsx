import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Building,
  Tag,
  HelpCircle,
  Check,
  Download,
  RefreshCw,
  AlertCircle,
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
  Calendar,
  Search,
  SlidersHorizontal,
  Pencil,
  XCircle
} from "lucide-react";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { RFQItem, MasterBOQItem, ValidationReport, ValidationDifference } from "../types.js";
import { CONFIDENCE_APPROVAL_THRESHOLD } from "../decisionConstants.js";
import { useTourAction } from "../tour/TourContext.tsx";

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

  // Jump-to-row highlight pulse, set by focusItem (search results dropdown).
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // ==========================================================================
  // SPREADSHEET VIEW - worksheet tabs, search, filters, virtualization
  // ==========================================================================
  // The uploaded RFQ workbook is the source of truth: its worksheet order and its row order
  // within each worksheet are never re-sorted, grouped, or clustered anywhere below - only
  // filtered (hidden), which never reorders what remains. See server.ts's upload parse loop
  // (parseWorkbookForUpload / the legacy per-sheet fallback): both push items strictly in
  // worksheet-then-row order, and every store/API read since is a pure filter, never a sort -
  // so `items` here already arrives in exactly that order.
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [pendingFocusItemId, setPendingFocusItemId] = useState<string | null>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const [tableScrollTop, setTableScrollTop] = useState(0);

  interface SheetFilterState {
    trades: Set<string>;
    methods: Set<string>;
    confidence: Set<"high" | "medium" | "low">;
    validation: Set<"pass" | "fail" | "pending">;
    decision: Set<string>;
    engineeringAdjustedOnly: boolean;
  }
  const emptyFilters = (): SheetFilterState => ({
    trades: new Set(),
    methods: new Set(),
    confidence: new Set(),
    validation: new Set(),
    decision: new Set(),
    engineeringAdjustedOnly: false
  });
  const [filters, setFilters] = useState<SheetFilterState>(emptyFilters());

  const toggleSetFilter = <T,>(key: "trades" | "methods" | "decision", value: T) => {
    setFilters((prev) => {
      const next = new Set(prev[key] as Set<T>);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [key]: next };
    });
  };
  const toggleConfidenceFilter = (v: "high" | "medium" | "low") => {
    setFilters((prev) => {
      const next = new Set(prev.confidence);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return { ...prev, confidence: next };
    });
  };
  const toggleValidationFilter = (v: "pass" | "fail" | "pending") => {
    setFilters((prev) => {
      const next = new Set(prev.validation);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return { ...prev, validation: next };
    });
  };
  const activeFilterCount =
    filters.trades.size + filters.methods.size + filters.confidence.size +
    filters.validation.size + filters.decision.size + (filters.engineeringAdjustedOnly ? 1 : 0);
  const clearAllFilters = () => setFilters(emptyFilters());

  // Recommendation Method classification - a pure READ of which pipeline stage/tier produced
  // the item's rate (recommendationTrace.rateSource / matchTier / engineeringAdjustment /
  // isOverridden), never a re-derivation of pricing logic. "Not Yet Rated" covers items still
  // sitting at approvalStatus "Pending" (recommend has never run for them).
  const getRecommendationMethod = (item: RFQItem): string => {
    if (item.isOverridden) return "Estimator Override";
    if (!item.approvalStatus || item.approvalStatus === "Pending") return "Not Yet Rated";
    if (item.engineeringAdjustment?.applied) return "Engineering Adjustment";
    if (item.matchTier) return item.matchTier;
    if (item.recommendationTrace?.rateSource === "Historical Rate") return "Exact Match";
    if (item.matchedMasterId) return "AI Estimated";
    return "Manual Pricing";
  };
  const RECOMMENDATION_METHODS = [
    "Not Yet Rated", "Exact Match", "Engineering Adjustment", "Specification Match",
    "Material Match", "Functional Match", "AI Estimated", "Manual Pricing", "Estimator Override"
  ];

  const getValidationStatus = (item: RFQItem): "pass" | "fail" | "pending" => {
    if (!item.validationResults) return "pending";
    return Object.values(item.validationResults).some((v: any) => v && v.pass === false) ? "fail" : "pass";
  };

  // Historical Median/Average - DISPLAY-ONLY reference statistics computed client-side from the
  // evidence list the backend already returned (marketRateStatistics.historicalEvidence). These
  // are never fed back into recommendedRate or any pricing decision - the engine selects a single
  // best-matching historical observation and never averages (see ProjectCalibrationEngine.ts);
  // this is purely "for reference" triangulation the way an estimator would eyeball a spread of
  // comparable rates, clearly labelled as such in the column header below.
  const computeHistoricalStats = (item: RFQItem): { median: number; average: number } | null => {
    const rates = (item.marketRateStatistics?.historicalEvidence || [])
      .map((e) => e.historicalRate)
      .filter((r) => Number.isFinite(r) && r > 0);
    if (rates.length === 0) return null;
    const sorted = [...rates].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const average = rates.reduce((a, b) => a + b, 0) / rates.length;
    return { median, average };
  };

  // Worksheet grouping - order-preserving. Prefer workbookBlueprint.sheets, which is built by
  // iterating the real workbook (server.ts's generateWorkbookBlueprint) and therefore includes
  // EVERY real worksheet - General Notes, Preambles, Summary, etc. - not just the ones that
  // parsed into payable line items, in the workbook's own tab order. Object key order follows
  // insertion order for string keys, so Object.keys() here is the true file order. Falls back to
  // items' own first-occurrence order only if the blueprint hasn't loaded yet. Never sorted,
  // merged, or renamed either way.
  const sheetOrder = useMemo(() => {
    const blueprintSheets = rfqDetails?.workbookBlueprint?.sheets;
    if (blueprintSheets) return Object.keys(blueprintSheets);
    const seen = new Set<string>();
    const order: string[] = [];
    for (const it of items) {
      if (!seen.has(it.sheetName)) {
        seen.add(it.sheetName);
        order.push(it.sheetName);
      }
    }
    return order;
  }, [items, rfqDetails?.workbookBlueprint]);

  const itemsBySheet = useMemo(() => {
    const map = new Map<string, RFQItem[]>();
    for (const it of items) {
      if (!map.has(it.sheetName)) map.set(it.sheetName, []);
      map.get(it.sheetName)!.push(it);
    }
    return map;
  }, [items]);

  useEffect(() => {
    if (sheetOrder.length > 0 && (!activeSheet || !sheetOrder.includes(activeSheet))) {
      setActiveSheet(sheetOrder[0]);
    }
  }, [sheetOrder]);

  const buildSearchHaystack = (item: RFQItem): string => {
    const master = masterCatalog.find((m) => m.id === item.matchedMasterId);
    return [
      item.originalDescription,
      item.itemDecomposition?.specification,
      item.sheetName,
      master?.standardDescription,
      item.domain,
      master?.subcategory,
      getRecommendationMethod(item)
    ].filter(Boolean).join(" ").toLowerCase();
  };

  const matchesFilters = (item: RFQItem): boolean => {
    if (filters.trades.size > 0 && !filters.trades.has(item.domain)) return false;
    if (filters.methods.size > 0 && !filters.methods.has(getRecommendationMethod(item))) return false;
    if (filters.confidence.size > 0) {
      const c = item.overallConfidence ?? item.confidenceScore ?? 0;
      const bucket: "high" | "medium" | "low" = c >= 75 ? "high" : c >= 50 ? "medium" : "low";
      if (!filters.confidence.has(bucket)) return false;
    }
    if (filters.validation.size > 0 && !filters.validation.has(getValidationStatus(item))) return false;
    if (filters.decision.size > 0 && !filters.decision.has(item.approvalStatus || "Pending")) return false;
    if (filters.engineeringAdjustedOnly && !item.engineeringAdjustment?.applied) return false;
    if (searchQuery.trim() && !buildSearchHaystack(item).includes(searchQuery.trim().toLowerCase())) return false;
    return true;
  };

  // The ACTIVE worksheet's rows, filtered - filtering only hides non-matching rows, it never
  // reorders the survivors (a plain .filter() call, never .sort()).
  const currentSheetRows = useMemo(() => {
    return (itemsBySheet.get(activeSheet) || []).filter(matchesFilters);
  }, [itemsBySheet, activeSheet, filters, searchQuery, masterCatalog]);

  // Cross-sheet search results for the "find and jump to" dropdown - independent of the other
  // filters (a global finder), capped for dropdown usability.
  const globalSearchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: RFQItem[] = [];
    for (const it of items) {
      if (buildSearchHaystack(it).includes(q)) {
        results.push(it);
        if (results.length >= 30) break;
      }
    }
    return results;
  }, [searchQuery, items, masterCatalog]);

  // Row virtualization - fixed row height, single scrolling container. Sticky header/columns
  // remain pure CSS (position:sticky against this same scroll container) regardless of how many
  // rows are actually mounted, so virtualizing never breaks the pinned-column behavior.
  const ROW_HEIGHT = 30;
  const TABLE_VIEWPORT_HEIGHT = 690; // ~23 rows visible at once, within the 20-30 row target
  const VIRTUALIZE_OVERSCAN = 8;
  const totalRows = currentSheetRows.length;
  const visibleRowCount = Math.ceil(TABLE_VIEWPORT_HEIGHT / ROW_HEIGHT);
  const virtualStartIndex = Math.max(0, Math.floor(tableScrollTop / ROW_HEIGHT) - VIRTUALIZE_OVERSCAN);
  const virtualEndIndex = Math.min(totalRows, virtualStartIndex + visibleRowCount + VIRTUALIZE_OVERSCAN * 2);
  const visibleSheetRows = currentSheetRows.slice(virtualStartIndex, virtualEndIndex);
  const topSpacerHeight = virtualStartIndex * ROW_HEIGHT;
  const bottomSpacerHeight = (totalRows - virtualEndIndex) * ROW_HEIGHT;

  useEffect(() => {
    // A new active sheet (or a filter/search change) invalidates the previous scroll position -
    // snap back to the top of the new row set rather than showing a stale offset.
    setTableScrollTop(0);
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = 0;
  }, [activeSheet]);

  const handleTableScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setTableScrollTop(e.currentTarget.scrollTop);
  };

  // Jump-to-row navigation - used by the search results dropdown. Switches worksheet tab if
  // needed, then (once the target sheet's filtered row list is available) scrolls the
  // virtualized table directly to that row's computed offset and pulses a highlight -
  // scrollIntoView doesn't work here since an off-screen virtualized row may not exist in the
  // DOM at all.
  const focusItem = (item: RFQItem) => {
    setShowSearchDropdown(false);
    if (activeSheet !== item.sheetName) {
      setActiveSheet(item.sheetName);
    }
    setPendingFocusItemId(item.id);
  };

  useEffect(() => {
    if (!pendingFocusItemId) return;
    const idx = currentSheetRows.findIndex((r) => r.id === pendingFocusItemId);
    if (idx === -1) {
      // Not in this sheet's currently-filtered row set (e.g. hidden by an active filter) -
      // nothing to scroll to; give up gracefully rather than jumping to the wrong row.
      setPendingFocusItemId(null);
      return;
    }
    const targetTop = Math.max(0, idx * ROW_HEIGHT - TABLE_VIEWPORT_HEIGHT / 2 + ROW_HEIGHT / 2);
    if (tableScrollRef.current) tableScrollRef.current.scrollTop = targetTop;
    setTableScrollTop(targetTop);
    const focusedId = pendingFocusItemId;
    setHighlightedItemId(focusedId);
    setPendingFocusItemId(null);
    const t = setTimeout(() => setHighlightedItemId((curr) => (curr === focusedId ? null : curr)), 2200);
    return () => clearTimeout(t);
  }, [pendingFocusItemId, currentSheetRows]);

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
  // Follow-up Fix 8 (2026-07-28): tracks which fields the user actually edited in this modal
  // session, as opposed to fields still showing their pre-filled/default value. The form always
  // shows a non-empty value in every field (pre-filled from projectContext, or a hardcoded
  // default like "Gurgaon"/"Grade A") - so the value itself can never tell the server "the user
  // deliberately chose this" apart from "the user never touched this." Previously every field was
  // submitted unconditionally, which - per the server's own documented precedence (explicit body >
  // identified historical twin's real profile > projectContext > placeholder) - permanently
  // prevented a recognized historical twin from ever being used, even when one was correctly
  // identified server-side (see docs/audit/0002-identity-and-evidence-integrity-audit.md,
  // Follow-up Fix 7/8). Only genuinely touched fields are now sent; untouched fields are omitted
  // from the request body entirely, letting the server's existing twin-detection fallback apply.
  const [profileFieldsTouched, setProfileFieldsTouched] = useState({
    cost: false,
    size: false,
    type: false,
    city: false,
    grade: false
  });

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
    setProfileFieldsTouched({ cost: false, size: false, type: false, city: false, grade: false });
    setProfileFormError("");
    setShowProfileModal(true);
  };

  // Guided-walkthrough hooks. These let a tour step put the real modal/drawer it is
  // describing on screen - the same ones the user would open by hand - and close it again
  // when the step is left, so the screen is returned exactly as it was. Purely view state:
  // nothing here submits a profile, runs a recommendation, or touches any rate.
  useTourAction("open-profile-modal", () => {
    setSelectedItemId(null);
    openProfileModal();
  });
  useTourAction("close-profile-modal", () => setShowProfileModal(false));
  useTourAction("open-first-item", () => {
    setShowProfileModal(false);
    const firstItem = items[0];
    if (firstItem) {
      setSelectedItemId(firstItem.id);
      setActiveDrawerTab("auditor");
    }
  });
  useTourAction("close-item-drawer", () => setSelectedItemId(null));

  const runEstimationEngine = (profile: {
    projectCost?: number;
    projectSize?: number;
    projectType?: string;
    city?: string;
    buildingGrade?: string;
  }) => {
    setAnalyzing(true);
    fetch(`/api/rfqs/${rfqId}/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile)
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
    // Only send fields the user actually edited - an untouched field (still showing its
    // pre-filled or default value) is omitted so the server can fall back to a recognized
    // historical twin's real profile instead (see profileFieldsTouched above).
    runEstimationEngine({
      ...(profileFieldsTouched.cost ? { projectCost: costNum } : {}),
      ...(profileFieldsTouched.size ? { projectSize: sizeNum } : {}),
      ...(profileFieldsTouched.type ? { projectType: modalProjectType.trim() } : {}),
      ...(profileFieldsTouched.city ? { city: modalCity.trim() } : {}),
      ...(profileFieldsTouched.grade ? { buildingGrade: modalBuildingGrade.trim() } : {})
    });
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

    const activeItems = items.filter((i) => i.approvalStatus && i.approvalStatus !== "Pending");
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

      } else if (response.status === 422 && data.error === "Installation Rate Validation Failed") {
        // This payload carries `violations` (sheetName/rowNum/reason), not a ValidationReport
        // `report.differences`, so it must never be routed into the structural validation modal
        // (that render crashes on a missing differences array and blanks the whole page).
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


  // Display-only Title Case for worksheet tab labels - the uploaded workbook's own sheet names
  // are used verbatim as data keys everywhere (activeSheet state, itemsBySheet Map, tooltips'
  // underlying value), only the rendered label text is reformatted. Domain acronyms that appear
  // in real BOQ sheet names (HVAC, PHE, FLSS, etc.) are preserved fully uppercase rather than
  // being title-cased into "Hvac"/"Phe".
  const TAB_LABEL_ACRONYMS = new Set(["HVAC", "PHE", "FLSS", "MEP", "BOQ", "IT", "AC", "DB", "CCTV", "UPS", "AV", "IBMS"]);
  const toTitleCaseLabel = (text: string): string =>
    text.split(" ").map((word) => {
      if (!word) return word;
      const upperWord = word.toUpperCase();
      const alphaOnly = upperWord.replace(/[^A-Z]/g, "");
      if (alphaOnly.length >= 2 && TAB_LABEL_ACRONYMS.has(alphaOnly)) return upperWord;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(" ");

  // Spreadsheet column model - the uploaded RFQ's own columns (Sr No through Amount) followed
  // by the AI recommendation columns appended to the right, exactly the "open the original RFQ
  // in Excel, with recommendation columns added" framing. Widths are explicit pixel values (not
  // Tailwind width classes) so the header row and every body row stay pixel-aligned, which matters
  // for the two sticky (pinned) columns' `left` offsets to line up exactly between header and body.
  interface ColumnDef {
    key: string;
    label: string;
    width: number;
    sticky?: number; // left offset in px if this column is pinned
    align?: "left" | "right" | "center";
    group: "original" | "recommendation";
  }
  const columns: ColumnDef[] = [
    { key: "srNo", label: "Sr No", width: 56, sticky: 0, align: "center", group: "original" },
    { key: "description", label: "Item Description", width: 260, sticky: 56, group: "original" },
    { key: "specification", label: "Specification", width: 180, group: "original" },
    { key: "unit", label: "Unit", width: 56, align: "center", group: "original" },
    { key: "quantity", label: "Quantity", width: 68, align: "right", group: "original" },
    { key: "supplyRate", label: "Supply Rate (₹)", width: 120, align: "right", group: "original" },
    { key: "installRate", label: "Installation Rate (₹)", width: 120, align: "right", group: "original" },
    { key: "totalRate", label: "Total Rate (₹)", width: 120, align: "right", group: "original" },
    { key: "amount", label: "Amount (₹)", width: 130, align: "right", group: "original" },
    { key: "recSupply", label: "Recommended Supply Rate", width: 140, align: "right", group: "recommendation" },
    { key: "recInstall", label: "Recommended Installation Rate", width: 150, align: "right", group: "recommendation" },
    { key: "recTotal", label: "Recommended Total Rate", width: 140, align: "right", group: "recommendation" },
    { key: "histMedian", label: "Historical Median", width: 120, align: "right", group: "recommendation" },
    { key: "histAverage", label: "Historical Average", width: 120, align: "right", group: "recommendation" },
    { key: "confidence", label: "Confidence", width: 90, align: "center", group: "recommendation" },
    { key: "method", label: "Recommendation Method", width: 160, align: "center", group: "recommendation" },
    { key: "decision", label: "Decision", width: 130, align: "center", group: "recommendation" },
    { key: "evidence", label: "Historical Evidence", width: 100, align: "center", group: "recommendation" },
    { key: "engNotes", label: "Engineering Notes", width: 130, align: "center", group: "recommendation" },
    { key: "validation", label: "Validation Status", width: 100, align: "center", group: "recommendation" }
  ];
  const totalTableWidth = columns.reduce((sum, c) => sum + c.width, 0);

  // Explicit per-column pixel geometry, shared by header and body cells so the two pinned
  // (sticky) columns line up exactly between them regardless of which rows are virtualized in.
  const cellStyle = (col: ColumnDef, isHeader: boolean): React.CSSProperties => {
    const style: React.CSSProperties = { width: col.width, minWidth: col.width, maxWidth: col.width };
    if (isHeader) {
      style.position = "sticky";
      style.top = 0;
      style.zIndex = col.sticky !== undefined ? 30 : 20;
      if (col.sticky !== undefined) style.left = col.sticky;
    } else if (col.sticky !== undefined) {
      style.position = "sticky";
      style.left = col.sticky;
      style.zIndex = 10;
    }
    return style;
  };

  // Body cell content per column - a pure render of fields already on the item/master; nothing
  // here computes a rate or a decision, it only displays what the backend already produced.
  const getCellContent = (item: RFQItem, colKey: string, masterMatch: MasterBOQItem | undefined): React.ReactNode => {
    const finalRate = item.overriddenRate || item.recommendedRate || 0;
    const totalRate = finalRate + (item.installationRate || 0);
    const amount = totalRate * item.quantity;
    const recTotal = item.recommendedRate + (item.installationRate || 0);
    const hist = computeHistoricalStats(item);
    const confidence = item.overallConfidence ?? item.confidenceScore ?? 0;
    const method = getRecommendationMethod(item);
    const validationStatus = getValidationStatus(item);
    const money = (v: number, frac = 2) => `₹${v.toLocaleString(undefined, { maximumFractionDigits: frac })}`;

    switch (colKey) {
      case "srNo":
        return (
          <div className="font-mono leading-tight">
            <p className="font-bold text-slate-700">{item.itemNo}</p>
            <p className="text-slate-400 text-[9px]">R{item.rowNum}</p>
          </div>
        );
      case "description":
        return (
          <div className="min-w-0 leading-tight">
            {item.parentHierarchy.length > 0 && (
              <p className="text-[9px] text-slate-400 truncate" title={item.parentHierarchy.join(" / ")}>
                {item.parentHierarchy.join(" / ")}
              </p>
            )}
            <p className="text-slate-800 font-medium truncate" title={item.originalDescription}>
              {item.originalDescription}
            </p>
          </div>
        );
      case "specification":
        return (
          <span className="text-slate-600 truncate block" title={item.itemDecomposition?.specification || undefined}>
            {item.itemDecomposition?.specification || "—"}
          </span>
        );
      case "unit":
        return <span className="font-mono text-slate-500">{item.unit}</span>;
      case "quantity":
        return <span className="font-mono font-semibold text-slate-700">{item.quantity}</span>;
      case "supplyRate":
        return (
          <span className="inline-flex items-center gap-1 justify-end w-full">
            <span className={`font-mono font-bold ${item.isOverridden ? "text-amber-600" : "text-slate-800"}`}>
              {finalRate > 0 ? money(finalRate) : "—"}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); startOverride(item); setSelectedItemId(item.id); }}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-indigo-600 transition-opacity cursor-pointer shrink-0"
              title="Override this rate"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </span>
        );
      case "installRate":
        return <span className="font-mono text-slate-600">{item.installationRate !== undefined ? money(item.installationRate) : "—"}</span>;
      case "totalRate":
        return <span className="font-mono font-semibold text-slate-700">{totalRate > 0 ? money(totalRate) : "—"}</span>;
      case "amount":
        return <span className="font-mono font-semibold text-slate-800">{amount > 0 ? money(amount, 0) : "—"}</span>;
      case "recSupply":
        return <span className="font-mono font-bold text-indigo-700">{item.recommendedRate > 0 ? money(item.recommendedRate) : "—"}</span>;
      case "recInstall":
        return <span className="font-mono text-indigo-600">{item.installationRate !== undefined ? money(item.installationRate) : "—"}</span>;
      case "recTotal":
        return <span className="font-mono font-semibold text-indigo-700">{recTotal > 0 ? money(recTotal) : "—"}</span>;
      case "histMedian":
        return (
          <span className="font-mono text-slate-400 italic" title="Informational reference only - the engine selects a single closest historical match and never averages">
            {hist ? money(hist.median) : "—"}
          </span>
        );
      case "histAverage":
        return (
          <span className="font-mono text-slate-400 italic" title="Informational reference only - the engine selects a single closest historical match and never averages">
            {hist ? money(hist.average) : "—"}
          </span>
        );
      case "confidence":
        return confidence > 0 ? (
          <span className={`inline-block px-1.5 py-0.5 rounded-full text-[9px] font-bold font-mono ${
            confidence >= CONFIDENCE_APPROVAL_THRESHOLD
              ? "bg-emerald-50 text-emerald-600 border border-emerald-100"
              : "bg-amber-50 text-amber-600 border border-amber-100"
          }`}>
            {confidence}%
          </span>
        ) : <span className="text-slate-300 text-[9px] font-bold">—</span>;
      case "method":
        return <span className="text-[9px] font-bold uppercase text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded whitespace-nowrap">{method}</span>;
      case "decision":
        return (
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedItemId(item.id); setActiveDrawerTab("trace"); }}
            title={item.decision?.decisionSummary || item.reason}
            className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold cursor-pointer whitespace-nowrap ${
              item.approvalStatus === "Manual Pricing"
                ? "bg-red-50 text-red-700 border border-red-100 hover:bg-red-100"
                : item.approvalStatus === "Needs Review"
                  ? "bg-amber-50 text-amber-700 border border-amber-100 hover:bg-amber-100"
                  : item.approvalStatus === "Auto Approved"
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100"
                    : "bg-slate-50 text-slate-400 border border-slate-200"
            }`}
          >
            {item.approvalStatus || "Pending"}
          </button>
        );
      case "evidence": {
        const count = item.marketRateStatistics?.referenceCount || 0;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedItemId(item.id); setActiveDrawerTab("pricing"); }}
            className="text-[9px] font-bold text-indigo-600 hover:underline cursor-pointer"
          >
            {count > 0 ? `${count} ref${count === 1 ? "" : "s"}` : "—"}
          </button>
        );
      }
      case "engNotes":
        if (!item.engineeringAdjustment?.applied) return <span className="text-slate-300 text-[9px]">—</span>;
        return (
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedItemId(item.id); setActiveDrawerTab("pricing"); }}
            title={item.engineeringAdjustment.explanation}
            className="text-[9px] font-bold uppercase text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded hover:bg-purple-100 cursor-pointer whitespace-nowrap"
          >
            {item.engineeringAdjustment.mathematicalModel}
          </button>
        );
      case "validation":
        return (
          <button
            onClick={(e) => { e.stopPropagation(); setSelectedItemId(item.id); setActiveDrawerTab("auditor"); }}
            className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border cursor-pointer ${
              validationStatus === "pass"
                ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                : validationStatus === "fail"
                  ? "bg-red-50 text-red-600 border-red-100"
                  : "bg-slate-50 text-slate-400 border-slate-200"
            }`}
          >
            {validationStatus}
          </button>
        );
      default:
        return null;
    }
  };

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
            data-tour="export-button"
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
          {rfqDetails?.recommendationAuditReport && (
            <div className="bg-purple-50/50 border border-purple-100 rounded-xl p-5 text-purple-950 space-y-4 mb-5 shadow-3xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="w-5 h-5 text-purple-600 shrink-0" />
                  <h4 className="text-sm font-bold text-purple-900">Recommendation Quality Report</h4>
                </div>
                <span className="px-2.5 py-0.5 bg-purple-100 text-purple-800 rounded-full font-extrabold text-[10px] uppercase tracking-wide border border-purple-200">
                  Approval Accuracy: {rfqDetails.recommendationAuditReport.approvalAccuracy.toFixed(1)}%
                </span>
              </div>
              <div data-tour="summary-bar" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 text-center">
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Total Rows</div>
                  <div className="text-base font-black text-purple-950 mt-1">{rfqDetails.recommendationAuditReport.totalRows}</div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Auto Approved</div>
                  <div className="text-base font-black text-emerald-700 mt-1">{rfqDetails.recommendationAuditReport.autoApprovedRows}</div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Needs Review</div>
                  <div className={`text-base font-black mt-1 ${rfqDetails.recommendationAuditReport.needsReviewRows > 0 ? "text-amber-600" : "text-purple-950"}`}>
                    {rfqDetails.recommendationAuditReport.needsReviewRows}
                  </div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Manual Pricing</div>
                  <div className={`text-base font-black mt-1 ${rfqDetails.recommendationAuditReport.manualPricingRows > 0 ? "text-rose-600" : "text-purple-950"}`}>
                    {rfqDetails.recommendationAuditReport.manualPricingRows}
                  </div>
                </div>
                <div className="p-3 bg-white rounded-xl border border-purple-100/60 shadow-3xs">
                  <div className="text-[10px] text-purple-600 font-bold uppercase tracking-wider">Accuracy</div>
                  <div className="text-base font-black text-indigo-700 mt-1">{rfqDetails.recommendationAuditReport.approvalAccuracy.toFixed(1)}%</div>
                </div>
              </div>
            </div>
          )}

          {/* Search + Filter toolbar. A fixed backdrop closes either dropdown on outside click,
              matching the same pattern used by the drawer/modal overlays elsewhere in this file. */}
          {(showFilterPanel || showSearchDropdown) && (
            <div className="fixed inset-0 z-20" onClick={() => { setShowFilterPanel(false); setShowSearchDropdown(false); }} />
          )}
          <div className="flex items-center gap-2 p-3 bg-white border border-slate-100 rounded-xl shadow-3xs relative z-30 mb-3 flex-wrap">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setShowSearchDropdown(true); }}
                onFocus={() => setShowSearchDropdown(true)}
                placeholder="Search description, specification, worksheet, trade, category, method..."
                className="w-full pl-8 pr-7 py-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-200"
              />
              {searchQuery && (
                <button
                  onClick={() => { setSearchQuery(""); setShowSearchDropdown(false); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500 cursor-pointer"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
              )}
              {showSearchDropdown && searchQuery.trim() && (
                <div className="absolute top-full left-0 mt-1 w-[420px] max-h-80 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-40 thin-scrollbar">
                  {globalSearchResults.length === 0 ? (
                    <p className="p-3 text-[11px] text-slate-400 italic">No matches in any worksheet.</p>
                  ) : globalSearchResults.map((r) => (
                    <button
                      key={r.id}
                      onMouseDown={(e) => { e.preventDefault(); focusItem(r); setSearchQuery(""); }}
                      className="w-full text-left px-3 py-2 hover:bg-indigo-50/60 border-b border-slate-50 last:border-0 flex items-start gap-2 cursor-pointer"
                    >
                      <span className="shrink-0 mt-0.5 text-[9px] font-bold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-mono">{r.sheetName}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-semibold text-slate-800 truncate">Row {r.rowNum} - {r.originalDescription}</span>
                        <span className="block text-[9px] text-slate-400">{getRecommendationMethod(r)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="relative">
              <button
                onClick={() => setShowFilterPanel(!showFilterPanel)}
                className={`px-3 py-2 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
                  activeFilterCount > 0 ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                Filters
                {activeFilterCount > 0 && <span className="px-1.5 rounded-full bg-indigo-600 text-white text-[9px] font-bold">{activeFilterCount}</span>}
              </button>
              {showFilterPanel && (
                <div className="absolute top-full right-0 mt-1 w-80 max-h-[28rem] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg z-40 p-4 space-y-4 thin-scrollbar">
                  <div>
                    <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1.5">Trade</span>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(new Set(items.map((i) => i.domain))).map((d) => (
                        <button key={d} onClick={() => toggleSetFilter("trades", d)} className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${filters.trades.has(d) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1.5">Recommendation Method</span>
                    <div className="flex flex-wrap gap-1.5">
                      {RECOMMENDATION_METHODS.map((m) => (
                        <button key={m} onClick={() => toggleSetFilter("methods", m)} className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${filters.methods.has(m) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1.5">Confidence</span>
                    <div className="flex flex-wrap gap-1.5">
                      {([["high", "High (≥75%)"], ["medium", "Medium (50-74%)"], ["low", "Low (<50%)"]] as const).map(([v, l]) => (
                        <button key={v} onClick={() => toggleConfidenceFilter(v)} className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${filters.confidence.has(v) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1.5">Validation Status</span>
                    <div className="flex flex-wrap gap-1.5">
                      {([["pass", "Pass"], ["fail", "Fail"], ["pending", "Pending"]] as const).map(([v, l]) => (
                        <button key={v} onClick={() => toggleValidationFilter(v)} className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${filters.validation.has(v) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase text-slate-400 block mb-1.5">Decision</span>
                    <div className="flex flex-wrap gap-1.5">
                      {["Auto Approved", "Needs Review", "Manual Pricing", "Pending"].map((d) => (
                        <button key={d} onClick={() => toggleSetFilter("decision", d)} className={`px-2 py-1 rounded text-[10px] font-semibold border cursor-pointer ${filters.decision.has(d) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.engineeringAdjustedOnly}
                      onChange={(e) => setFilters((prev) => ({ ...prev, engineeringAdjustedOnly: e.target.checked }))}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
                    />
                    <span className="text-[11px] font-semibold text-slate-700">Engineering Adjusted Only</span>
                  </label>
                  {activeFilterCount > 0 && (
                    <button onClick={clearAllFilters} className="w-full text-center py-1.5 text-[10px] font-bold text-red-600 hover:bg-red-50 rounded cursor-pointer">
                      Clear All Filters
                    </button>
                  )}
                </div>
              )}
            </div>

            {(activeFilterCount > 0 || searchQuery) && (
              <button onClick={() => { clearAllFilters(); setSearchQuery(""); }} className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 cursor-pointer underline">
                Reset
              </button>
            )}

            <span className="ml-auto text-[10px] text-slate-400 font-medium">
              Showing <strong className="text-slate-600">{currentSheetRows.length}</strong> of {(itemsBySheet.get(activeSheet) || []).length} rows in <strong className="text-slate-600">{activeSheet}</strong>
            </span>
          </div>

          {/* Workbook spreadsheet - worksheet tabs (identical order to the uploaded file) above a
              single virtualized, sticky-header/sticky-column table. Rows are never reordered,
              grouped, or clustered - only filtered/searched (hidden), which preserves order. */}
          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden shadow-3xs">
            <div className="flex items-end gap-0.5 px-2 pt-2 bg-slate-100/70 border-b border-slate-200 overflow-x-auto thin-scrollbar">
              {sheetOrder.map((sheetName) => {
                const sheetItems = itemsBySheet.get(sheetName) || [];
                const flagged = sheetItems.filter((i) => (i.attentionFlags?.length || 0) > 0).length;
                const isActive = activeSheet === sheetName;
                return (
                  <button
                    key={sheetName}
                    onClick={() => setActiveSheet(sheetName)}
                    className={`shrink-0 px-3 py-2 text-[13px] font-semibold tracking-normal rounded-t-lg border border-b-0 transition-colors cursor-pointer flex items-center gap-1.5 ${
                      isActive
                        ? "bg-slate-900 text-white border-slate-900"
                        : "bg-slate-50 text-slate-700 border-transparent hover:bg-slate-200 hover:text-slate-900"
                    }`}
                    title={toTitleCaseLabel(sheetName)}
                  >
                    <FileSpreadsheet className="w-3 h-3 shrink-0" />
                    <span className="max-w-[140px] truncate">{toTitleCaseLabel(sheetName)}</span>
                    <span className={`text-[9px] font-mono px-1 rounded ${isActive ? "bg-indigo-600 text-white" : "bg-slate-300 text-slate-700"}`}>{sheetItems.length}</span>
                    {flagged > 0 && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title={`${flagged} item(s) flagged for review`} />}
                  </button>
                );
              })}
            </div>

            {(itemsBySheet.get(activeSheet) || []).length === 0 ? (
              // Non-BOQ worksheet (General Notes, Preambles, Summary, etc.) - it exists in the
              // uploaded workbook and gets a tab like every other sheet, but has no payable line
              // items to price, so there is no pricing table to show. Surface what the parser
              // already extracted about it instead of an empty grid.
              <div className="p-10 text-center" style={{ minHeight: 200 }}>
                {(() => {
                  const sheetInfo = rfqDetails?.workbookBlueprint?.sheets?.[activeSheet];
                  return (
                    <>
                      <FileSpreadsheet className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                      <p className="text-xs font-semibold text-slate-600">
                        "{activeSheet}" {sheetInfo?.detectedType ? `is classified as ${sheetInfo.detectedType}` : "has no payable line items"}
                      </p>
                      <p className="text-[11px] text-slate-400 max-w-md mx-auto mt-1.5 leading-relaxed">
                        {sheetInfo?.summary || "No BOQ pricing rows were found on this worksheet, so there is nothing to recommend rates for here."}
                      </p>
                    </>
                  );
                })()}
              </div>
            ) : (
            <div
              ref={tableScrollRef}
              onScroll={handleTableScroll}
              className="overflow-auto thin-scrollbar"
              style={{ height: TABLE_VIEWPORT_HEIGHT }}
            >
              <table className="border-collapse" style={{ tableLayout: "fixed", width: totalTableWidth }}>
                <colgroup>
                  {columns.map((col) => <col key={col.key} style={{ width: col.width }} />)}
                </colgroup>
                <thead>
                  <tr>
                    {columns.map((col) => (
                      <th
                        key={col.key}
                        style={cellStyle(col, true)}
                        title={col.key === "histMedian" || col.key === "histAverage" ? "Informational reference only - never used in pricing" : col.label}
                        className={`px-2 py-2 text-[10px] font-bold uppercase tracking-wide border-b border-r border-slate-200 truncate ${
                          col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                        } ${
                          col.sticky !== undefined
                            ? "bg-slate-100 text-slate-600"
                            : col.group === "recommendation" ? "bg-indigo-50/70 text-indigo-700" : "bg-slate-50 text-slate-500"
                        }`}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentSheetRows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length} className="p-10 text-center text-xs text-slate-400">
                        No rows match the current search/filters in "{activeSheet}".
                      </td>
                    </tr>
                  ) : (
                    <>
                      {topSpacerHeight > 0 && (
                        <tr style={{ height: topSpacerHeight }} aria-hidden="true">
                          <td colSpan={columns.length} style={{ padding: 0, border: "none" }} />
                        </tr>
                      )}
                      {visibleSheetRows.map((item, i) => {
                        const absoluteIdx = virtualStartIndex + i;
                        const masterMatch = masterCatalog.find((m) => m.id === item.matchedMasterId);
                        const isHighlighted = highlightedItemId === item.id;
                        const isSelected = selectedItemId === item.id;
                        const pinnedBgClass = isHighlighted ? "bg-amber-50" : isSelected ? "bg-indigo-100" : absoluteIdx % 2 === 1 ? "bg-slate-50" : "bg-white";
                        const rowBgClass = isHighlighted ? "bg-amber-50" : isSelected ? "bg-indigo-50/40" : absoluteIdx % 2 === 1 ? "bg-slate-50/50" : "bg-white";
                        return (
                          <tr
                            key={item.id}
                            onClick={() => { setSelectedItemId(item.id); setActiveDrawerTab("auditor"); }}
                            className={`group cursor-pointer hover:bg-indigo-50/20 transition-colors ${rowBgClass} ${isHighlighted ? "ring-2 ring-inset ring-amber-300" : ""}`}
                            style={{ height: ROW_HEIGHT }}
                          >
                            {columns.map((col) => (
                              <td
                                key={col.key}
                                style={cellStyle(col, false)}
                                className={`px-2 py-1 border-b border-r border-slate-100 overflow-hidden text-[11px] align-middle ${
                                  col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                                } ${col.sticky !== undefined ? `${pinnedBgClass} group-hover:bg-indigo-50/40` : ""}`}
                              >
                                {getCellContent(item, col.key, masterMatch)}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                      {bottomSpacerHeight > 0 && (
                        <tr style={{ height: bottomSpacerHeight }} aria-hidden="true">
                          <td colSpan={columns.length} style={{ padding: 0, border: "none" }} />
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>
            )}
          </div>
        </>
      )}

      {/* 3. IMMERSIVE SIDE DRAWER FOR DETAILED ENGINEERING ANALYSIS */}
      {selectedItemId && (() => {
        const selectedItem = items.find((i) => i.id === selectedItemId);
        if (!selectedItem) return null;

        const masterMatch = masterCatalog.find((m) => m.id === selectedItem.matchedMasterId);
        const finalRate = selectedItem.overriddenRate || selectedItem.recommendedRate || 0;
        // Everything below is a read-only render of what the backend actually computed
        // (ADR-0001). Nothing is fabricated client-side: missing data renders as an honest
        // "not available" state, never as invented pass-marks, rates, or specifications.
        const validation = selectedItem.validationResults;
        const decomp = selectedItem.itemDecomposition;
        const marketStats = selectedItem.marketRateStatistics;
        const worksheetCtx = rfqDetails?.worksheetContexts?.[selectedItem.sheetName];

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
                    {selectedItem.approvalStatus === "Manual Pricing" ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full uppercase">
                        <AlertTriangle className="w-3 h-3" /> Manual Pricing
                      </span>
                    ) : selectedItem.approvalStatus === "Needs Review" ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-100 px-2 py-0.5 rounded-full uppercase">
                        <AlertTriangle className="w-3 h-3" /> Needs Review
                      </span>
                    ) : selectedItem.approvalStatus === "Auto Approved" ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full uppercase">
                        <CheckCircle2 className="w-3 h-3" /> Auto Approved
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full uppercase">
                        Pending
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

              {/* Override Final Rate - moved here from an inline table edit so every row in the
                  spreadsheet above can stay a uniform, compact Excel-like height regardless of
                  edit state. */}
              <div className="px-6 py-3 bg-white border-b border-slate-100 flex items-center justify-between gap-3">
                {editingItemId === selectedItem.id ? (
                  <div className="flex items-center gap-2 flex-1 flex-wrap">
                    <div className="space-y-0.5">
                      <label className="text-[9px] font-bold uppercase text-slate-400 block">Final Rate (₹)</label>
                      <input
                        type="number"
                        value={overrideValue}
                        onChange={(e) => setOverrideValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveOverride(selectedItem.id); }}
                        className="w-28 px-2 py-1.5 text-xs border border-indigo-400 bg-white rounded text-slate-700 font-bold focus:outline-none"
                        autoFocus
                      />
                    </div>
                    <div className="space-y-0.5 flex-1 min-w-[140px]">
                      <label className="text-[9px] font-bold uppercase text-slate-400 block">Reason (optional)</label>
                      <input
                        type="text"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveOverride(selectedItem.id); }}
                        placeholder="Recorded for the Learning Layer"
                        className="w-full px-2 py-1.5 text-[11px] border border-slate-200 bg-white rounded text-slate-600 focus:outline-none focus:border-indigo-400"
                      />
                    </div>
                    <button onClick={() => saveOverride(selectedItem.id)} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold rounded cursor-pointer self-end">
                      Save
                    </button>
                    <button onClick={() => setEditingItemId(null)} className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-[11px] font-bold rounded cursor-pointer self-end">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div>
                      <span className="text-[9px] font-bold uppercase text-slate-400 block">Final Rate</span>
                      <span className={`text-lg font-extrabold font-mono ${selectedItem.isOverridden ? "text-amber-600" : "text-slate-800"}`}>
                        ₹{finalRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      {selectedItem.isOverridden && <span className="ml-2 text-[9px] font-bold text-amber-500 uppercase">Overridden</span>}
                    </div>
                    <button
                      onClick={() => startOverride(selectedItem)}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-200 text-[11px] font-bold rounded text-slate-600 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                    >
                      <Pencil className="w-3 h-3" /> Override
                    </button>
                  </>
                )}
              </div>

              {/* Tabs list */}
              <div data-tour="drawer-tabs" className="flex border-b border-slate-100 bg-slate-50/50 px-6 text-[11px] font-semibold text-slate-500">
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
                    {/* Commercial Decision - THE approval verdict and why (read-only) */}
                    {selectedItem.decision && (
                      <div>
                        <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                          Commercial Decision
                        </h4>
                        <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-3 text-xs">
                          <p className="text-slate-700 leading-relaxed font-medium">{selectedItem.decision.decisionSummary}</p>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="space-y-0.5">
                              <span className="text-[10px] text-slate-400 font-semibold block uppercase">Approval</span>
                              <span className="text-slate-800 font-bold">{selectedItem.decision.approvalStatus}</span>
                            </div>
                            <div className="space-y-0.5">
                              <span className="text-[10px] text-slate-400 font-semibold block uppercase">Confidence Used</span>
                              <span className="text-slate-800 font-bold font-mono">{selectedItem.decision.confidence}%</span>
                            </div>
                            <div className="space-y-0.5">
                              <span className="text-[10px] text-slate-400 font-semibold block uppercase">Evidence Strength</span>
                              <span className="text-slate-800 font-bold">{selectedItem.decision.evidenceStrength}</span>
                            </div>
                            <div className="space-y-0.5">
                              <span className="text-[10px] text-slate-400 font-semibold block uppercase">Rate Provenance</span>
                              <span className="text-slate-800 font-semibold">{selectedItem.decision.rateProvenance}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 pt-1 text-[10px] text-slate-500">
                            <span className="font-mono font-bold uppercase bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">{selectedItem.decision.reasonCode}</span>
                            <span>{selectedItem.decision.acceptedEvidenceCount} accepted / {selectedItem.decision.rejectedEvidenceCount} rejected historical reference(s)</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Canonical Item - the Master BOQ catalog entry this RFQ item was matched
                        to, if any. Read-only; the match itself is decided upstream by the
                        recommendation pipeline, never here. */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Canonical Item (Master BOQ Match)
                      </h4>
                      {!masterMatch ? (
                        <p className="text-xs text-slate-400 italic">No master catalog match for this item.</p>
                      ) : (
                        <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 space-y-2 text-xs">
                          <p className="text-slate-800 font-semibold leading-relaxed">{masterMatch.standardDescription}</p>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-bold text-[10px] uppercase">{masterMatch.domain}</span>
                            <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-bold text-[10px] uppercase">{masterMatch.subcategory}</span>
                            <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-mono text-[10px]">{masterMatch.standardUnit}</span>
                            <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-mono text-[10px]">{masterMatch.occurrenceCount} occurrence(s)</span>
                          </div>
                        </div>
                      )}
                    </div>

                    <hr className="border-slate-100" />

                    {/* Confidence Breakdown - the 6-facet profile from
                        ProjectCalibrationEngine.computeItemConfidenceProfile. overallConfidence is
                        the one figure the Commercial Decision Engine's approval rule actually uses;
                        the rest explain WHY it landed where it did. */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Confidence Breakdown
                      </h4>
                      {selectedItem.overallConfidence === undefined ? (
                        <p className="text-xs text-slate-400 italic">Confidence profile has not been computed for this item yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {([
                            ["Semantic", selectedItem.semanticConfidence],
                            ["Specification", selectedItem.specificationConfidence],
                            ["Pricing", selectedItem.pricingConfidence],
                            ["Engineering", selectedItem.engineeringConfidence],
                            ["Historical", selectedItem.historicalConfidence],
                            ["Overall", selectedItem.overallConfidence]
                          ] as [string, number | undefined][]).map(([label, value]) => (
                            <div key={label} className="flex items-center gap-3">
                              <span className={`w-20 shrink-0 text-[10px] font-bold uppercase ${label === "Overall" ? "text-indigo-700" : "text-slate-400"}`}>{label}</span>
                              <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${label === "Overall" ? "bg-indigo-500" : (value ?? 0) >= CONFIDENCE_APPROVAL_THRESHOLD ? "bg-emerald-400" : "bg-amber-400"}`}
                                  style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
                                />
                              </div>
                              <span className="w-10 shrink-0 text-right text-[10px] font-mono font-bold text-slate-700">{value ?? "—"}{value !== undefined ? "%" : ""}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <hr className="border-slate-100" />

                    {/* Auditor scorecard */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Automated Self-Validation Auditor Scorecard
                      </h4>
                      {!validation ? (
                        <p className="text-xs text-slate-400 italic">
                          Validation has not run for this item yet - trigger "Recommend" to generate the per-item validation report.
                        </p>
                      ) : (
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
                      )}
                    </div>

                    <hr className="border-slate-100" />

                    {/* Engineering item decomposition */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
                        <Activity className="w-3.5 h-3.5 text-indigo-500" /> Parsed Engineering Decomposition
                      </h4>
                      {!decomp ? (
                        <p className="text-xs text-slate-400 italic">
                          Engineering decomposition has not been parsed for this item yet - trigger "Recommend" to analyze it.
                        </p>
                      ) : (
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
                      )}
                    </div>
                  </div>
                )}

                {/* TAB 2: HISTORICAL EVIDENCE & SELECTION - a read-only render of the
                    marketRateStatistics the pricing chain actually produced. The engine
                    SELECTS a single best-matching historical observation and keeps the rest
                    only as corroboration - it never averages, and this panel never invents
                    numbers the backend did not compute. */}
                {activeDrawerTab === "pricing" && (
                  <div className="space-y-6 animate-fade-in">
                    {/* Supply Rate Logic - which stage produced the current Supply Rate, and why.
                        A pure read of decision.rateProvenance/reason - no logic computed here. */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Supply Rate Logic
                      </h4>
                      <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 text-xs space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-slate-400 font-semibold uppercase">Source</span>
                          <span className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 font-bold text-[10px]">
                            {selectedItem.decision?.rateProvenance || "Not yet rated"}
                          </span>
                        </div>
                        <p className="text-slate-600 leading-relaxed">{selectedItem.reason}</p>
                      </div>
                    </div>

                    {/* Engineering Adjustment Factors - only rendered when a genuine dimensional
                        model (interpolation/extrapolation/area/volume scaling) replaced the flat
                        catalog guess. See src/EngineeringAdjustmentEngine.ts. */}
                    {selectedItem.engineeringAdjustment?.applied && (
                      <div>
                        <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                          Engineering Adjustment Factors
                        </h4>
                        <div className="bg-purple-50/40 rounded-xl p-4 border border-purple-100 text-xs space-y-3">
                          <div className="flex flex-wrap gap-3">
                            <div>
                              <span className="text-[9px] text-purple-500 font-bold uppercase block">Model</span>
                              <span className="text-slate-800 font-bold">{selectedItem.engineeringAdjustment.mathematicalModel}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-purple-500 font-bold uppercase block">Confidence</span>
                              <span className="text-slate-800 font-bold font-mono">{selectedItem.engineeringAdjustment.confidence}%</span>
                            </div>
                            {selectedItem.engineeringAdjustment.isExtrapolation && (
                              <span className="self-start px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[9px] font-bold uppercase">Extrapolation</span>
                            )}
                          </div>
                          {selectedItem.engineeringAdjustment.engineeringParameters.length > 0 && (
                            <div className="overflow-x-auto rounded-lg border border-purple-100 bg-white">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-purple-50/70 text-[10px] uppercase text-slate-500">
                                    <th className="text-left font-semibold px-2.5 py-1.5">Parameter</th>
                                    <th className="text-right font-semibold px-2.5 py-1.5">Value</th>
                                    <th className="text-left font-semibold px-2.5 py-1.5">Unit</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {selectedItem.engineeringAdjustment.engineeringParameters.map((p, idx) => (
                                    <tr key={idx} className="border-t border-purple-50">
                                      <td className="px-2.5 py-1.5 font-semibold text-slate-700">{p.name}</td>
                                      <td className="px-2.5 py-1.5 text-right font-mono text-slate-700">{p.value}</td>
                                      <td className="px-2.5 py-1.5 text-slate-500">{p.unit}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {selectedItem.engineeringAdjustment.historicalReferencesUsed.length > 0 && (
                            <div className="overflow-x-auto rounded-lg border border-purple-100 bg-white">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="bg-purple-50/70 text-[10px] uppercase text-slate-500">
                                    <th className="text-left font-semibold px-2.5 py-1.5">Family Reference</th>
                                    <th className="text-right font-semibold px-2.5 py-1.5">Dimension Value</th>
                                    <th className="text-right font-semibold px-2.5 py-1.5">Rate</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {selectedItem.engineeringAdjustment.historicalReferencesUsed.map((r, idx) => (
                                    <tr key={idx} className="border-t border-purple-50">
                                      <td className="px-2.5 py-1.5 text-slate-700 break-all">{r.description}</td>
                                      <td className="px-2.5 py-1.5 text-right font-mono text-slate-600">{r.dimensionValue}</td>
                                      <td className="px-2.5 py-1.5 text-right font-mono text-slate-700">₹{r.rate.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          <p className="text-purple-900 font-medium leading-relaxed">{selectedItem.engineeringAdjustment.explanation}</p>
                        </div>
                      </div>
                    )}

                    {/* Installation Rate Logic - baseline-anchored, historical blend within
                        tolerance. See src/InstallationRateEngine.ts. */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                        Installation Rate Logic
                      </h4>
                      {selectedItem.installationRate === undefined ? (
                        <p className="text-xs text-slate-400 italic">This worksheet has no dedicated Installation Rate column - Supply Rate only.</p>
                      ) : (
                        <div className="bg-slate-50 rounded-xl p-4 border border-slate-100 text-xs space-y-2">
                          <div className="flex flex-wrap gap-3">
                            <div>
                              <span className="text-[9px] text-slate-400 font-bold uppercase block">Installation Rate</span>
                              <span className="text-slate-800 font-bold font-mono">₹{selectedItem.installationRate.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-400 font-bold uppercase block">Basis</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                                selectedItem.installationSource === "Blended" ? "bg-emerald-50 text-emerald-700"
                                  : selectedItem.installationSource === "Historical Ignored" ? "bg-amber-50 text-amber-700"
                                    : "bg-slate-200 text-slate-600"
                              }`}>{selectedItem.installationSource || "Baseline"}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-400 font-bold uppercase block">Final Installation %</span>
                              <span className="text-slate-800 font-bold font-mono">{((selectedItem.installationPercentage || 0) * 100).toFixed(1)}%</span>
                            </div>
                          </div>
                          {selectedItem.installationSource === "Blended" && (
                            <p className="text-slate-500">Blended with {selectedItem.installationReferenceCount} historical reference project(s), within the ±8pp domain-baseline tolerance.</p>
                          )}
                          {selectedItem.installationSource === "Historical Ignored" && (
                            <p className="text-amber-600">Historical installation data existed but differed from the domain baseline by more than 8pp, so it was discarded in favor of the domain baseline.</p>
                          )}
                        </div>
                      )}
                    </div>

                    <hr className="border-slate-100" />

                    {!marketStats ? (
                      <div className="text-xs text-slate-500 italic space-y-1">
                        <p>No historical evidence selection exists for this item.</p>
                        <p className="text-[10px] text-slate-400">
                          Either recommendation has not been run yet, or no commercially-equivalent historical
                          reference survived filtering (see the Discarded Evidence list on the Trace tab).
                        </p>
                      </div>
                    ) : (
                      <>
                        <div>
                          <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                            Historical Evidence Range & Selection
                          </h4>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                              <span className="text-[9px] text-slate-400 font-semibold uppercase">Min Historical Rate</span>
                              <p className="font-bold text-slate-700 font-mono">₹{marketStats.min.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                            </div>
                            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                              <span className="text-[9px] text-slate-400 font-semibold uppercase">Max Historical Rate</span>
                              <p className="font-bold text-slate-700 font-mono">₹{marketStats.max.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                            </div>
                            <div className="p-3 bg-indigo-50 border border-indigo-100 text-indigo-800 rounded-lg text-xs space-y-0.5">
                              <span className="text-[9px] text-indigo-500 font-bold uppercase">Selected Historical Rate</span>
                              <p className="font-extrabold text-indigo-700 font-mono text-sm">₹{marketStats.selectedRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                            </div>
                            <div className="p-3 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg text-xs space-y-0.5">
                              <span className="text-[9px] text-emerald-500 font-bold uppercase">Representative Rate</span>
                              <p className="font-extrabold text-emerald-700 font-mono text-sm">₹{marketStats.representativeRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                            </div>
                            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                              <span className="text-[9px] text-slate-400 font-semibold uppercase">Selected Match Score</span>
                              <p className="font-bold text-slate-700 font-mono">{marketStats.selectedMatchScore.toFixed(1)}%</p>
                            </div>
                            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                              <span className="text-[9px] text-slate-400 font-semibold uppercase">Evidence Considered</span>
                              <p className="font-bold text-slate-700 font-mono">
                                {marketStats.referenceCount} accepted ({marketStats.corroboratingCount} corroborating) / {marketStats.rejectedCount} rejected
                              </p>
                            </div>
                            {marketStats.secondBestRateDeviationPercent !== null && marketStats.secondBestRateDeviationPercent !== undefined && (
                              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-0.5">
                                <span className="text-[9px] text-slate-400 font-semibold uppercase">2nd-Best Rate Deviation</span>
                                <p className="font-bold text-slate-700 font-mono">{marketStats.secondBestRateDeviationPercent.toFixed(1)}%</p>
                              </div>
                            )}
                            {marketStats.learningAdjustmentPercent !== null && marketStats.learningAdjustmentPercent !== undefined && marketStats.learningAdjustmentPercent !== 0 && (
                              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs space-y-0.5">
                                <span className="text-[9px] text-amber-500 font-bold uppercase">Learning Adjustment</span>
                                <p className="font-bold text-amber-700 font-mono">{marketStats.learningAdjustmentPercent > 0 ? "+" : ""}{marketStats.learningAdjustmentPercent.toFixed(1)}%</p>
                              </div>
                            )}
                          </div>
                        </div>

                        <hr className="border-slate-100" />

                        {/* Real decision log - assembled from what the pipeline recorded, never invented */}
                        <div>
                          <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3">
                            Pricing Decision Log
                          </h4>
                          <div className="bg-slate-950 text-slate-300 font-mono p-4 rounded-xl text-[11px] space-y-2 border border-slate-800 leading-relaxed shadow-inner">
                            {[
                              selectedItem.reason,
                              selectedItem.recommendationTrace?.explanation,
                              selectedItem.calibrationReason,
                              marketStats.learningReason || undefined,
                              selectedItem.decision?.decisionSummary
                            ].filter(Boolean).map((logLine: any, index: number) => (
                              <div key={index} className="flex gap-2.5">
                                <span className="text-slate-500 shrink-0 select-none">[{index + 1}]</span>
                                <p className="text-slate-300">{logLine}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
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

                    {/* UOM facts - real ingested data only, never a fabricated conversion log */}
                    <div>
                      <h4 className="text-[11px] font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
                        <Scale className="w-4 h-4 text-indigo-500" /> Unit of Measurement
                      </h4>
                      <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 space-y-3">
                        {[
                          `Ingested quantity: ${selectedItem.quantity} ${selectedItem.unit}.`,
                          masterMatch
                            ? `Matched master catalog unit: ${masterMatch.standardUnit || "same as ingested"}.`
                            : "No master catalog match - the rate applies to the ingested unit as-is.",
                          ...(selectedItem.attentionFlags?.includes("UOM Conversion")
                            ? ["A UOM conversion factor was applied - the exact factor is stated in the Pricing Explanation above."]
                            : [])
                        ].map((tLine: string, index: number) => (
                          <div key={index} className="flex items-start gap-2.5 text-xs text-slate-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shrink-0 mt-1.5" />
                            <p className="leading-relaxed">{tLine}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Worksheet context - only rendered when the upload parser actually
                        extracted one for this sheet; never fabricated client-side */}
                    {worksheetCtx && (<>
                    <hr className="border-slate-100" />

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
                    </>)}
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
          <div data-tour="project-profile" className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-md w-full flex flex-col max-h-[90vh] overflow-hidden animate-zoom-in">
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
                      onChange={(e) => { setModalProjectCost(e.target.value); setProfileFieldsTouched((t) => ({ ...t, cost: true })); }}
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
                      onChange={(e) => { setModalProjectSize(e.target.value); setProfileFieldsTouched((t) => ({ ...t, size: true })); }}
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
                    onChange={(e) => { setModalProjectType(e.target.value); setProfileFieldsTouched((t) => ({ ...t, type: true })); }}
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
                    onChange={(e) => { setModalCity(e.target.value); setProfileFieldsTouched((t) => ({ ...t, city: true })); }}
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
                    onChange={(e) => { setModalBuildingGrade(e.target.value); setProfileFieldsTouched((t) => ({ ...t, grade: true })); }}
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
