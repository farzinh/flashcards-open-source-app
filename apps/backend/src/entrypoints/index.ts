import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getAuthConfig } from "../auth/config";
import { createApp } from "../server/app";
import { initializeBackendSentry } from "../observability/sentry";

function listenerPort(name: string, defaultPort: number): number {
  const value = process.env[name] ?? String(defaultPort);
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return port;
}

async function main(): Promise<void> {
  initializeBackendSentry("backend-api");
  const app = createApp("/v1");
  const port = listenerPort("PORT", 8080);
  // Unset binds every interface, which the compose auth container needs to reach this backend
  // through host.docker.internal. The scripts/local/ loops set 127.0.0.1: their insecure local auth
  // trusts the client-supplied Host header, so only a loopback bind keeps the network out.
  const hostname = process.env.BACKEND_BIND_HOST;

  if (getAuthConfig().mode === "guest") {
    const authPort = listenerPort("GUEST_AUTH_PORT", 8081);
    if (authPort === port) {
      throw new Error("PORT and GUEST_AUTH_PORT must differ in guest mode. Set GUEST_AUTH_PORT to a free port.");
    }
    // Native clients probe this separate origin before accepting a custom server.
    const authApp = new Hono();
    authApp.use("*", async (context, next) => {
      context.header("Cache-Control", "no-store");
      await next();
    });
    authApp.get("/health", (context) => context.json({ ok: true, mode: "guest" }));
    authApp.all("*", (context) => context.json({
      code: "SERVICE_UNAVAILABLE",
      error: "Account sign-in is disabled on this server. Continue as a guest.",
    }, 503));
    serve({ fetch: authApp.fetch, port: authPort, hostname });
  }

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    // Handed to `console` as an object rather than pre-serialized, for the same reason
    // `writeCloudWatchRecord` is (apps/backend/src/observability/cloudWatch.ts): a pre-serialized
    // record leaves `message` a string under the Lambda JSON log format, with nothing inside it
    // addressable.
    console.log({ domain: "backend", action: "start", port: info.port });
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error({ domain: "backend", action: "startup_failed", error: message });
  process.exit(1);
});
