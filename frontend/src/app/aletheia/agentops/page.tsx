import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { MatterCommandCenter } from "@/components/agentops/MatterCommandCenter";

export default function AletheiaAgentOpsPage() {
  return (
    <AletheiaShell>
      <MatterCommandCenter />
    </AletheiaShell>
  );
}
