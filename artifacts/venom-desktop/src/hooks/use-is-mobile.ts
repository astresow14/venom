import { useEffect, useState } from "react";

/**
 * Tailwind's `md` breakpoint, expressed as the media query the stylesheet
 * itself uses. Matching the exact rem boundary keeps JS-driven layout
 * decisions in lockstep with `md:` utilities.
 */
const DESKTOP_QUERY = "(min-width: 48rem)";

/**
 * True below the `md` breakpoint. For chrome that must *leave the DOM* on
 * phones rather than hide via CSS — hiding would keep duplicate test ids and
 * tab stops mounted — the breakpoint has to be observable from render, so it
 * lives in state and follows live viewport changes.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? !window.matchMedia(DESKTOP_QUERY).matches
      : false,
  );

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) =>
      setIsMobile(!event.matches);
    setIsMobile(!query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
