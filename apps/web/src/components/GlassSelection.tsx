import { useLayoutEffect, useRef } from "react";
import { observeResize } from "~/lib/observeResize";

type Edges = { left: number; right: number; top: number; bottom: number };
type EdgeName = keyof Edges;
const EDGES: readonly EdgeName[] = ["left", "right", "top", "bottom"];
// Underdamped springs: the leading edge is stiff and runs ahead, the trailing edge lags, so the
// capsule stretches along the motion, then both overshoot slightly and settle (the rebound).
const LEAD = { stiffness: 520, damping: 22 };
const TRAIL = { stiffness: 210, damping: 17 };

/**
 * One glass capsule shared by the controls in its positioned parent. It rests on the item marked
 * `aria-current="page"` / `data-active="true"`; with `follow` it also tracks pointer and focus while
 * they are inside, and returns to the current item (or fades out, or stays with `initial`) after.
 */
export function GlassSelection({
  selector,
  initial = false,
  follow = true,
}: {
  selector: string;
  initial?: boolean;
  follow?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks control geometry and drives an imperative DOM surface
  useLayoutEffect(() => {
    const capsule = ref.current;
    const host = capsule?.parentElement;
    if (!capsule || !host) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const current = { left: 0, right: 0, top: 0, bottom: 0 };
    const velocity = { left: 0, right: 0, top: 0, bottom: 0 };
    let goal: Edges | null = null;
    let springs: Record<EdgeName, typeof LEAD> = {
      left: LEAD,
      right: LEAD,
      top: LEAD,
      bottom: LEAD,
    };
    let visible = false;
    let frame = 0;
    let lastTime = 0;
    let target: HTMLElement | null = null;

    const paint = () => {
      capsule.style.left = `${current.left}px`;
      capsule.style.top = `${current.top}px`;
      capsule.style.width = `${Math.max(0, current.right - current.left)}px`;
      capsule.style.height = `${Math.max(0, current.bottom - current.top)}px`;
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const step = (time: number) => {
      // Clamp the step so a backgrounded tab resumes without a jump.
      const dt = Math.min(0.032, (time - lastTime) / 1000 || 0.016);
      lastTime = time;
      let settled = true;
      for (const edge of EDGES) {
        const to = goal![edge];
        const { stiffness, damping } = springs[edge];
        velocity[edge] += (stiffness * (to - current[edge]) - damping * velocity[edge]) * dt;
        current[edge] += velocity[edge] * dt;
        if (Math.abs(to - current[edge]) > 0.3 || Math.abs(velocity[edge]) > 4) settled = false;
      }
      if (settled) {
        Object.assign(current, goal);
        velocity.left = velocity.right = velocity.top = velocity.bottom = 0;
        paint();
        frame = 0;
        return;
      }
      paint();
      frame = requestAnimationFrame(step);
    };

    const edgesOf = (element: HTMLElement): Edges => {
      const bounds = element.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      const left = bounds.left - parent.left + host.scrollLeft - host.clientLeft;
      const top = bounds.top - parent.top + host.scrollTop - host.clientTop;
      return { left, right: left + bounds.width, top, bottom: top + bounds.height };
    };
    const hide = () => {
      stop();
      visible = false;
      target = null;
      capsule.style.opacity = "0";
    };
    const moveTo = (next: HTMLElement, animate: boolean) => {
      const edges = edgesOf(next);
      if (edges.right <= edges.left || edges.bottom <= edges.top) return hide();
      goal = edges;
      if (!animate || !visible || reducedMotion.matches) {
        if (frame && !animate) return; // a resize mid-flight just retargets the running springs
        stop();
        Object.assign(current, edges);
        velocity.left = velocity.right = velocity.top = velocity.bottom = 0;
        paint();
      } else {
        const forwardX = edges.left + edges.right > current.left + current.right;
        const forwardY = edges.top + edges.bottom > current.top + current.bottom;
        springs = {
          left: forwardX ? TRAIL : LEAD,
          right: forwardX ? LEAD : TRAIL,
          top: forwardY ? TRAIL : LEAD,
          bottom: forwardY ? LEAD : TRAIL,
        };
        if (!frame) {
          lastTime = performance.now();
          frame = requestAnimationFrame(step);
        }
      }
      visible = true;
      capsule.style.opacity = "1";
    };

    let stopTargetResize: (() => void) | undefined;
    const select = (next: HTMLElement | null) => {
      if (next === target) return;
      stopTargetResize?.();
      stopTargetResize = undefined;
      if (!next) {
        if (!initial || !target?.isConnected) hide();
        return;
      }
      moveTo(next, true);
      target = next;
      stopTargetResize = observeResize(next, () => {
        if (target?.isConnected) moveTo(target, false);
      });
    };
    const activeItem = () => {
      for (const item of host.querySelectorAll<HTMLElement>(selector)) {
        if (item.matches('[aria-current="page"], [data-active="true"]')) return item;
      }
      return null;
    };

    let pointerItem: HTMLElement | null = null;
    let focusItem: HTMLElement | null = null;
    const itemAt = (node: EventTarget | null) => {
      if (!(node instanceof Element)) return null;
      const item = node.closest<HTMLElement>(selector);
      return item && host.contains(item) && !item.matches(":disabled, [aria-disabled=true]")
        ? item
        : null;
    };
    const sync = () =>
      select(pointerItem ?? focusItem ?? activeItem() ?? (initial ? target : null));
    const onPointerOver = (event: PointerEvent) => {
      pointerItem = itemAt(event.target) ?? pointerItem;
      sync();
    };
    const onPointerLeave = () => {
      pointerItem = null;
      sync();
    };
    const onFocusIn = (event: FocusEvent) => {
      focusItem = itemAt(event.target);
      sync();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
      focusItem = null;
      sync();
    };
    if (follow) {
      host.addEventListener("pointerover", onPointerOver);
      host.addEventListener("pointerleave", onPointerLeave);
      host.addEventListener("focusin", onFocusIn);
      host.addEventListener("focusout", onFocusOut);
    }
    const stopHostResize = observeResize(host, () => {
      if (target?.isConnected) moveTo(target, false);
      else sync();
    });
    // Navigation flips aria-current; rows mount and unmount as folders open and lists scroll.
    const mutations = new MutationObserver(() => {
      if (pointerItem && !pointerItem.isConnected) pointerItem = null;
      if (focusItem && !focusItem.isConnected) focusItem = null;
      sync();
    });
    mutations.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-current", "data-active"],
    });
    const first =
      activeItem() ??
      (initial ? host.querySelector<HTMLElement>(`${selector}:not(:disabled)`) : null);
    if (first) select(first);
    return () => {
      stop();
      mutations.disconnect();
      stopHostResize();
      stopTargetResize?.();
      host.removeEventListener("pointerover", onPointerOver);
      host.removeEventListener("pointerleave", onPointerLeave);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
    };
  }, [selector, initial, follow]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute -z-1 rounded-full border border-white/45 bg-linear-to-b from-white/22 via-white/10 to-white/6 opacity-0 inset-shadow-2xs inset-shadow-white/60 shadow-md shadow-black/15 backdrop-blur-md backdrop-saturate-150 transition-opacity duration-150 light:border-black/10 light:from-white/80 light:via-white/55 light:to-white/40 light:inset-shadow-white light:shadow-black/8"
    />
  );
}
