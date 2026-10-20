import http from "node:http";
import https from "node:https";

// http-proxy defaults to `agent: false` + `Connection: close`: a new TCP connect
// and DNS lookup to the upstream on EVERY request. Pooled sockets skip both.
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

export function upstreamAgent(target: string): http.Agent {
  return target.startsWith("https:") ? httpsAgent : httpAgent;
}
