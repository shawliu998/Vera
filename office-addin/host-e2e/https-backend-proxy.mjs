import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

const certDir = process.env.VERA_CERT_DIR ?? path.join(os.homedir(), ".office-addin-dev-certs");
const listenPort = Number(process.env.VERA_PROXY_PORT ?? "3002");
const upstreamPort = Number(process.env.VERA_BACKEND_PORT ?? "3001");

const [cert, key] = await Promise.all([
    readFile(path.join(certDir, "localhost.crt")),
    readFile(path.join(certDir, "localhost.key")),
]);

const server = https.createServer({ cert, key }, (request, response) => {
    const upstream = http.request(
        {
            hostname: "127.0.0.1",
            port: upstreamPort,
            path: request.url,
            method: request.method,
            headers: {
                ...request.headers,
                host: `127.0.0.1:${upstreamPort}`,
            },
        },
        (upstreamResponse) => {
            response.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.headers,
            );
            upstreamResponse.pipe(response);
        },
    );

    upstream.on("error", (error) => {
        if (!response.headersSent) {
            response.writeHead(502, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ detail: error.message }));
    });
    request.pipe(upstream);
});

server.listen(listenPort, "127.0.0.1", () => {
    console.log(`HTTPS proxy listening on https://127.0.0.1:${listenPort}`);
});
