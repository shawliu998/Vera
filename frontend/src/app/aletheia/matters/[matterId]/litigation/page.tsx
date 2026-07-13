import { LitigationWorkspace } from "@/aletheia/litigation/LitigationWorkspace";

export default async function LitigationMatterPage({
  params,
}: {
  params: Promise<{ matterId: string }>;
}) {
  const { matterId } = await params;
  return <LitigationWorkspace matterId={matterId} />;
}
