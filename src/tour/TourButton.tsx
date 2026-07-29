import React from "react";
import { HelpCircle } from "lucide-react";
import { useTour } from "./TourContext";

/**
 * Always-available way back into the walkthrough. Lives in the header next to the theme
 * toggle, so the tour is never a one-shot popup - it can be replayed at any time, by any
 * user, whether or not they have seen it before.
 */
export default function TourButton({ compact = false }: { compact?: boolean }) {
  const { startTour, isActive } = useTour();

  return (
    <button
      // The mobile and desktop headers both render one of these, so they cannot share an id.
      id={compact ? "btn_start_tour_mobile" : "btn_start_tour"}
      onClick={startTour}
      disabled={isActive}
      title="Take a tour of the dashboard"
      aria-label="Take a tour of the dashboard"
      className={`inline-flex items-center gap-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
        compact ? "p-2" : "px-2.5 py-2"
      }`}
    >
      <HelpCircle className="w-4 h-4 shrink-0" />
      {!compact && (
        <span className="text-[10px] font-extrabold uppercase tracking-wider hidden sm:inline">Take a tour</span>
      )}
    </button>
  );
}
