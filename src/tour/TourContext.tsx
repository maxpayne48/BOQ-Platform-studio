import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { TOUR_STEPS, TourStep } from "./tourSteps";

/**
 * Guided-walkthrough state.
 *
 * Persistence follows the pattern already used elsewhere in this app (App.tsx auth,
 * ThemeContext, HistoricalBOQsTab): a plain snake_case localStorage key. No backend, no
 * new dependency, no user-preferences service.
 *
 * The flag is written the moment a tour starts, not when it finishes, so a user who
 * auto-sees it once and closes the browser mid-way is never nagged again. Re-triggering
 * by hand from the header always works regardless of the flag.
 */

const TOUR_STORAGE_KEY = "has_seen_tour";

type TourActionFn = () => void;

interface TourContextValue {
  isActive: boolean;
  stepIndex: number;
  step: TourStep | null;
  totalSteps: number;
  startTour: () => void;
  endTour: () => void;
  nextStep: () => void;
  prevStep: () => void;
  registerAction: (name: string, fn: TourActionFn) => () => void;
}

const TourContext = createContext<TourContextValue | undefined>(undefined);

/**
 * Whether this browser has already been shown the walkthrough. Callers use it to decide
 * whether to auto-open the tour; the header trigger ignores it entirely, so the tour can
 * always be replayed on demand.
 */
export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(TOUR_STORAGE_KEY) === "true";
  } catch {
    // Private-mode / storage-disabled browsers: treat as "seen" so we never auto-open
    // something we cannot remember dismissing.
    return true;
  }
}

function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, "true");
  } catch {
    /* storage unavailable - the tour still runs, it just cannot be remembered */
  }
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [isActive, setIsActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  // Mirrors of the state above so the transition helpers can read the current position
  // without being re-created on every step change.
  const isActiveRef = useRef(false);
  const stepIndexRef = useRef(0);

  // Host components (App, RecommendationsTab) register the things a step is allowed to
  // do - switch tab, open the profile modal, open an item drawer. Held in a ref so
  // registering never triggers a render.
  const actionsRef = useRef<Map<string, TourActionFn>>(new Map());

  const registerAction = useCallback((name: string, fn: TourActionFn) => {
    actionsRef.current.set(name, fn);
    return () => {
      if (actionsRef.current.get(name) === fn) actionsRef.current.delete(name);
    };
  }, []);

  const runAction = useCallback((name?: string) => {
    if (!name) return;
    const fn = actionsRef.current.get(name);
    // No registered handler (e.g. the Recommendations screen is not mounted) is a normal
    // case, not a failure: the step degrades to its centred variant.
    if (!fn) return;
    try {
      fn();
    } catch (err) {
      console.error(`[tour] action "${name}" failed`, err);
    }
  }, []);

  const goToStep = useCallback(
    (nextIndex: number) => {
      const leaving = TOUR_STEPS[stepIndexRef.current];
      if (leaving && nextIndex !== stepIndexRef.current) runAction(leaving.cleanup);

      const entering = TOUR_STEPS[nextIndex];
      if (entering) runAction(entering.prepare);

      stepIndexRef.current = nextIndex;
      setStepIndex(nextIndex);
    },
    [runAction],
  );

  const startTour = useCallback(() => {
    if (isActiveRef.current) return;
    markTourSeen();
    isActiveRef.current = true;
    setIsActive(true);
    stepIndexRef.current = 0;
    setStepIndex(0);
    runAction(TOUR_STEPS[0]?.prepare);
  }, [runAction]);

  const endTour = useCallback(() => {
    if (!isActiveRef.current) return;
    // Put back whatever the current step opened, so ending the tour never leaves a modal
    // or drawer hanging over the real UI.
    runAction(TOUR_STEPS[stepIndexRef.current]?.cleanup);
    isActiveRef.current = false;
    setIsActive(false);
    stepIndexRef.current = 0;
    setStepIndex(0);
  }, [runAction]);

  const nextStep = useCallback(() => {
    if (stepIndexRef.current >= TOUR_STEPS.length - 1) {
      endTour();
      return;
    }
    goToStep(stepIndexRef.current + 1);
  }, [endTour, goToStep]);

  const prevStep = useCallback(() => {
    if (stepIndexRef.current <= 0) return;
    goToStep(stepIndexRef.current - 1);
  }, [goToStep]);

  // Note: the first-visit auto-trigger deliberately lives in App.tsx, next to the
  // authentication state, so "first login" is decided where sign-in is actually known.
  const value: TourContextValue = {
    isActive,
    stepIndex,
    step: isActive ? TOUR_STEPS[stepIndex] ?? null : null,
    totalSteps: TOUR_STEPS.length,
    startTour,
    endTour,
    nextStep,
    prevStep,
    registerAction,
  };

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within a TourProvider");
  return ctx;
}

/**
 * Lets a component lend the tour one capability ("open the profile modal", "open the
 * first item's drawer") for as long as that component is mounted. The callback is read
 * through a ref, so it always sees current props/state without re-registering.
 */
export function useTourAction(name: string, fn: TourActionFn): void {
  const { registerAction } = useTour();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => registerAction(name, () => fnRef.current()), [name, registerAction]);
}
