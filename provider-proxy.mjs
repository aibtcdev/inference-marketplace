/**
 * Provider auth proxy.
 *
 * Sits in front of a bare local model (Ollama, vLLM, …) and requires a shared
 * key (Bearer token). connect.sh tunnels THIS — so the public URL can't be
 * called without the key, which only the marketplace gateway holds. No bypass.
 *
 *   PROXY_KEY=… PROXY_PORT=8799 UPSTREAM=http://localhost:11434 node provider-proxy.mjs
 */
import { createServer, request as httpRequest } from "node:http";

const PORT = Number(process.env.PROXY_PORT || 8799);
const UPSTREAM = new URL(process.env.UPSTREAM || "http://localhost:11434");
const KEY = process.env.PROXY_KEY || "";

if (!KEY) {
  console.error("PROXY_KEY is required");
  process.exit(1);
}

const server = createServer((req, res) => {
  if ((req.headers["authorization"] || "") !== `Bearer ${KEY}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const headers = { ...req.headers, host: UPSTREAM.host };
  delete headers["authorization"]; // don't pass our key to the model server

  const up = httpRequest(
    { hostname: UPSTREAM.hostname, port: UPSTREAM.port || 80, path: req.url, method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  });
  req.pipe(up);
});

server.listen(PORT, () => console.error(`auth proxy :${PORT} → ${UPSTREAM.href} (key required)`));
