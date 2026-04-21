import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { AppEnv } from "../env.js";
import type { ObserverEvent } from "../lib/events.js";
import { observerBus } from "../lib/events.js";

const observerApp = new Hono<AppEnv>();

observerApp.get("/events", (c) => {
  const filter = {
    orgId: normalizeQueryValue(c.req.query("orgId")),
    types: parseTypes(c.req.query("types")),
  };

  return streamSSE(c, async (stream) => {
    let closed = false;
    let unsubscribe = () => {};
    let writeQueue = Promise.resolve();
    let pingInterval: ReturnType<typeof setInterval> | undefined;
    let resolveClosed: () => void = () => {};
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const cleanup = () => {
      if (closed) {
        return;
      }

      closed = true;
      if (pingInterval !== undefined) {
        clearInterval(pingInterval);
      }
      unsubscribe();
      resolveClosed();
    };

    const write = (chunk: string): Promise<void> => {
      writeQueue = writeQueue
        .then(async () => {
          if (!closed && !stream.aborted) {
            await stream.write(chunk);
          }
        })
        .catch(() => {
          cleanup();
        });

      return writeQueue;
    };

    stream.onAbort(cleanup);
    c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

    unsubscribe = observerBus.subscribe((event) => {
      void write(formatEvent(event));
    }, filter);

    pingInterval = setInterval(() => {
      void write(":ping\n\n");
    }, 15_000);

    await closedPromise;
    await writeQueue;
  });
});

observerApp.get("/health", (c) => {
  return c.json({ ok: true, listeners: observerBus.listenerCount() });
});

function normalizeQueryValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseTypes(value: string | undefined): string[] | undefined {
  const types = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return types && types.length > 0 ? types : undefined;
}

function formatEvent(event: ObserverEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export default observerApp;
