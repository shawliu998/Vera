import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const DESKTOP_CSP_FLAG = "VERA_DESKTOP_CSP";
const DESKTOP_BACKEND_ORIGIN = "VERA_DESKTOP_BACKEND_ORIGIN";

function loopbackBackendOrigin() {
  const raw = process.env[DESKTOP_BACKEND_ORIGIN]?.trim();
  if (!raw) return null;
  try {
    const value = new URL(raw);
    if (
      value.protocol !== "http:" ||
      value.hostname !== "127.0.0.1" ||
      !value.port ||
      value.username ||
      value.password ||
      value.pathname !== "/" ||
      value.search ||
      value.hash ||
      value.origin !== raw
    ) {
      return null;
    }
    return value.origin;
  } catch {
    return null;
  }
}

function policy(nonce: string, backendOrigin: string) {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${backendOrigin}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  if (process.env[DESKTOP_CSP_FLAG] !== "true") {
    return NextResponse.next();
  }
  const backendOrigin = loopbackBackendOrigin();
  if (!backendOrigin) {
    return new NextResponse("Desktop security configuration is unavailable.", {
      status: 503,
      headers: {
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicy = policy(nonce, backendOrigin);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|icon.png|apple-touch-icon.png).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
