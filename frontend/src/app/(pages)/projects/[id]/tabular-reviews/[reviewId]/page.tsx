"use client";

import { use } from "react";
import { TabularReviewView } from "@/app/components/tabular/TabularReviewView";

export default function ProjectTabularReviewPage({
  params,
}: {
  params: Promise<{ id: string; reviewId: string }>;
}) {
  const { id, reviewId } = use(params);
  return <TabularReviewView reviewId={reviewId} projectId={id} />;
}
