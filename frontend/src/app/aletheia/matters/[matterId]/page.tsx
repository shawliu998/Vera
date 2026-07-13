import { redirect } from "next/navigation";

export default async function MatterWorkspacePage({
  params,
}: {
  params: Promise<{ matterId: string }>;
}) {
  const { matterId } = await params;
  redirect(
    `/aletheia/matters/${encodeURIComponent(matterId)}/litigation?view=overview`,
  );
}
