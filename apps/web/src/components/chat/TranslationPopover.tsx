import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  TRANSLATION_LANGUAGES,
  type EnvironmentId,
  type TranslateResult,
} from "@t3tools/contracts";
import { CopyIcon, LanguagesIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { SelectionActionPoint } from "~/lib/selectionActions";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const failureMessage = (cause: unknown) =>
  cause !== null && typeof cause === "object" && "detail" in cause
    ? String(cause.detail)
    : cause instanceof Error
      ? cause.message
      : String(cause);

/** Translates `text` with every enabled service of the environment and shows the results. */
export function TranslationPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly position: SelectionActionPoint;
  readonly onClose: () => void;
}) {
  const { environmentId, text, onClose } = props;
  const translate = useStableCallback(
    useAtomCommand(serverEnvironment.translateText, { reportFailure: false }),
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "done"; value: TranslateResult }
  >({ kind: "loading" });
  const panelRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs the translation request on the environment's server once per opened popover
  useEffect(() => {
    let cancelled = false;
    void translate({ environmentId, input: { text } }).then((result) => {
      if (cancelled) return;
      setState(
        result._tag === "Success"
          ? { kind: "done", value: result.value }
          : { kind: "error", message: failureMessage(squashAtomCommandFailure(result)) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, text, translate]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes on Escape or a pointer press outside the portal panel
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Translation"
      className="dropdown-glass fixed z-50 flex w-[min(28rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg text-popover-foreground shadow-lg"
      style={{
        // Stays inside the window without measuring: the width is fixed, the height capped.
        left: `max(8px, min(${props.position.x}px, calc(100vw - min(28rem, 100vw - 1rem) - 8px)))`,
        top: Math.max(8, Math.min(props.position.y, window.innerHeight - 160)),
        maxHeight: `calc(100vh - ${Math.max(8, Math.min(props.position.y, window.innerHeight - 160))}px - 8px)`,
      }}
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <LanguagesIcon aria-hidden="true" className="size-3.5" />
        <span className="flex-1">
          {state.kind === "done"
            ? `→ ${TRANSLATION_LANGUAGES[state.value.targetLanguage].label}`
            : "Translate"}
        </span>
        <Button size="icon-xs" variant="ghost" aria-label="Close translation" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-3 overflow-y-auto px-3 py-2 text-sm">
        {state.kind === "loading" ? (
          <p className="text-muted-foreground">Translating…</p>
        ) : state.kind === "error" ? (
          <p className="text-destructive-foreground">{state.message}</p>
        ) : (
          state.value.results.map((result) => (
            <div key={result.serviceId} className="grid gap-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex-1 truncate">{result.name || result.serviceId}</span>
                {result.text !== undefined ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Copy ${result.name} translation`}
                    onClick={() => void writeTextToClipboard(result.text ?? "")}
                  >
                    <CopyIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              {result.text !== undefined ? (
                <p className="whitespace-pre-wrap select-text">{result.text}</p>
              ) : (
                <p className="text-destructive-foreground text-xs">{result.error}</p>
              )}
            </div>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
