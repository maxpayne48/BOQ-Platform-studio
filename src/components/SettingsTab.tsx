import React, { useState, useEffect } from "react";
import { 
  Settings as SettingsIcon, 
  Cpu, 
  HelpCircle, 
  Check, 
  Save, 
  Sliders, 
  AlertCircle 
} from "lucide-react";
import { Settings } from "../types.js";

interface SettingsTabProps {
  onRefreshSettings: () => void;
}

export default function SettingsTab({ onRefreshSettings }: SettingsTabProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Status notification alert
  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load settings:", err);
        setLoading(false);
      });
  }, []);

  const showNotification = (type: "success" | "error", text: string) => {
    setNotification({ type, text });
    setTimeout(() => {
      setNotification(null);
    }, 5000);
  };

  const handleWeightChange = (key: keyof Settings["weights"], value: number) => {
    if (!settings) return;
    setSettings({
      ...settings,
      weights: {
        ...settings.weights,
        [key]: value
      }
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;

    // Verify weights sum to roughly 1.0 (or we can auto normalize them on the server/client)
    const sum = (Object.values(settings.weights) as number[]).reduce((a: number, b: number) => a + b, 0);
    if (Math.abs(sum - 1.0) > 0.05) {
      showNotification("error", `Weights sum is ${sum.toFixed(2)}. Please adjust parameters so that the weights sum to exactly 1.00 (or close to it).`);
      return;
    }

    setSaving(true);
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    })
      .then((res) => res.json())
      .then((data) => {
        setSaving(false);
        if (data.success) {
          showNotification("success", "Matching engine parameters and weight indexes updated.");
          onRefreshSettings();
        } else {
          showNotification("error", "Failed to update configuration settings.");
        }
      })
      .catch((err) => {
        setSaving(false);
        showNotification("error", "Server communication failed.");
        console.error(err);
      });
  };

  if (loading || !settings) {
    return (
      <div className="py-20 flex flex-col items-center justify-center">
        <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3"></div>
        <p className="text-slate-400 text-xs font-semibold">Loading engine settings...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
      {/* Settings Panel Banner */}
      <div className="p-6 bg-white border border-slate-100 rounded-xl space-y-1 shadow-xs">
        <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
          <SettingsIcon className="w-4 h-4 text-indigo-500" /> Match Engine Settings
        </h2>
        <p className="text-xs text-slate-400">
          Configure matching sensitivity, mathematical weights, safety above-average pricing buffers, and active GenAI models.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="p-6 bg-white border border-slate-100 rounded-xl space-y-6 shadow-xs">
        {/* Slider 1: Similarity Threshold */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1">
              Fuzzy Match Similarity Threshold
            </span>
            <span className="text-xs font-bold text-indigo-600 font-mono bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
              {(settings.similarityThreshold * 100).toFixed(0)}% Match
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            Defines the minimum character/semantic similarity needed to cluster historical descriptions into Master Specifications or recommend rates.
          </p>
          <input
            id="input_similarity_threshold"
            type="range"
            min="0.4"
            max="0.95"
            step="0.05"
            value={settings.similarityThreshold}
            onChange={(e) => setSettings({ ...settings, similarityThreshold: parseFloat(e.target.value) })}
            className="w-full accent-indigo-600"
          />
        </div>

        {/* Slider 2: Above-Average pricing buffer */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1">
              Above-Average Safety Price Buffer
            </span>
            <span className="text-xs font-bold text-indigo-600 font-mono bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
              +{settings.aboveAverageBuffer}% Buffer
            </span>
          </div>
          <p className="text-[11px] text-slate-400">
            Premium factor automatically loaded on top of direct rate lookups to buffer risk, coverage, and premium specifications.
          </p>
          <input
            id="input_above_average_buffer"
            type="range"
            min="0"
            max="30"
            step="5"
            value={settings.aboveAverageBuffer}
            onChange={(e) => setSettings({ ...settings, aboveAverageBuffer: parseInt(e.target.value) })}
            className="w-full accent-indigo-600"
          />
        </div>

        {/* Sliders: Weighted matching indices */}
        <div className="space-y-4 pt-4 border-t border-slate-100">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5 mb-1">
            <Sliders className="w-4 h-4 text-indigo-500" /> Multi-Factor Weight Configuration (Sum must equal 1.00)
          </span>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 p-4 bg-slate-50 border border-slate-100 rounded-xl">
            {/* Weight: Semantic Description */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-slate-600">
                <span>Semantic Description Similarity</span>
                <span className="font-mono text-indigo-600 font-bold">{settings.weights.semantic.toFixed(2)}</span>
              </div>
              <input
                id="input_weight_semantic"
                type="range"
                min="0.1"
                max="0.6"
                step="0.05"
                value={settings.weights.semantic}
                onChange={(e) => handleWeightChange("semantic", parseFloat(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>

            {/* Weight: Category Hierarchy */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-slate-600">
                <span>Parent Category Hierarchy</span>
                <span className="font-mono text-indigo-600 font-bold">{settings.weights.hierarchy.toFixed(2)}</span>
              </div>
              <input
                id="input_weight_hierarchy"
                type="range"
                min="0.05"
                max="0.3"
                step="0.05"
                value={settings.weights.hierarchy}
                onChange={(e) => handleWeightChange("hierarchy", parseFloat(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>

            {/* Weight: Physical Specifications */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-slate-600">
                <span>Specification Dimension Match</span>
                <span className="font-mono text-indigo-600 font-bold">{settings.weights.specification.toFixed(2)}</span>
              </div>
              <input
                id="input_weight_specification"
                type="range"
                min="0.1"
                max="0.4"
                step="0.05"
                value={settings.weights.specification}
                onChange={(e) => handleWeightChange("specification", parseFloat(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>

            {/* Weight: Preamble Specs */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-slate-600">
                <span>Preamble / General Notes Overlap</span>
                <span className="font-mono text-indigo-600 font-bold">{settings.weights.preamble.toFixed(2)}</span>
              </div>
              <input
                id="input_weight_preamble"
                type="range"
                min="0.05"
                max="0.3"
                step="0.05"
                value={settings.weights.preamble}
                onChange={(e) => handleWeightChange("preamble", parseFloat(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>

            {/* Weight: Unit Compatibility */}
            <div className="space-y-1.5 md:col-span-2">
              <div className="flex justify-between text-xs font-semibold text-slate-600">
                <span>Unit of Measurement Compatibility Check</span>
                <span className="font-mono text-indigo-600 font-bold">{settings.weights.unit.toFixed(2)}</span>
              </div>
              <input
                id="input_weight_unit"
                type="range"
                min="0.05"
                max="0.3"
                step="0.05"
                value={settings.weights.unit}
                onChange={(e) => handleWeightChange("unit", parseFloat(e.target.value))}
                className="w-full accent-indigo-600"
              />
            </div>
          </div>
        </div>

        {/* Form submit button */}
        <div className="pt-4 border-t border-slate-100 flex justify-end">
          <button
            id="btn_submit_settings"
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow-xs transition-colors inline-flex items-center gap-2"
          >
            {saving ? (
              <>
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Saving Configurations...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" /> Save Weights Configurations
              </>
            )}
          </button>
        </div>
      </form>

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
