import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { RemoteMatterCommandCenter } from "@/aletheia/RemoteMatterCommandCenter";

export default async function MatterAgentOpsPage({
  params,
}: {
  params: Promise<{ matterId: string }>;
}) {
  const { matterId } = await params;

  return (
    <AletheiaShell>
      <RemoteMatterCommandCenter matterId={matterId} />
    </AletheiaShell>
  );
}
