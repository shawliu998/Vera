import type { Metadata } from "next";
import { WordTaskPane } from "@/app/components/office/WordTaskPane";

export const metadata: Metadata = {
    title: "Vera Word Review",
    description: "Review selected Word text with Vera.",
};

export default function WordAddInPage() {
    return <WordTaskPane />;
}
