import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Compass, X } from "lucide-react";
import { useTour } from "./TourContext";

/**
 * The walkthrough overlay: a dimmed screen with a hole cut around the real element the
 * current step is talking about, plus a small card of copy anchored next to it.
 *
 * Deliberately self-contained (no tour library added to package.json) and deliberately
 * non-trapping:
 *  - a click anywhere outside the card ends the tour;
 *  - Escape ends the tour;
 *  - the highlighted element is shown through the hole but is NOT clickable while the
 *    tour is up, so a stray click on e.g. Export can never fire a real action;
 *  - if a step's element is not on screen at all, the step still shows its copy, centred,
 *    instead of hanging or pointing at nothing.
 */

const CARD_WIDTH = 340;
const SPOTLIGHT_PADDING = 8;
const EDGE_MARGIN = 12;
const GAP = 14;

type Rect = { top: number; left: number; width: number; height: number };

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

export default function TourOverlay() {
  const { isActive, step, stepIndex, totalSteps, nextStep, prevStep, endTour } = useTour();

  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState({ width: CARD_WIDTH, height: 190 });
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  }));

  const selector = step?.target;

  // Scroll the step's element into view once, when the step changes. The element may not
  // exist yet (a `prepare` action has to render a modal or drawer first), so retry for a
  // short while before giving up and letting the step render centred.
  useEffect(() => {
    if (!isActive || !selector) return;
    let cancelled = false;
    let attempts = 0;

    const tryScroll = () => {
      if (cancelled) return;
      const el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        return;
      }
      if (attempts++ < 20) window.setTimeout(tryScroll, 60);
    };
    tryScroll();

    return () => {
      cancelled = true;
    };
  }, [isActive, selector, stepIndex]);

  // Track the element's position every frame while the tour is up. One
  // getBoundingClientRect per frame is cheap, and it keeps the spotlight glued to the
  // element through smooth scrolling, drawer slide-in animations and window resizes
  // without needing a listener for each of them.
  useEffect(() => {
    if (!isActive) return;
    let frame = 0;

    const measure = () => {
      const el = selector ? document.querySelector(selector) : null;
      let next: Rect | null = null;
      if (el) {
        const r = el.getBoundingClientRect();
        // A zero-size box (display:none, not yet laid out) counts as "not on screen".
        if (r.width > 0 && r.height > 0) {
          next = { top: r.top, left: r.left, width: r.width, height: r.height };
        }
      }
      setRect((prev) => (sameRect(prev, next) ? prev : next));
      setViewport((prev) =>
        prev.width === window.innerWidth && prev.height === window.innerHeight
          ? prev
          : { width: window.innerWidth, height: window.innerHeight },
      );
      frame = window.requestAnimationFrame(measure);
    };
    frame = window.requestAnimationFrame(measure);

    return () => window.cancelAnimationFrame(frame);
  }, [isActive, selector]);

  // Reset the anchor immediately on step change so the card never lingers over the
  // previous step's element for a frame.
  useEffect(() => {
    setRect(null);
  }, [stepIndex]);

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const r = cardRef.current.getBoundingClientRect();
    setCardSize((prev) =>
      Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5
        ? prev
        : { width: r.width, height: r.height },
    );
  });

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        endTour();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isActive, endTour]);

  if (!isActive || !step) return null;

  const spot: Rect | null = rect
    ? {
        top: rect.top - SPOTLIGHT_PADDING,
        left: rect.left - SPOTLIGHT_PADDING,
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2,
      }
    : null;

  const cardPos = computeCardPosition(spot, cardSize, step.placement, viewport);
  const isLast = stepIndex === totalSteps - 1;

  return createPortal(
    <div className="fixed inset-0 z-[9990]" role="dialog" aria-modal="true" aria-label="Dashboard walkthrough">
      {/* Click-catcher. Swallows the click (so nothing underneath fires) and ends the
          tour, which is the graceful exit for "user clicked away / wants out". */}
      <div
        className={`absolute inset-0 ${spot ? "" : "bg-slate-900/60 backdrop-blur-[1px]"}`}
        onClick={endTour}
      />

      {/* Spotlight. The dimming for the anchored case is the ring's huge outer shadow, so
          the element itself stays fully readable inside the hole. */}
      {spot && (
        <div
          className="absolute rounded-xl border-2 border-[#FFE200] pointer-events-none transition-all duration-200 ease-out"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.6), 0 0 0 4px rgba(255, 226, 0, 0.25)",
          }}
        />
      )}

      {/* Step card */}
      <div
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
        className="absolute bg-white rounded-2xl border border-slate-100 shadow-2xl p-5 space-y-3 animate-fade-in transition-[top,left] duration-200 ease-out"
        style={{ top: cardPos.top, left: cardPos.left, width: CARD_WIDTH, maxWidth: "calc(100vw - 24px)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-[#FFE200] text-black rounded-lg inline-flex items-center justify-center shrink-0">
              <Compass className="w-3.5 h-3.5" />
            </span>
            <h3 className="text-sm font-bold text-slate-800 leading-snug">{step.title}</h3>
          </div>
          <button
            onClick={endTour}
            aria-label="Close tour"
            className="p-1 -mr-1 -mt-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600 leading-relaxed">{step.body}</p>

        {!rect && step.target && (
          <p className="text-[10px] text-slate-400 leading-relaxed border-t border-slate-100 pt-2">
            This part of the screen is not open right now - open an RFQ from Upload RFQ to see it in place.
          </p>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {stepIndex + 1} of {totalSteps}
            </span>
            <button
              onClick={endTour}
              className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-600 transition-colors cursor-pointer underline underline-offset-2"
            >
              Skip tour
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={prevStep}
              disabled={stepIndex === 0}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-[11px] font-bold inline-flex items-center gap-1 transition-colors cursor-pointer hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowLeft className="w-3 h-3" /> Back
            </button>
            <button
              onClick={nextStep}
              className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold inline-flex items-center gap-1 transition-colors cursor-pointer"
            >
              {isLast ? "Done" : "Next"}
              {!isLast && <ArrowRight className="w-3 h-3" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Places the card beside the spotlight, trying the step's preferred side first and
 * falling back through the others until one fits on screen. With no spotlight (element
 * not present) the card sits in the middle of the viewport.
 */
function computeCardPosition(
  spot: Rect | null,
  card: { width: number; height: number },
  preferred: "top" | "bottom" | "left" | "right" | undefined,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const width = Math.min(CARD_WIDTH, viewport.width - EDGE_MARGIN * 2);
  const height = card.height || 190;

  if (!spot) {
    return {
      top: Math.max(EDGE_MARGIN, (viewport.height - height) / 2),
      left: Math.max(EDGE_MARGIN, (viewport.width - width) / 2),
    };
  }

  const clampLeft = (l: number) => Math.min(Math.max(l, EDGE_MARGIN), viewport.width - width - EDGE_MARGIN);
  const clampTop = (t: number) => Math.min(Math.max(t, EDGE_MARGIN), viewport.height - height - EDGE_MARGIN);

  const candidates: Record<string, { top: number; left: number }> = {
    bottom: { top: spot.top + spot.height + GAP, left: clampLeft(spot.left + spot.width / 2 - width / 2) },
    top: { top: spot.top - height - GAP, left: clampLeft(spot.left + spot.width / 2 - width / 2) },
    right: { top: clampTop(spot.top + spot.height / 2 - height / 2), left: spot.left + spot.width + GAP },
    left: { top: clampTop(spot.top + spot.height / 2 - height / 2), left: spot.left - width - GAP },
  };

  const order = [preferred ?? "bottom", "bottom", "top", "right", "left"].filter(
    (side, i, arr) => arr.indexOf(side) === i,
  );

  for (const side of order) {
    const c = candidates[side];
    if (
      c.top >= EDGE_MARGIN &&
      c.left >= EDGE_MARGIN &&
      c.top + height <= viewport.height - EDGE_MARGIN &&
      c.left + width <= viewport.width - EDGE_MARGIN
    ) {
      return c;
    }
  }

  // Nothing fits cleanly (small window, or a target filling the screen): keep the card on
  // screen and let it overlap the spotlight rather than drifting out of view.
  const fallback = candidates[preferred ?? "bottom"];
  return { top: clampTop(fallback.top), left: clampLeft(fallback.left) };
}
