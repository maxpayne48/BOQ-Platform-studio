import React, { useEffect, useState } from "react";
import { 
  TrendingUp, 
  Layers, 
  Award, 
  Database,
  Building,
  TrendingDown,
  LineChart,
  BarChart,
  HelpCircle
} from "lucide-react";
import { DashboardMetrics, Domain } from "../types.js";

interface AnalyticsTabProps {
  loadTrigger: number;
}

export default function AnalyticsTab({ loadTrigger }: AnalyticsTabProps) {
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
        console.error("Failed to fetch analytics metrics:", err);
        setLoading(false);
      });
  }, [loadTrigger]);

  if (loading || !metrics) {
    return (
      <div className="py-20 flex flex-col items-center justify-center">
        <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-slate-400 text-xs">Computing analytical index trends...</p>
      </div>
    );
  }

  // Draw an inline responsive SVG line plot for Learning Curve
  const maxTurn = metrics.learningAccuracyHistory.length;
  const accuracyPoints = metrics.learningAccuracyHistory;
  const padding = 40;
  const chartHeight = 150;
  const chartWidth = 500;

  // Compute SVG coordinates
  const svgPoints = accuracyPoints.map((pt, i) => {
    const x = padding + (i / (maxTurn - 1)) * (chartWidth - padding * 2);
    // Accuracy from 50 to 100
    const y = chartHeight - padding - ((pt.accuracy - 50) / 50) * (chartHeight - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Banner */}
      <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-1 shadow-xs">
        <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
          <LineChart className="w-4 h-4 text-indigo-500" /> Commercial Analytics & Cost Indexing
        </h2>
        <p className="text-xs text-slate-400">
          Synthesized pricing baselines and matching learning tracking derived dynamically from the Master BOQ Catalog.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Cost Index Baselines Chart (6 Month baseline) */}
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs relative overflow-hidden flex flex-col justify-between min-h-[220px]">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-indigo-500" /> Weighted Cost Index Trend
            </h3>
            <span className="text-[10px] text-slate-400 font-mono">Dynamic Baseline</span>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Illustrates the monthly pricing indices trend calculated dynamically from historical contractor uploads. Helps identify structural cost escalations.
          </p>

          <div className="bg-slate-50 border border-slate-100 rounded-xl p-6 text-center flex flex-col items-center justify-center space-y-1">
            <span className="text-xs font-bold text-slate-500">Not Available</span>
            <span className="text-[10px] text-slate-400">Awaiting sufficient historical cost databases to generate monthly baselines</span>
          </div>
        </div>

        {/* AI Learning Curve Plot */}
        <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs relative overflow-hidden flex flex-col justify-between min-h-[220px]">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <Award className="w-4 h-4 text-emerald-500" /> Estimator Overrides Learning Progress
            </h3>
            <span className="text-[10px] text-emerald-700 font-bold font-mono bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100">
              Active Correction Model
            </span>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Plots the precision accuracy gains of the NLP tokenizer. As estimators make custom price overrides, weights adapt automatically, raising matching accuracy over subsequent sessions.
          </p>

          <div className="bg-slate-50 border border-slate-100 rounded-xl p-6 text-center flex flex-col items-center justify-center space-y-1">
            <span className="text-xs font-bold text-slate-500">Not Available</span>
            <span className="text-[10px] text-slate-400">Awaiting manual overrides to compute accuracy improvement metrics</span>
          </div>
        </div>
      </div>

      {/* Outlier Tracking panel */}
      <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-4 shadow-xs">
        <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
          <TrendingDown className="w-4 h-4 text-rose-500" /> Outlier Pruning Rules
        </h3>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Platform automatically applies an outlier pruning filter to ensure pricing integrity. Contractor rate submissions that deviate by <span className="font-bold text-rose-600">+/- 35%</span> from the running median of that item standard specification are excluded as outliers. This protects matched catalog averages from bid errors or highly irregular vendor quotations.
        </p>
        <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs">
          <span className="text-slate-400 font-semibold font-mono">Status: Not Available (Awaiting historical rate distributions)</span>
        </div>
      </div>
    </div>
  );
}
