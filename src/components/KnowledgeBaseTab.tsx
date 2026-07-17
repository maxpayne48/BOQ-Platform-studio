import React, { useState, useEffect } from "react";
import { 
  Database, 
  Search, 
  Filter, 
  ChevronDown, 
  ChevronUp, 
  Layers, 
  Building, 
  Tag, 
  Activity,
  Maximize2,
  FolderOpen,
  Merge,
  Trash2,
  Check,
  AlertCircle,
  TrendingUp,
  FileText,
  Clock,
  Link,
  SlidersHorizontal,
  ChevronRight,
  X
} from "lucide-react";
import { MasterBOQItem, Domain } from "../types.js";

interface KnowledgeBaseTabProps {
  loadTrigger: number;
}

export default function KnowledgeBaseTab({ loadTrigger }: KnowledgeBaseTabProps) {
  const [catalog, setCatalog] = useState<MasterBOQItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeDomain, setActiveDomain] = useState<string>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<"variations" | "specs" | "notes" | "lineage">("variations");

  // Multi-select bulk action state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  
  // Merge Tool state
  const [showMergeTool, setShowMergeTool] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeMessage, setMergeMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Custom confirmation and notification state
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

  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const showNotification = (type: "success" | "error", text: string) => {
    setNotification({ type, text });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  useEffect(() => {
    fetchCatalog();
  }, [loadTrigger]);

  const fetchCatalog = () => {
    setLoading(true);
    fetch("/api/master-boqs")
      .then((res) => res.json())
      .then((data) => {
        setCatalog(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching Master BOQ Catalog:", err);
        setLoading(false);
      });
  };

  const toggleRow = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
    setActiveDetailTab("variations"); // reset tab on expand
  };

  // Checkbox handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(filteredCatalog.map(item => item.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectItem = (id: string, checked: boolean) => {
    if (checked) {
      setSelectedIds(prev => [...prev, id]);
    } else {
      setSelectedIds(prev => prev.filter(item => item !== id));
    }
  };

  // Bulk Delete
  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setConfirmModal({
      isOpen: true,
      title: "Bulk Delete Items",
      message: `Are you sure you want to delete ${selectedIds.length} items from the Master Knowledge Base?`,
      onConfirm: async () => {
        setConfirmModal(prev => ({ ...prev, isOpen: false }));
        try {
          const res = await fetch("/api/master-boqs/bulk-delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: selectedIds })
          });
          const data = await res.json();
          if (data.success) {
            setCatalog(prev => prev.filter(item => !selectedIds.includes(item.id)));
            setSelectedIds([]);
            showNotification("success", `Successfully deleted ${data.deletedCount} items.`);
          }
        } catch (e) {
          console.error("Bulk delete failed:", e);
          showNotification("error", "Failed to bulk delete selected items.");
        }
      }
    });
  };

  // Execute Merge
  const handleMergeItems = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mergeSourceId || !mergeTargetId) {
      setMergeMessage({ text: "Please enter both Source and Target IDs.", type: "error" });
      return;
    }
    if (mergeSourceId === mergeTargetId) {
      setMergeMessage({ text: "Source and Target items cannot be identical.", type: "error" });
      return;
    }

    try {
      const res = await fetch("/api/master-boqs/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: mergeSourceId, targetId: mergeTargetId })
      });
      const data = await res.json();
      if (data.success) {
        setMergeMessage({ text: "Specification templates merged successfully!", type: "success" });
        setMergeSourceId("");
        setMergeTargetId("");
        fetchCatalog();
        setTimeout(() => setMergeMessage(null), 3000);
      } else {
        setMergeMessage({ text: data.error || "Failed to merge items.", type: "error" });
      }
    } catch (e: any) {
      setMergeMessage({ text: e.message, type: "error" });
    }
  };

  // Filter Catalog
  const filteredCatalog = catalog.filter((item) => {
    const matchesSearch = 
      item.standardDescription.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.subcategory.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.projects.some(p => p.toLowerCase().includes(searchQuery.toLowerCase())) ||
      item.companies.some(c => c.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesDomain = activeDomain === "All" || item.domain === activeDomain;

    return matchesSearch && matchesDomain;
  });

  // Calculate high-level repository statistics
  const totalMasterItems = catalog.length;
  const totalVariations = catalog.reduce((acc, item) => acc + (item.occurrenceCount || 1), 0);
  const totalProjects = Array.from(new Set(catalog.flatMap(item => item.projects || []))).length;
  const totalEntities = Array.from(new Set(catalog.flatMap(item => item.companies || []))).length;

  return (
    <div className="space-y-6">
      {/* KPI Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-3xs flex items-center gap-4">
          <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-lg">
            <Database className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Master Items</span>
            <span className="text-lg font-bold text-slate-800 block font-mono">{totalMasterItems}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-3xs flex items-center gap-4">
          <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-lg">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Clustered Rates</span>
            <span className="text-lg font-bold text-slate-800 block font-mono">{totalVariations}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-3xs flex items-center gap-4">
          <div className="p-2.5 bg-amber-50 text-amber-600 rounded-lg">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Scanned Projects</span>
            <span className="text-lg font-bold text-slate-800 block font-mono">{totalProjects}</span>
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-slate-100 shadow-3xs flex items-center gap-4">
          <div className="p-2.5 bg-blue-50 text-blue-600 rounded-lg">
            <Building className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Unique Vendors</span>
            <span className="text-lg font-bold text-slate-800 block font-mono">{totalEntities}</span>
          </div>
        </div>
      </div>

      {/* Main Filter and Control Bar */}
      <div className="bg-white border border-slate-100 rounded-xl p-5 shadow-3xs space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-0.5">
            <h2 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
              <SlidersHorizontal className="w-4 h-4 text-indigo-500" />
              Interactive Specification Explorer
            </h2>
            <p className="text-xs text-slate-400">
              Query canonical specifications, analyze historical rate trends, and manage duplicate templates.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button 
              onClick={() => setShowMergeTool(!showMergeTool)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all flex items-center gap-1.5 ${
                showMergeTool 
                  ? "bg-slate-900 border-slate-900 text-white" 
                  : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Merge className="w-3.5 h-3.5" />
              Item Merge Assist
            </button>
            {(() => {
              const uniqueDomains = Array.from(new Set(catalog.map((item) => item.domain))).filter(Boolean).sort();
              const domainsToShow = ["All", ...uniqueDomains];
              return domainsToShow.map((dom) => (
                <button
                  key={dom}
                  onClick={() => {
                    setActiveDomain(dom);
                    setSelectedIds([]);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    activeDomain === dom
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-xs"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {dom}
                </button>
              ));
            })()}
          </div>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            id="input_search_kb_new"
            type="text"
            placeholder="Search master specifications by description, ID, subcategory, project, or bidder..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-100 rounded-lg text-xs focus:outline-none focus:border-indigo-500 text-slate-700"
          />
        </div>

        {/* Duplicate Consolidation Merge Drawer */}
        {showMergeTool && (
          <div className="p-4 bg-slate-50 rounded-lg border border-slate-150 space-y-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-800">
              <Merge className="w-4 h-4 text-indigo-500" />
              Consolidate Redundant Master Templates
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              If the engine generated multiple Master BOQ IDs for similar specifications, enter them below. All project rates, aliases, and specs will be merged into the Target ID, and the Source ID will be pruned.
            </p>
            <form onSubmit={handleMergeItems} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Source Item ID (To Prune)</label>
                <input 
                  type="text" 
                  placeholder="e.g. BOQ_004"
                  value={mergeSourceId}
                  onChange={(e) => setMergeSourceId(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">Target Item ID (To Preserve)</label>
                <input 
                  type="text" 
                  placeholder="e.g. BOQ_001"
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  className="w-full bg-white border border-slate-200 rounded px-2.5 py-1.5 text-xs focus:outline-none"
                />
              </div>
              <div className="flex items-end">
                <button 
                  type="submit"
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-bold py-2 transition-all flex items-center justify-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  Merge Specifications
                </button>
              </div>
            </form>
            {mergeMessage && (
              <div className={`p-2 rounded text-[11px] font-bold flex items-center gap-1.5 ${
                mergeMessage.type === "success" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"
              }`}>
                <AlertCircle className="w-3.5 h-3.5" />
                {mergeMessage.text}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Database Catalog Table */}
      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center bg-white border border-slate-100 rounded-xl">
          <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
          <p className="text-slate-400 text-xs">Querying system specification structures...</p>
        </div>
      ) : filteredCatalog.length === 0 ? (
        <div className="py-20 text-center bg-white border border-slate-100 rounded-xl">
          <FolderOpen className="w-10 h-10 text-slate-200 mx-auto mb-2" />
          <p className="text-xs font-bold text-slate-600">No matching master items found.</p>
          <p className="text-[10px] text-slate-400 mt-0.5">Try widening your filters or importing historic BOQs.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Bulk Action Controls */}
          {selectedIds.length > 0 && (
            <div className="bg-slate-900 text-white p-3 rounded-lg flex items-center justify-between shadow-xs">
              <span className="text-xs font-bold font-mono text-slate-300">
                {selectedIds.length} Master specifications selected
              </span>
              <button 
                onClick={handleBulkDelete}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-700 rounded text-xs font-bold flex items-center gap-1.5 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Bulk Delete Selection
              </button>
            </div>
          )}

          <div className="bg-white border border-slate-100 rounded-xl overflow-hidden shadow-3xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100 text-slate-400 font-bold uppercase tracking-wider text-[10px]">
                    <th className="p-3 w-10 text-center">
                      <input 
                        type="checkbox"
                        checked={selectedIds.length === filteredCatalog.length && filteredCatalog.length > 0}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
                      />
                    </th>
                    <th className="p-3 w-8"></th>
                    <th className="p-3">Master ID</th>
                    <th className="p-3">Domain / Subcategory</th>
                    <th className="p-3 max-w-sm">Canonical Specification</th>
                    <th className="p-3">UOM</th>
                    <th className="p-3 text-right">Base Unit Price</th>
                    <th className="p-3 text-right">Standard Unit Price</th>
                    <th className="p-3 text-center">Variations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filteredCatalog.map((item) => {
                    const isExpanded = expandedId === item.id;
                    const isSelected = selectedIds.includes(item.id);
                    let domainBadge = "bg-indigo-50 text-indigo-600 border border-indigo-100";
                    if (item.domain === Domain.Interior) domainBadge = "bg-emerald-50 text-emerald-600 border border-emerald-100";
                    else if (item.domain === Domain.Electrical) domainBadge = "bg-amber-50 text-amber-600 border border-amber-100";
                    else if (item.domain === Domain.Mechanical) domainBadge = "bg-sky-50 text-sky-600 border border-sky-100";

                    return (
                      <React.Fragment key={item.id}>
                        <tr 
                          className={`transition-colors border-l-2 hover:bg-slate-50/50 cursor-pointer ${
                            isExpanded ? "border-indigo-600 bg-slate-50/20" : "border-transparent"
                          } ${isSelected ? "bg-indigo-50/10" : ""}`}
                        >
                          <td className="p-3 text-center" onClick={(e) => e.stopPropagation()}>
                            <input 
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => handleSelectItem(item.id, e.target.checked)}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 cursor-pointer"
                            />
                          </td>
                          <td className="p-3 text-center" onClick={() => toggleRow(item.id)}>
                            {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                          </td>
                          <td className="p-3 font-mono font-medium text-slate-500 text-[11px]" onClick={() => toggleRow(item.id)}>
                            {item.id}
                          </td>
                          <td className="p-3" onClick={() => toggleRow(item.id)}>
                            <div className="space-y-0.5">
                              <span className={`inline-block px-1.5 py-0.2 rounded text-[9px] font-bold ${domainBadge}`}>
                                {item.domain}
                              </span>
                              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{item.subcategory}</p>
                            </div>
                          </td>
                          <td className="p-3 max-w-sm" onClick={() => toggleRow(item.id)}>
                            <p className="font-semibold text-slate-800 line-clamp-2 leading-relaxed" title={item.standardDescription}>
                              {item.standardDescription}
                            </p>
                          </td>
                          <td className="p-3 font-medium text-slate-600 font-mono" onClick={() => toggleRow(item.id)}>{item.standardUnit}</td>
                          <td className="p-3 text-right font-bold text-slate-800 font-mono" onClick={() => toggleRow(item.id)}>₹{item.averageRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td className="p-3 text-right font-semibold text-slate-600 font-mono" onClick={() => toggleRow(item.id)}>₹{item.medianRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td className="p-3 text-center" onClick={() => toggleRow(item.id)}>
                            <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">
                              {item.occurrenceCount}
                            </span>
                          </td>
                        </tr>

                        {/* Interactive Specification Expanded Workspace */}
                        {isExpanded && (
                          <tr className="bg-slate-50/70">
                            <td colSpan={9} className="p-5 border-l-2 border-indigo-600">
                              <div className="space-y-5">
                                {/* Detail Tab headers */}
                                <div className="border-b border-slate-200 flex items-center gap-4">
                                  <button 
                                    onClick={() => setActiveDetailTab("variations")}
                                    className={`pb-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1 ${
                                      activeDetailTab === "variations" 
                                        ? "border-slate-800 text-slate-800" 
                                        : "border-transparent text-slate-400 hover:text-slate-600"
                                    }`}
                                  >
                                    <TrendingUp className="w-3.5 h-3.5" />
                                    Clustered Variations
                                  </button>
                                  <button 
                                    onClick={() => setActiveDetailTab("specs")}
                                    className={`pb-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1 ${
                                      activeDetailTab === "specs" 
                                        ? "border-slate-800 text-slate-800" 
                                        : "border-transparent text-slate-400 hover:text-slate-600"
                                    }`}
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                    Specification Explorer
                                  </button>
                                  <button 
                                    onClick={() => setActiveDetailTab("notes")}
                                    className={`pb-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1 ${
                                      activeDetailTab === "notes" 
                                        ? "border-slate-800 text-slate-800" 
                                        : "border-transparent text-slate-400 hover:text-slate-600"
                                    }`}
                                  >
                                    <FileText className="w-3.5 h-3.5" />
                                    General Notes Explorer
                                  </button>
                                  <button 
                                    onClick={() => setActiveDetailTab("lineage")}
                                    className={`pb-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1 ${
                                      activeDetailTab === "lineage" 
                                        ? "border-slate-800 text-slate-800" 
                                        : "border-transparent text-slate-400 hover:text-slate-600"
                                    }`}
                                  >
                                    <Clock className="w-3.5 h-3.5" />
                                    Historical Item Lineage
                                  </button>
                                </div>

                                {/* Active Detail Tab Workspace */}
                                <div className="min-h-[140px]">
                                  {activeDetailTab === "variations" && (
                                    <div className="space-y-3">
                                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                        <div className="p-3 bg-white border border-slate-100 rounded-lg">
                                          <p className="text-[9px] uppercase font-bold tracking-wider text-slate-400">Rate Boundaries</p>
                                          <p className="text-xs font-bold text-slate-800 font-mono mt-0.5">
                                            ₹{item.minRate.toLocaleString()} - ₹{item.maxRate.toLocaleString()}
                                          </p>
                                        </div>
                                        <div className="p-3 bg-white border border-slate-100 rounded-lg">
                                          <p className="text-[9px] uppercase font-bold tracking-wider text-slate-400">Latest Ingested Price</p>
                                          <p className="text-xs font-bold text-slate-800 font-mono mt-0.5">
                                            ₹{item.latestRate.toLocaleString()}
                                          </p>
                                        </div>
                                        <div className="p-3 bg-white border border-slate-100 rounded-lg">
                                          <p className="text-[9px] uppercase font-bold tracking-wider text-slate-400">Contributing Bid Vendors</p>
                                          <p className="text-xs font-bold text-slate-800 mt-0.5">
                                            {Array.from(new Set(item.companies)).join(", ") || "CPWD Central Reference"}
                                          </p>
                                        </div>
                                      </div>

                                      <div className="space-y-1.5">
                                        {item.historicalDescriptions.map((desc, idx) => (
                                          <div key={idx} className="p-2.5 bg-white border border-slate-100 rounded-lg text-[11px] text-slate-600 flex justify-between items-center gap-3">
                                            <p className="font-medium italic">"{desc}"</p>
                                            <div className="shrink-0 flex items-center gap-2">
                                              <span className="text-[10px] font-bold text-indigo-600 font-mono bg-indigo-50 px-1.5 py-0.5 rounded">
                                                ₹{item.historicalRates[idx]?.toLocaleString() || "N/A"}
                                              </span>
                                              <span className="text-[9px] font-semibold text-slate-400">
                                                ({item.projects[idx]})
                                              </span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {activeDetailTab === "specs" && (
                                    <div className="p-4 bg-white border border-slate-100 rounded-lg space-y-3">
                                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                                        <FileText className="w-4 h-4 text-slate-400" />
                                        Linked Specifications & Material Clauses
                                      </div>
                                      {item.historicalSpecifications && item.historicalSpecifications.length > 0 ? (
                                        <div className="space-y-2.5 max-h-[220px] overflow-y-auto">
                                          {item.historicalSpecifications.map((spec, sidx) => (
                                            <div key={sidx} className="p-3 bg-slate-50 border border-slate-100 rounded text-xs leading-relaxed text-slate-600">
                                              {spec}
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="text-xs text-slate-400 italic">No specific material specs parsed for this item yet. Standard CPWD engineering compliance applies.</p>
                                      )}
                                    </div>
                                  )}

                                  {activeDetailTab === "notes" && (
                                    <div className="p-4 bg-white border border-slate-100 rounded-lg space-y-3">
                                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                                        <FileText className="w-4 h-4 text-slate-400" />
                                        Preamble Guidelines & General Estimator Notes
                                      </div>
                                      {item.historicalGeneralNotes && item.historicalGeneralNotes.length > 0 ? (
                                        <div className="space-y-2.5 max-h-[220px] overflow-y-auto">
                                          {item.historicalGeneralNotes.map((note, nidx) => (
                                            <div key={nidx} className="p-3 bg-slate-50 border border-slate-100 rounded text-xs leading-relaxed text-slate-600">
                                              {note}
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="text-xs text-slate-400 italic">No historical general notes captured. Standard contract schedules should be consulted.</p>
                                      )}
                                    </div>
                                  )}

                                  {activeDetailTab === "lineage" && (
                                    <div className="p-4 bg-white border border-slate-100 rounded-lg">
                                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 mb-4">
                                        <Clock className="w-4 h-4 text-slate-400" />
                                        Rate Timeline & Project Progression Mapping
                                      </div>
                                      <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-1 before:bottom-1 before:w-0.5 before:bg-slate-150">
                                        {item.projects.map((proj, idx) => (
                                          <div key={idx} className="relative flex items-start gap-4">
                                            {/* dot */}
                                            <span className="absolute -left-5 top-1.5 w-2 h-2 rounded-full bg-indigo-500 border-2 border-white ring-4 ring-indigo-50"></span>
                                            <div className="text-xs">
                                              <span className="font-bold text-slate-800">₹{item.historicalRates[idx]?.toLocaleString()}</span>
                                              <span className="text-slate-400 ml-1.5 font-medium">• Contracted under project "{proj}"</span>
                                              <div className="text-[10px] text-slate-400 mt-0.5">By Contractor: {item.companies[idx]}</div>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-sm w-full flex flex-col animate-zoom-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <AlertCircle className="w-5 h-5 text-amber-500" />
                <h2 className="text-sm font-bold text-slate-800">
                  {confirmModal.title}
                </h2>
              </div>
              <button 
                onClick={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
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
