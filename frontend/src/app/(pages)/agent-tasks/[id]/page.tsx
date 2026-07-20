import { AgentTaskWorkspace } from "@/app/components/agent/AgentTaskWorkspace";

export default async function AgentTaskPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;
    return <AgentTaskWorkspace taskId={id} />;
}
