import { AletheiaShell } from "@/aletheia/AletheiaShell";
import { AletheiaMatterDashboard } from "@/aletheia/AletheiaMatterDashboard";

export default async function AletheiaHome({
    searchParams,
}: {
    searchParams: Promise<{ newMatter?: string }>;
}) {
    const { newMatter } = await searchParams;

    return (
        <AletheiaShell>
            <AletheiaMatterDashboard initialNewMatterOpen={newMatter === "1"} />
        </AletheiaShell>
    );
}
