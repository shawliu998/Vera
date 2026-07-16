"use client";

import { MatterWorkspaceOverview } from "@/features/matter-overview/MatterWorkspaceOverview";

export default function MatterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <MatterWorkspaceOverview params={params} />;
}
