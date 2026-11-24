import { useGT } from "gt-react";
import { useId, useRef, useState } from "react";

import { sanitizeNewRefName } from "@t3tools/shared/git";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function BranchNameDialog({
  title,
  description,
  initialName = "",
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  description: string;
  initialName?: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (branchName: string) => void;
}) {
  const gt = useGT();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const nextBranchName = sanitizeNewRefName(value);
  const canSubmit = nextBranchName.length > 0 && nextBranchName !== initialName;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogPopup initialFocus={inputRef}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit(nextBranchName);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel scrollFade={false}>
            <div className="flex flex-col gap-2">
              <Label htmlFor={inputId}>{gt("Branch name")}</Label>
              <Input
                ref={inputRef}
                autoFocus
                id={inputId}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              {gt("Cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
