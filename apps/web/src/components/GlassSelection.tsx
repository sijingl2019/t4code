import { useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";

/** One moving surface shared by the controls in its positioned parent. */
export function GlassSelection({
  selector,
  initial = false,
}: {
  selector: string;
  initial?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks control geometry and animates an imperative DOM surface
  useLayoutEffect(() => {
    const capsule = ref.current;
    const host = capsule?.parentElement;
    if (!capsule || !host) return;
    let target: HTMLElement | null = null;
    let animation: Animation | undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const place = (next: HTMLElement, animate: boolean) => {
      const from = capsule.getBoundingClientRect();
      const bounds = next.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      const left = `${bounds.left - parent.left + host.scrollLeft - host.clientLeft}px`;
      const top = `${bounds.top - parent.top + host.scrollTop - host.clientTop}px`;
      if (
        !animate &&
        capsule.style.left === left &&
        capsule.style.top === top &&
        capsule.style.width === `${bounds.width}px` &&
        capsule.style.height === `${bounds.height}px`
      )
        return;
      const wasVisible = capsule.style.opacity === "1";
      animation?.cancel();
      Object.assign(capsule.style, {
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        left,
        top,
        opacity: "1",
      });
      if (!animate || !wasVisible || reducedMotion.matches || !bounds.width || !bounds.height)
        return;
      const dx = from.left + from.width / 2 - bounds.left - bounds.width / 2;
      const dy = from.top + from.height / 2 - bounds.top - bounds.height / 2;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const stretch = horizontal ? Math.abs(dx) / bounds.width : Math.abs(dy) / bounds.height;
      animation = capsule.animate(
        [
          {
            transform: `translate(${dx}px, ${dy}px) scale(${from.width / bounds.width}, ${from.height / bounds.height})`,
          },
          {
            transform: `translate(${dx * 0.45}px, ${dy * 0.45}px) scale(${horizontal ? 1 + stretch * 0.9 : 0.97}, ${horizontal ? 0.97 : 1 + stretch * 0.9})`,
            offset: 0.42,
          },
          {
            transform: `translate(${-dx * 0.025}px, ${-dy * 0.025}px) scale(${horizontal ? 0.96 : 1.02}, ${horizontal ? 1.02 : 0.96})`,
            offset: 0.76,
          },
          { transform: "translate(0, 0) scale(1, 1)" },
        ],
        { duration: 560, easing: "cubic-bezier(0.22, 0.7, 0.25, 1)" },
      );
    };
    const reposition = () => {
      if (target?.isConnected) place(target, false);
      else capsule.style.opacity = "0";
    };
    const stopHostResize = observeResize(host, reposition);
    let stopTargetResize: (() => void) | undefined;
    const select = (next: HTMLElement) => {
      if (next === target || next.matches(":disabled, [aria-disabled=true]")) return;
      stopTargetResize?.();
      place(next, true);
      target = next;
      stopTargetResize = observeResize(next, reposition);
    };
    const enter = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const next = event.target.closest<HTMLElement>(selector);
      if (next && host.contains(next)) select(next);
    };
    host.addEventListener("pointerover", enter);
    host.addEventListener("focusin", enter);
    const first =
      host.querySelector<HTMLElement>("[data-glass-thread][aria-current=page]") ??
      (initial ? host.querySelector<HTMLElement>(`${selector}:not(:disabled)`) : null);
    if (first) select(first);
    return () => {
      animation?.cancel();
      stopHostResize();
      stopTargetResize?.();
      host.removeEventListener("pointerover", enter);
      host.removeEventListener("focusin", enter);
    };
  }, [selector, initial]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute -z-1 rounded-full border border-white/40 bg-linear-to-b from-white/20 via-white/8 to-white/5 opacity-0 inset-shadow-xs inset-shadow-white/25 shadow-sm backdrop-blur-md backdrop-saturate-150"
    />
  );
}
