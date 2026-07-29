/**
 * Guided walkthrough step definitions.
 *
 * Every `target` is a selector for a REAL element that already exists in the product
 * (marked with a `data-tour` attribute at its render site) - nothing here is a mock or a
 * placeholder screen. If a target happens not to be on screen (e.g. the user starts the
 * tour from the Dashboard and has never opened an RFQ), the step still shows, centred,
 * with the same copy - see TourOverlay.
 *
 * `prepare` / `cleanup` name actions that host components register with the tour
 * (see TourContext.useTourAction). They exist so a step can open the real modal/drawer it
 * is describing and then put it back exactly as it was. A step whose action nobody has
 * registered simply degrades to the centred variant.
 *
 * Copy rules: plain language, 1-3 short sentences, no internal jargon.
 */

export interface TourStep {
  /** Stable id, used for keys and debugging. */
  id: string;
  /** CSS selector for the real element to spotlight. */
  target?: string;
  title: string;
  body: string;
  /** Registered action run when the step is entered. */
  prepare?: string;
  /** Registered action run when the step is left (in either direction, or on exit). */
  cleanup?: string;
  /** Preferred tooltip side; the overlay flips/clamps this to fit the viewport. */
  placement?: "top" | "bottom" | "left" | "right";
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "upload",
    target: '[data-tour="rfq-upload"]',
    prepare: "goto-rfq-tab",
    placement: "right",
    title: "Two kinds of file",
    body:
      "A historical BOQ is an old project that was already priced - you add those under Historical BOQs so there is real past work to compare against. A new RFQ is the unpriced sheet you drop here to get rates for.",
  },
  {
    id: "profile",
    target: '[data-tour="project-profile"]',
    prepare: "open-profile-modal",
    cleanup: "close-profile-modal",
    placement: "right",
    title: "What the project details are for",
    body:
      "Cost, size, type, city and grade are only used to pick which past project is a fair comparison. They never change an item's price on their own - but leaving them blank or wrong means the wrong past project gets used as evidence.",
  },
  {
    id: "summary",
    target: '[data-tour="summary-bar"]',
    placement: "bottom",
    title: "How your items came out",
    body:
      "Auto Approved found a close match in past projects and needs nothing from you. Needs Review found a match worth a second look. Manual Pricing means no confident match was found and you price it yourself - that is a normal outcome, not an error.",
  },
  {
    id: "drawer",
    target: '[data-tour="drawer-tabs"]',
    prepare: "open-first-item",
    cleanup: "close-item-drawer",
    placement: "bottom",
    title: "Why an item got its rate",
    body:
      "Click any row to open it. Self-Validation & Specs shows what was read from your line, Pricing Statistics shows the range of past rates, and UOM Trace & Context holds the Recommendation Trace - the table of past projects behind the number, and the place to check why a rate was chosen.",
  },
  {
    id: "export",
    target: '[data-tour="export-button"]',
    placement: "bottom",
    title: "Getting the sheet back out",
    body:
      "This returns your original workbook with the rates filled in and the formatting untouched. Manual Pricing rows come out clearly flagged with a blank or zero rate - those are not real prices, so fill them in before you send the sheet on.",
  },
];
