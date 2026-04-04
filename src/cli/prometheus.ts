/**
 * Prometheus metrics HTTP server — exposes /metrics for scraping.
 *
 * Uses Bun.serve() and delegates metric rendering to effect-utils.
 */

import {
  renderPrometheusMetrics,
  prometheusContentType,
} from "../linear/effect-utils";

export type PrometheusServer = {
  port: number;
  stop: () => void;
};

export function startPrometheusServer(opts: { port: number }): PrometheusServer {
  const server = Bun.serve({
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/metrics") {
        return new Response(renderPrometheusMetrics(), {
          headers: { "content-type": prometheusContentType },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    port: server.port,
    stop: () => server.stop(),
  };
}
