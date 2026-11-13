import { createFileRoute } from "@tanstack/react-router";

import { IssueBoardPage } from "../issues/IssueBoardPage";

export const Route = createFileRoute("/_chat/issues")({
  component: IssueBoardPage,
});
