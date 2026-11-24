import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarApprovalMenuButton, type SidebarApprovalTarget } from "./SidebarApprovalStatusMenu";

it("responds to a pending approval without activating the thread row", async () => {
  const onRowClick = vi.fn();
  const onRespond = vi.fn().mockResolvedValue(undefined);
  const target: SidebarApprovalTarget = {
    thread: {
      environmentId: EnvironmentId.make("local"),
      threadId: ThreadId.make("thread-1"),
    },
    approval: {
      requestId: RuntimeRequestId.make("approval-1"),
      requestKind: "command",
      createdAt: "2026-01-01T00:00:00.000Z",
      detail: "rm -rf ./dist",
      responseCapability: "live",
    },
  };

  await using screen = await render(
    <div onClick={onRowClick}>
      <SidebarApprovalMenuButton
        targets={[target]}
        label="Approval"
        className="text-warning"
        icon={<span aria-hidden>!</span>}
        canRespond
        onRespond={onRespond}
      />
    </div>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Approval" }));
  await expect.element(screen.getByText("rm -rf ./dist")).toBeVisible();
  await expect
    .element(screen.getByRole("menuitem", { name: "Always allow this session" }))
    .toBeVisible();
  expect(onRowClick).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("menuitem", { name: "Always allow this session" }));
  await vi.waitFor(() =>
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(target, "acceptForSession"),
  );
  expect(onRowClick).not.toHaveBeenCalled();
});
