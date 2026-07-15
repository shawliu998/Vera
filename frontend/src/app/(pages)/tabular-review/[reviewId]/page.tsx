"use client";

import { use } from "react";
import { TabularReviewView } from "@/app/components/tabular/TabularReviewView";

export default function StandaloneTabularReviewPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { reviewId } = use(params);
  return <TabularReviewView reviewId={reviewId} />;
}
