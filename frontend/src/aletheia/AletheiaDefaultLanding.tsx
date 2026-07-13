"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  landingPath,
  readAletheiaSettings,
  writeAletheiaSettingsCache,
} from "./settingsModel";
import { apiSettingsTransport } from "./settingsTransport";

export function AletheiaDefaultLanding() {
  const router = useRouter();

  useEffect(() => {
    if (!window.aletheiaDesktop) return;
    let cancelled = false;
    void apiSettingsTransport
      .load()
      .then((document) => {
        if (cancelled) return;
        writeAletheiaSettingsCache(document.settings);
        router.replace(landingPath(document.settings));
      })
      .catch(() => {
        if (!cancelled) router.replace(landingPath(readAletheiaSettings()));
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
