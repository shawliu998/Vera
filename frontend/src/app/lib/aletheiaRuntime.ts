const CONFIGURED_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

let desktopApiBasePromise: Promise<string> | null = null;

export function getConfiguredAletheiaApiBase() {
  return CONFIGURED_API_BASE;
}

export async function getAletheiaApiBase(): Promise<string> {
  if (typeof window === "undefined" || !window.aletheiaDesktop?.getInfo) {
    return CONFIGURED_API_BASE;
  }

  desktopApiBasePromise ??= window.aletheiaDesktop
    .getInfo()
    .then((info) => info.backendUrl.replace(/\/$/, ""))
    .catch(() => CONFIGURED_API_BASE);

  return desktopApiBasePromise;
}
