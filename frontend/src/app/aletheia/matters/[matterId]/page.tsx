import { AletheiaWorkspace } from "@/aletheia/AletheiaWorkspace";
import { RemoteMatterPage } from "@/aletheia/RemoteMatterPage";
import { getDemoWorkspace } from "@/aletheia/workflow";

export default async function MatterWorkspacePage({
    params,
}: {
    params: Promise<{ matterId: string }>;
}) {
    const { matterId } = await params;
    if (matterId !== "matter-demo-legal-001") {
        return <RemoteMatterPage matterId={matterId} />;
    }
    return <AletheiaWorkspace workspace={getDemoWorkspace()} />;
}
