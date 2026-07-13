"use client";

import { useEffect, useState } from "react";
import {
  acknowledgeAletheiaTaskNotification,
  claimAletheiaTaskNotifications,
} from "@/app/lib/aletheiaApi";
import { ALETHEIA_SETTINGS_EVENT, readAletheiaSettings } from "./settingsModel";
import { claimedDeadlineNotification } from "./deadlineNotifications";
import { emitAletheiaNotification } from "./AletheiaNotificationCenter";

const pollMilliseconds = 5 * 60 * 1000;

export function AletheiaDeadlineMonitor() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    const sync = () => setEnabled(readAletheiaSettings().notifications);
    sync();
    window.addEventListener(ALETHEIA_SETTINGS_EVENT, sync);
    return () => window.removeEventListener(ALETHEIA_SETTINGS_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let running = false;

    const scan = async () => {
      if (running || disposed) return;
      running = true;
      try {
        const batch = await claimAletheiaTaskNotifications();
        if (disposed) return;
        for (const withdrawal of batch.withdrawals) {
          if (window.aletheiaDesktop?.dismissNotification) {
            await window.aletheiaDesktop
              .dismissNotification(withdrawal.tag)
              .catch(() => undefined);
          }
        }
        for (const claim of batch.claims) {
          const notification = claimedDeadlineNotification(claim);
          let outcome: "delivered" | "failed" = "delivered";
          let failureCode: string | null = null;
          if (window.aletheiaDesktop?.showNotification) {
            try {
              const result =
                await window.aletheiaDesktop.showNotification(notification);
              if (!result.shown) {
                outcome = "failed";
                failureCode = result.supported
                  ? "display_rejected"
                  : "unsupported";
              }
            } catch {
              outcome = "failed";
              failureCode = "native_error";
            }
          }
          if (outcome === "delivered") {
            emitAletheiaNotification(notification);
          }
          await acknowledgeAletheiaTaskNotification(claim.deliveryId, {
            leaseToken: claim.leaseToken,
            outcome,
            failureCode,
          });
        }
      } catch {
        // The Work Queue remains the source of truth when a background scan fails.
      } finally {
        running = false;
      }
    };

    const timer = window.setInterval(() => void scan(), pollMilliseconds);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void scan();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void scan();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return null;
}
