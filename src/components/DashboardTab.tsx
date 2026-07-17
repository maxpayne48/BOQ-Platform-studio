import React, { useEffect, useState } from "react";
import { 
  Building2, 
  Layers, 
  FileSpreadsheet, 
  CheckCircle2, 
  TrendingUp, 
  ShieldAlert,
  ArrowRight,
  Database,
  Briefcase
} from "lucide-react";
import { DashboardMetrics, Domain } from "../types.js";

interface DashboardTabProps {
  onNavigate: (tab: string) => void;
  metricsRefreshTrigger: number;
}

export default function DashboardTab({ onNavigate, metricsRefreshTrigger }: DashboardTabProps) {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/analytics")
      .then((res) => res.json())
      .then((data) => {
        setMetrics(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load dashboard metrics:", err);
        setLoading(false);
      });
  }, [metricsRefreshTrigger]);

  if (loading || !metrics) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
        <p className="text-slate-500 font-medium">Computing dashboard analytics...</p>
      </div>
    );
  }

  const kpis = [
    {
      id: "db_kpi_1",
      title: "Historical Catalogues",
      value: metrics.historicalBOQsCount,
      desc: "Contractor pricing files processed",
      icon: FileSpreadsheet,
      color: "text-indigo-600 bg-indigo-50 border-indigo-100"
    },
    {
      id: "db_kpi_2",
      title: "Master Standard Items",
      value: metrics.masterBOQCount,
      desc: "Semantically clustered specifications",
      icon: Database,
      color: "text-emerald-600 bg-emerald-50 border-emerald-100"
    },
    {
      id: "db_kpi_3",
      title: "Active RFQ Drafts",
      value: metrics.activeRFQsCount,
      desc: "Unrated estimates in progress",
      icon: Briefcase,
      color: "text-amber-600 bg-amber-50 border-amber-100"
    },
    {
      id: "db_kpi_4",
      title: "Average Confidence",
      value: `${metrics.averageConfidence}%`,
      desc: "Across matched specification dimensions",
      icon: CheckCircle2,
      color: "text-sky-600 bg-sky-50 border-sky-100"
    }
  ];

  return (
    <div className="space-y-8 animate-fade-in text-slate-700">
      
      {/* Premium Swinub-style Bento Header section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left Information Panel with interactive speech bubble & illustration */}
        <div className="lg:col-span-2 p-6 rounded-2xl bg-slate-50 border border-slate-100 relative overflow-hidden flex flex-col justify-between min-h-[220px]">
          {/* Subtle dotted SVG background map grid */}
          <div className="absolute inset-0 opacity-10 pointer-events-none">
            <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                  <circle cx="2" cy="2" r="1.5" fill="#4f46e5" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#grid)" />
            </svg>
          </div>

          <div className="relative z-10 space-y-2">
            <span className="text-[10px] text-indigo-600 font-extrabold uppercase tracking-widest bg-indigo-50 border border-indigo-100/50 px-2.5 py-1 rounded-full">
              Your Information Center
            </span>
            <h2 className="text-xl font-extrabold font-display text-slate-900 tracking-tight mt-2">
              Flipspaces Intelligent Estimation
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed max-w-lg">
              Automate manual construction BOQ mapping by matching item descriptions, physical specifications, and general notes. Ground rates on verified historical cost databases.
            </p>
          </div>

          {/* Swinub-style Speech Bubble with pins over map */}
          <div className="relative z-10 mt-4 flex items-center gap-3">
            <div className="relative bg-white border border-slate-200/80 px-4 py-2.5 rounded-2xl shadow-3xs text-xs font-semibold text-slate-800 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
              <span>Matched & catalogued over <strong className="text-indigo-600 font-bold">12,500+ standard physical items</strong> across active hubs.</span>
              {/* Little speech arrow */}
              <div className="absolute bottom-[-6px] left-8 w-3 h-3 bg-white border-r border-b border-slate-200/80 rotate-45"></div>
            </div>
          </div>
        </div>

        {/* Right Quick Actions list (Mirrors the Incorporate, Connect, Virtual Office column in the mockup) */}
        <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6 flex flex-col justify-between">
          <div className="space-y-1">
            <span className="text-[10px] text-amber-600 font-extrabold uppercase tracking-widest">
              Quick Workspace
            </span>
            <h3 className="text-sm font-extrabold text-slate-900 tracking-tight">
              Instant Gateways
            </h3>
          </div>

          <div className="grid grid-cols-1 gap-2.5 mt-4">
            
            <button
              onClick={() => onNavigate("historical")}
              className="w-full p-3 bg-white border border-slate-100 hover:border-indigo-100 hover:shadow-3xs rounded-xl flex items-center justify-between transition-all group text-left active:scale-[0.99]"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600 shrink-0">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800 leading-none">Historical Database</h4>
                  <span className="text-[9px] text-slate-400">View contractor catalog rates</span>
                </div>
              </div>
              <span className="text-xs font-bold text-indigo-600 group-hover:translate-x-0.5 transition-transform">→</span>
            </button>

            <button
              onClick={() => onNavigate("kb")}
              className="w-full p-3 bg-white border border-slate-100 hover:border-emerald-100 hover:shadow-3xs rounded-xl flex items-center justify-between transition-all group text-left active:scale-[0.99]"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 shrink-0">
                  <Database className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800 leading-none">Specification Library</h4>
                  <span className="text-[9px] text-slate-400">Manage clustered items</span>
                </div>
              </div>
              <span className="text-xs font-bold text-emerald-600 group-hover:translate-x-0.5 transition-transform">→</span>
            </button>

            <button
              onClick={() => onNavigate("rfq")}
              className="w-full p-3 bg-white border border-slate-100 hover:border-amber-100 hover:shadow-3xs rounded-xl flex items-center justify-between transition-all group text-left active:scale-[0.99]"
            >
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600 shrink-0">
                  <Briefcase className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-slate-800 leading-none">New RFQ Estimator</h4>
                  <span className="text-[9px] text-slate-400">Upload active client tender</span>
                </div>
              </div>
              <span className="text-xs font-bold text-amber-600 group-hover:translate-x-0.5 transition-transform">→</span>
            </button>

          </div>
        </div>

      </div>

      {/* KPI Stats Grid - Swinub Style with gorgeous circular badges */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          
          // Custom Swinub-style pastel circle color maps
          let circleBg = "bg-indigo-50 text-indigo-600";
          if (kpi.id === "db_kpi_2") circleBg = "bg-emerald-50 text-emerald-600";
          if (kpi.id === "db_kpi_3") circleBg = "bg-amber-50 text-amber-600";
          if (kpi.id === "db_kpi_4") circleBg = "bg-rose-50 text-rose-600";

          return (
            <div
              id={kpi.id}
              key={kpi.id}
              className="p-5 bg-white border border-slate-100 rounded-2xl shadow-3xs flex items-center gap-4 hover:shadow-2xs transition-all duration-300"
            >
              <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${circleBg}`}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="space-y-0.5 min-w-0">
                <p className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest truncate">
                  {kpi.title}
                </p>
                <p className="text-2xl font-black font-display text-slate-900 tracking-tight">
                  {kpi.value}
                </p>
                <p className="text-[10px] text-slate-500 truncate">
                  {kpi.desc}
                </p>
              </div>
            </div>
          );
        })}
      </div>


      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Domain Distribution Chart */}
        <div className="lg:col-span-2 p-6 bg-white border border-slate-100 rounded-xl space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-500" /> Catalog Specification Distribution
            </h2>
            <span className="text-xs text-slate-400 font-medium font-mono">
              {Object.keys(metrics.domainDistribution).sort().join(" • ") || "No Active Domains"}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {Object.entries(metrics.domainDistribution).map(([domain, count]) => {
              const valCount = count as number;
              const percentages = metrics.masterBOQCount > 0 
                ? Math.round((valCount / metrics.masterBOQCount) * 100) 
                : 0;

              let themeColor = "bg-indigo-600";
              let textColor = "text-indigo-600";
              if (domain === Domain.Interior) {
                themeColor = "bg-emerald-600";
                textColor = "text-emerald-600";
              } else if (domain === Domain.Electrical) {
                themeColor = "bg-amber-500";
                textColor = "text-amber-500";
              } else if (domain === Domain.Mechanical) {
                themeColor = "bg-sky-600";
                textColor = "text-sky-600";
              }

              return (
                <div key={domain} className="p-4 bg-slate-50 rounded-lg border border-slate-100 hover:border-slate-200 transition-colors">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-semibold text-slate-700">{domain}</span>
                    <span className={`text-xs font-bold font-mono ${textColor}`}>{count} items ({percentages}%)</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2">
                    <div className={`h-2 rounded-full ${themeColor}`} style={{ width: `${percentages}%` }}></div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg flex gap-3">
            <ShieldAlert className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-800">Automated Domain Ingestion Guard</h4>
              <p className="text-xs text-slate-500 leading-relaxed">
                Platform filters out Cover Sheets, Summaries, Commercial terms, signages, and drawings automatically during ingest, registering only valid technical items.
              </p>
            </div>
          </div>
        </div>

        {/* Learning & Quality Metrics */}
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-6 flex flex-col justify-between">
          <div className="space-y-4">
            <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" /> Platform Accuracy Gains
            </h2>
            <p className="text-xs text-slate-500 leading-relaxed">
              Continuous reinforcement engine monitors your price manual overrides to dynamically optimize weights.
            </p>

            <div className="space-y-4 pt-2">
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-1">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Description Match Rate</span>
                <span className="text-slate-500 font-medium">Not Available</span>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-1">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Unit Price Deviation</span>
                <span className="text-slate-500 font-medium">Not Available</span>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs space-y-1">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider block">Manual Effort Saved</span>
                <span className="text-slate-500 font-medium">Not Available</span>
              </div>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
            <span>Systems Online • UTC Gateway</span>
            <span className="flex items-center gap-1.5 font-semibold text-emerald-600">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> Active
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
