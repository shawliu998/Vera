"use client";

import { useEffect, useState } from "react";
import { ALETHEIA_SETTINGS_EVENT, readAletheiaSettings } from "./settingsModel";

const NOTIFICATION_EVENT = "aletheia-notification";
const TOAST_DURATION_MS = 5_000;

export type AletheiaNotification = {
  title: string;
  body: string;
  tag?: string;
  href?: string;
  nativeHandled?: boolean;
};

export function emitAletheiaNotification(notification: AletheiaNotification) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AletheiaNotification>(NOTIFICATION_EVENT, {
      detail: notification,
    }),
  );
}

export async function requestAletheiaNotificationPermission() {
  if (typeof window === "undefined") return "unsupported" as const;
  if (window.aletheiaDesktop?.getNotificationSupport) {
    const result = await window.aletheiaDesktop.getNotificationSupport();
    return result.supported ? ("granted" as const) : ("unsupported" as const);
  }
  if (!("Notification" in window)) return "unsupported" as const;
  if (Notification.permission === "default") {
    return Notification.requestPermission();
  }
  return Notification.permission;
}

export function AletheiaNotificationCenter() {
  const [enabled, setEnabled] = useState(true);
  const [toast, setToast] = useState<AletheiaNotification | null>(null);

  useEffect(() => {
    const syncSettings = () => setEnabled(readAletheiaSettings().notifications);
    syncSettings();
    window.addEventListener(ALETHEIA_SETTINGS_EVENT, syncSettings);
    return () =>
      window.removeEventListener(ALETHEIA_SETTINGS_EVENT, syncSettings);
  }, []);

  useEffect(() => {
    const timeouts = new Set<number>();
    const onNotification = (event: Event) => {
      if (!enabled) return;
      const notification = (event as CustomEvent<AletheiaNotification>).detail;
      if (!notification?.title || !notification.body) return;
      setToast(notification);
      const timeout = window.setTimeout(() => {
        setToast(null);
        timeouts.delete(timeout);
      }, TOAST_DURATION_MS);
      timeouts.add(timeout);

      if (notification.nativeHandled) {
        return;
      }
      if (window.aletheiaDesktop?.showNotification) {
        void window.aletheiaDesktop.showNotification(notification).catch(() => {
          // The in-app toast remains available if macOS rejects the notification.
        });
      } else if (
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification(notification.title, {
            body: notification.body,
            tag: notification.tag,
          });
        } catch {
          // The in-app toast remains available when browser notifications are blocked.
        }
      }
    };
    window.addEventListener(NOTIFICATION_EVENT, onNotification);
    return () => {
      window.removeEventListener(NOTIFICATION_EVENT, onNotification);
      for (const timeout of timeouts) window.clearTimeout(timeout);
    };
  }, [enabled]);

  if (!toast || !enabled) return null;
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[120] w-[min(360px,calc(100vw-2rem))] rounded-lg border border-gray-200 bg-white p-3 shadow-[0_12px_36px_rgba(15,23,42,0.14)]"
      role="status"
      aria-live="polite"
      data-testid="aletheia-notification-toast"
    >
      <p className="text-sm font-semibold text-gray-950">{toast.title}</p>
      <p className="mt-1 text-xs leading-5 text-gray-600">{toast.body}</p>
    </div>
  );
}
