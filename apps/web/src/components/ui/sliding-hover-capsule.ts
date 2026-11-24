import { useRef } from "react";

export const SLIDING_HOVER_CAPSULE_TARGET = "data-sliding-hover-capsule-target";

const SLIDE_DURATION_MS = 500;
const STRETCH_DURATION_MS = 520;
const SLIDE_EASING = "cubic-bezier(0.16, 0.92, 0.22, 1.24)";

export function useSlidingHoverCapsule<
  Root extends HTMLElement,
  Capsule extends HTMLElement,
  Fill extends HTMLElement,
>() {
  const rootRef = useRef<Root>(null);
  const capsuleRef = useRef<Capsule>(null);
  const fillRef = useRef<Fill>(null);
  const stretchRef = useRef<Animation | null>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);

  const hideCapsule = () => {
    const capsule = capsuleRef.current;
    activeTargetRef.current = null;
    stretchRef.current?.cancel();
    stretchRef.current = null;
    if (!capsule) return;
    capsule.style.transition = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "none"
      : "opacity 120ms ease-out";
    capsule.style.opacity = "0";
  };

  const moveCapsule = (target: HTMLElement) => {
    const root = rootRef.current;
    const capsule = capsuleRef.current;
    const fill = fillRef.current;
    if (!root || !capsule || !fill || target === activeTargetRef.current) return;

    const rootRect = root.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const rootStyle = getComputedStyle(root);
    const borderLeft = Number.parseFloat(rootStyle.borderLeftWidth) || 0;
    const borderRight = Number.parseFloat(rootStyle.borderRightWidth) || 0;
    const borderTop = Number.parseFloat(rootStyle.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(rootStyle.borderBottomWidth) || 0;
    const paddingLeft = Number.parseFloat(rootStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(rootStyle.paddingRight) || 0;
    const paddingTop = Number.parseFloat(rootStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(rootStyle.paddingBottom) || 0;
    // Cover the root padding box and border, including the absolute child's border offset.
    const x = targetRect.left - rootRect.left - borderLeft * 2 - paddingLeft;
    const y = targetRect.top - rootRect.top - borderTop * 2 - paddingTop;
    const firstTarget = activeTargetRef.current === null;
    const currentTransform = getComputedStyle(capsule).transform;
    const currentX =
      firstTarget || currentTransform === "none" ? x : new DOMMatrixReadOnly(currentTransform).m41;
    const direction = firstTarget ? 0 : Math.sign(x - currentX);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    capsule.style.width = `${targetRect.width + borderLeft + borderRight + paddingLeft + paddingRight}px`;
    capsule.style.height = `${targetRect.height + borderTop + borderBottom + paddingTop + paddingBottom}px`;
    capsule.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    capsule.style.opacity = "1";
    capsule.style.transition =
      reduceMotion || firstTarget
        ? "none"
        : `transform ${SLIDE_DURATION_MS}ms ${SLIDE_EASING}, opacity 120ms ease-out`;

    stretchRef.current?.cancel();
    stretchRef.current = null;
    if (!reduceMotion && direction !== 0) {
      fill.style.transformOrigin = direction < 0 ? "right center" : "left center";
      const lead = direction * 3.5;
      const recoil = direction * -1.5;
      stretchRef.current = fill.animate(
        [
          { transform: "translateX(0) scaleX(1)" },
          { transform: `translateX(${direction * 1.5}%) scaleX(1.09)`, offset: 0.24 },
          { transform: `translateX(${lead}%) scaleX(0.9825)`, offset: 0.7 },
          { transform: `translateX(${recoil}%) scaleX(1.0075)`, offset: 0.86 },
          { transform: "translateX(0) scaleX(1)" },
        ],
        {
          duration: STRETCH_DURATION_MS,
          easing: "linear",
        },
      );
    }

    activeTargetRef.current = target;
  };

  return { rootRef, capsuleRef, fillRef, hideCapsule, moveCapsule };
}
