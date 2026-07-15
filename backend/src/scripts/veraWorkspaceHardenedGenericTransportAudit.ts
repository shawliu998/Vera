import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { createSecureContext } from "node:tls";

import {
  createHardenedGenericTransport,
  HardenedGenericTransportPolicyError,
  isExactGenericTransportLoopback,
  isPublicGenericTransportAddress,
  pinnedGenericRequestOptions,
} from "../lib/workspace/providers/hardenedGenericTransport";

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDLf14jazEdTC+o
+owV2Cb4hxGSlxngIxVuRcSQ/5kC9q/JRoXn6WJiEgbNJ3y6j1R9l4w5pmw2oFUP
e+QyPmq1NvWTq4Qfh6DcDI6plg4GsZ32K24fpspLcCcgB+xBae1M9D6QoYRK7ggO
J6Dz5E3cvrpghQcbJrjRG633Nt5NIYd/0Y8ap2Net1aWzld9MZFz9IYxPSOQTV1q
Wj75QseSovLGfOyshunwO2R4Mm1eJuyu8iuLTcuIIPBwt/z3OirkE8io+pB2a1ew
bHOXPar+9HSwP/UGJc4qGHDua4MbRAPYfuJ+Xo2BAnfBGEazKfo+3XqKuAQH6U/u
KUTY/727AgMBAAECggEADIOPmpP76n9zmJAqBgVLhe1E/vFzhFRNIKYmi6FFUo0w
sCrwxfaU3GGbsS22mgCmHsAvdKFCCOOlwJS4z0kF5f6h7f4WSOTwICXD0v2kSJjP
TBUWxUYVLSmRt4KuXDNuqnk7LNskJabh5xKlpjC8FiyeH3fuwO+ugrMjxEWjE/7H
g/g4RIVCkCN4YTg9JUy7sUUenp1DcSxq6rZM6O87AkKmWkni5xX64WcmjBGzQPio
xAovdAxE2Ah7L/EywwdF6jMVGNbbIBGIxUrW8ytAhcuaMIK84qeDOisTY+IleqkQ
vNwYC0jC7N+ZSpPhXN67DkN2XsjQwKJ06LORk5DnUQKBgQD6IU+FU8J0C73KjyQZ
aRsTNPUVmU0Xb4HNcCPiAXTu4E5lLGm12JwI2m80NrdDBNaZfNMZfB4g/HFFFZR0
SW1GHdIz/nLQl39AwqH5L7PhCBZXkmmZols0iiwMGdOb6DamwZ2cv1hl8m/F9e8l
lupr/tgXtG4Liz6T3f/wsBlWIwKBgQDQRefdrrIH5AA8/ik5wte8DVhbyNRNmZOF
lDFAQnNsRVTLpd/1XcZ5fmyg3XlI3npm4Rk2of4XE0iYt6WQDRbWCOGSdPnIFoZm
8xQxX14Rzc6IqPjHTkccAkV/OLt/VhAwDrlARLZlDPTMGS5gz5THXX0/MeuW2CIo
DrcpzPaXiQKBgG8purOgY/068qBBOWPpqFTC5mEw/mf58JAi1G+vAg7ftTeVo21j
1QTCP0XPQ2cPkWgpZ5Ad7y3tw1FWo+GCeIP+4NqmrNQzYCSh22ZpYuIRvAwzT6ct
1qbk+WpvV/IkI5W82pU9HMZCFpa+FAh6p7hTTCpMz9NlkOwab5LCUKBNAoGAH5xs
m9X3CYGOk7NT2IN9MPqpjYzGxFxp6p1aeFFdqXJAc4RioKAyDqCkpinXTbsOwuyp
YgRmR2RS4XMGOv3xmFzSt+LvQnJAxgFg8Dl0Uql1DoLu93knC9ZAbBXVR3dtj428
ikejk2TLButPgbwf7b5/0walpkh5rrDFFiAY0VkCgYEA3/4rV8CG9ctIyWiNJw51
H20UQxqfOU2tQQpI2UTWaMhSzFefD54+8LPWzgPYRd/M3QPT12vgDnkgoW+oVyzA
u1k+vjdt13QQaVI8ak7HIZNRcX5ZqEX08y9tKRLn0FwlgMZS7UfCxR7ACgsPRuw/
m5J6fq4Be+3PFHue/tOL0AA=
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUN/2WFE/SJVVfvJMjHI1eOiZu2hgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxNDIwNTcyM1oXDTM2MDcx
MTIwNTcyM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAy39eI2sxHUwvqPqMFdgm+IcRkpcZ4CMVbkXEkP+ZAvav
yUaF5+liYhIGzSd8uo9UfZeMOaZsNqBVD3vkMj5qtTb1k6uEH4eg3AyOqZYOBrGd
9ituH6bKS3AnIAfsQWntTPQ+kKGESu4IDieg8+RN3L66YIUHGya40Rut9zbeTSGH
f9GPGqdjXrdWls5XfTGRc/SGMT0jkE1dalo++ULHkqLyxnzsrIbp8DtkeDJtXibs
rvIri03LiCDwcLf89zoq5BPIqPqQdmtXsGxzlz2q/vR0sD/1BiXOKhhw7muDG0QD
2H7ifl6NgQJ3wRhGsyn6Pt16irgEB+lP7ilE2P+9uwIDAQABo1MwUTAdBgNVHQ4E
FgQUHwcrgi1vBrdUJQaYmdkU3FXu3IYwHwYDVR0jBBgwFoAUHwcrgi1vBrdUJQaY
mdkU3FXu3IYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEALl4Q
iAHZyxP32AVu1Zfmgr7uLJIi/ISFBHVY7RMEK2qHYj2TzSX2EgBSABAu6kYDocti
uAimiHjQ8vMXxPNw86Op4g/adD6u1KTg3ewSoLNPxThk05KU+1BglI22f+EulYpf
/GHXLkhIh7DI0CfiqwYEGD7CHMeFVuffVwHE2elHZzxBziv2XYL0PU+Xi7RfhONB
ahmsidem5gJQevCNgLtMmry+xYp/xFXk7MRRnRjZQVbJT/WMRW29zi1V78WMDKww
SPL4qEB2wkz/EkzyUb1fnU9/6lW0FJTG55WdgNFMM1S1wf+Ln/qnbqLYyU5FZBtA
kpIRvRgTNx12BlYRCw==
-----END CERTIFICATE-----`;

async function listen(server: http.Server | https.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server | https.Server) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function policyCode(code: HardenedGenericTransportPolicyError["code"]) {
  return (error: unknown) =>
    error instanceof HardenedGenericTransportPolicyError &&
    error.code === code;
}

async function auditAddressPolicy() {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPublicGenericTransportAddress(address), true, address);
  }
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "198.51.100.1",
    "224.0.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "fe80::1",
    "fec0::1",
    "fc00::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicGenericTransportAddress(address), false, address);
  }
  assert.equal(isExactGenericTransportLoopback("localhost"), true);
  assert.equal(isExactGenericTransportLoopback("127.12.0.1"), true);
  assert.equal(isExactGenericTransportLoopback("::1"), true);
  assert.equal(isExactGenericTransportLoopback("foo.localhost"), false);
  assert.equal(isExactGenericTransportLoopback("0.0.0.0"), false);

  const pinned = pinnedGenericRequestOptions(
    new URL("https://gateway.example.test:8443/v1/models"),
    { address: "8.8.8.8", family: 4 },
    "GET",
    { accept: "application/json" },
  );
  assert.equal(pinned.hostname, "8.8.8.8");
  assert.equal(pinned.servername, "gateway.example.test");
  assert.equal(pinned.rejectUnauthorized, true);
  assert.equal(pinned.agent, false);
  assert.equal(
    (pinned.headers as Record<string, string>).host,
    "gateway.example.test:8443",
  );
}

async function auditDnsAndStreaming() {
  let redirectTargetCalls = 0;
  let abortedByClient = false;
  let resolveClientAbort: () => void = () => {};
  const clientAbortObserved = new Promise<void>((resolve) => {
    resolveClientAbort = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/redirect-target" });
      response.end();
      return;
    }
    if (request.url === "/redirect-target") {
      redirectTargetCalls += 1;
      response.end("unexpected");
      return;
    }
    if (request.url === "/abort") {
      request.once("close", () => {
        abortedByClient = true;
        resolveClientAbort();
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"delta":"first"}\n\n');
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"delta":"one"}\n\n');
      setImmediate(() => response.end("data: [DONE]\n\n"));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[{"id":"audit"}]}');
  });
  const port = await listen(server);
  let resolution = 0;
  let escapeLoopback = false;
  const transport = createHardenedGenericTransport({
    allowLoopbackHttp: true,
    resolveHost: async (hostname) => {
      assert.equal(hostname, "localhost");
      resolution += 1;
      return escapeLoopback
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
  });
  try {
    const first = await transport.fetchImpl(
      `http://localhost:${port}/stream`,
      { redirect: "manual" },
    );
    assert.match(await first.text(), /\[DONE\]/);
    const second = await transport.fetchImpl(
      `http://localhost:${port}/models`,
      { redirect: "manual" },
    );
    assert.equal(second.status, 200);
    assert.equal(resolution, 2, "DNS must be resolved for every request");

    const redirect = await transport.fetchImpl(
      `http://localhost:${port}/redirect`,
      { redirect: "manual" },
    );
    assert.equal(redirect.status, 302);
    await redirect.body?.cancel();
    assert.equal(redirectTargetCalls, 0);
    await assert.rejects(
      transport.fetchImpl(`http://localhost:${port}/redirect`, {
        redirect: "follow",
      }),
      policyCode("redirect_mode_denied"),
    );

    const controller = new AbortController();
    const streaming = await transport.fetchImpl(
      `http://localhost:${port}/abort`,
      { redirect: "manual", signal: controller.signal },
    );
    const reader = streaming.body!.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await assert.rejects(reader.read(), (error: unknown) =>
      Boolean(error instanceof Error && error.name === "AbortError"),
    );
    await clientAbortObserved;
    assert.equal(abortedByClient, true);

    escapeLoopback = true;
    await assert.rejects(
      transport.fetchImpl(`http://localhost:${port}/models`, {
        redirect: "manual",
      }),
      policyCode("address_denied"),
    );
  } finally {
    await close(server);
  }

  const defaultTransport = createHardenedGenericTransport({
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await assert.rejects(
    defaultTransport.fetchImpl("http://localhost:11434/v1/models", {
      redirect: "manual",
    }),
    policyCode("protocol_denied"),
  );
  const notExact = createHardenedGenericTransport({
    allowLoopbackHttp: true,
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await assert.rejects(
    notExact.fetchImpl("http://foo.localhost:11434/v1/models", {
      redirect: "manual",
    }),
    policyCode("protocol_denied"),
  );

  const mixed = createHardenedGenericTransport({
    resolveHost: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
  });
  await assert.rejects(
    mixed.fetchImpl("https://gateway.example.test/v1/models", {
      redirect: "manual",
    }),
    policyCode("address_denied"),
  );
  const mapped = createHardenedGenericTransport({
    resolveHost: async () => [{ address: "::ffff:8.8.8.8", family: 6 }],
  });
  await assert.rejects(
    mapped.fetchImpl("https://gateway.example.test/v1/models", {
      redirect: "manual",
    }),
    policyCode("address_denied"),
  );

  const redacted = createHardenedGenericTransport({
    resolveHost: async () => {
      throw new Error("api_key=transport-secret");
    },
  });
  await assert.rejects(
    redacted.fetchImpl(
      "https://gateway.example.test/v1/models?api_key=transport-secret",
      { redirect: "manual" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /transport-secret|api_key|gateway/i);
      return true;
    },
  );
}

async function auditTlsIdentity() {
  let receivedServername: string | null = null;
  const context = createSecureContext({ key: TEST_KEY, cert: TEST_CERT });
  const server = https.createServer({
    key: TEST_KEY,
    cert: TEST_CERT,
    SNICallback(servername, callback) {
      receivedServername = servername;
      callback(null, context);
    },
  });
  const port = await listen(server);
  const transport = createHardenedGenericTransport({
    allowLoopbackHttp: true,
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  try {
    await assert.rejects(
      transport.fetchImpl(
        `https://localhost:${port}/v1/models?api_key=tls-secret`,
        { redirect: "manual" },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /tls-secret|api_key|localhost/i);
        return true;
      },
    );
    assert.equal(receivedServername, "localhost");
  } finally {
    await close(server);
  }
}

async function main() {
  await auditAddressPolicy();
  await auditDnsAndStreaming();
  await auditTlsIdentity();
  console.log("veraWorkspaceHardenedGenericTransportAudit: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
