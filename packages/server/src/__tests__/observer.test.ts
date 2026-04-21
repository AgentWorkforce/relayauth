import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { ObserverEvent } from "../lib/events.js";
import { ObserverEventBus, observerBus } from "../lib/events.js";
import {
  assertJsonResponse,
  createTestApp,
  createTestRequest,
} from "./test-helpers.js";

const TIMESTAMP = "2026-04-21T12:00:00.000Z";

function identityCreatedEvent(
  org = "org_observer",
  id = "agent_observer",
): ObserverEvent {
  return {
    type: "identity.created",
    timestamp: TIMESTAMP,
    payload: {
      id,
      org,
      name: id,
    },
  };
}

function tokenInvalidEvent(org = "org_observer"): ObserverEvent {
  return {
    type: "token.invalid",
    timestamp: TIMESTAMP,
    payload: {
      reason: "invalid_signature",
      org,
    },
  };
}

async function waitFor(
  condition: () => boolean,
  failureMessage: string,
  timeoutMs = 500,
): Promise<void> {
  const startedAt = Date.now();

  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      assert.fail(failureMessage);
    }

    await delay(5);
  }
}

test("ObserverEventBus subscribe + emit delivers the event to the listener", () => {
  const bus = new ObserverEventBus();
  const event = identityCreatedEvent();
  const received: ObserverEvent[] = [];

  bus.subscribe((nextEvent) => {
    received.push(nextEvent);
  });
  bus.emit(event);

  assert.deepEqual(received, [event]);
});

test("ObserverEventBus unsubscribe stops delivery", () => {
  const bus = new ObserverEventBus();
  const received: ObserverEvent[] = [];
  const unsubscribe = bus.subscribe((event) => {
    received.push(event);
  });

  unsubscribe();
  bus.emit(identityCreatedEvent());

  assert.deepEqual(received, []);
});

test("ObserverEventBus filter.orgId delivers only matching events", () => {
  const bus = new ObserverEventBus();
  const received: ObserverEvent[] = [];

  bus.subscribe(
    (event) => {
      received.push(event);
    },
    { orgId: "org_allowed" },
  );

  const blockedEvent = identityCreatedEvent("org_blocked", "agent_blocked");
  const allowedEvent = identityCreatedEvent("org_allowed", "agent_allowed");

  bus.emit(blockedEvent);
  bus.emit(allowedEvent);

  assert.deepEqual(received, [allowedEvent]);
});

test("ObserverEventBus filter.types delivers only matching event types", () => {
  const bus = new ObserverEventBus();
  const received: ObserverEvent[] = [];

  bus.subscribe(
    (event) => {
      received.push(event);
    },
    { types: ["identity.created"] },
  );

  const blockedEvent = tokenInvalidEvent();
  const allowedEvent = identityCreatedEvent();

  bus.emit(blockedEvent);
  bus.emit(allowedEvent);

  assert.deepEqual(received, [allowedEvent]);
});

test("ObserverEventBus throwing listener does not prevent other listeners", () => {
  const bus = new ObserverEventBus();
  const event = identityCreatedEvent();
  const received: ObserverEvent[] = [];
  const originalConsoleError = console.error;

  console.error = () => {};
  try {
    bus.subscribe(() => {
      throw new Error("listener failed");
    });
    bus.subscribe((nextEvent) => {
      received.push(nextEvent);
    });

    bus.emit(event);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(received, [event]);
});

test("ObserverEventBus listenerCount reflects current subscribers", () => {
  const bus = new ObserverEventBus();

  assert.equal(bus.listenerCount(), 0);

  const unsubscribeFirst = bus.subscribe(() => {});
  assert.equal(bus.listenerCount(), 1);

  const unsubscribeSecond = bus.subscribe(() => {});
  assert.equal(bus.listenerCount(), 2);

  unsubscribeFirst();
  assert.equal(bus.listenerCount(), 1);

  unsubscribeSecond();
  assert.equal(bus.listenerCount(), 0);
});

test("GET /v1/observer/health returns listener health without auth", async () => {
  const app = createTestApp();

  try {
    const response = await app.request(
      createTestRequest("GET", "/v1/observer/health"),
      undefined,
      app.bindings,
    );

    await assertJsonResponse<{ ok: true; listeners: number }>(response, 200, (body) => {
      assert.equal(body.ok, true);
      assert.equal(typeof body.listeners, "number");
      assert.ok(Number.isInteger(body.listeners));
      assert.ok(body.listeners >= 0);
    });
  } finally {
    await app.close();
  }
});

test("GET /v1/observer/events responds with an SSE stream without auth", async () => {
  const app = createTestApp();
  const baselineListeners = observerBus.listenerCount();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const request = new Request("http://localhost/v1/observer/events", {
      method: "GET",
      signal: controller.signal,
    });
    const response = await app.request(request, undefined, app.bindings);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/i);
    assert.ok(response.body, "expected SSE response body");

    await waitFor(
      () => observerBus.listenerCount() > baselineListeners,
      "expected SSE request to register an observer listener",
    );

    reader = response.body.getReader();
    const readPromise = reader.read();
    observerBus.emit(identityCreatedEvent("org_sse", "agent_sse"));

    const chunk = await readPromise;
    assert.equal(chunk.done, false);
    assert.ok(chunk.value, "expected an SSE chunk");

    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /^data: /);
    assert.match(text, /"type":"identity\.created"/);
    assert.match(text, /"org":"org_sse"/);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await waitFor(
      () => observerBus.listenerCount() === baselineListeners,
      "expected SSE listener to be removed after abort",
    );
    await app.close();
  }
});

test("observerBus manual subscription receives emitted events", () => {
  const event = identityCreatedEvent("org_manual", "agent_manual");
  let received: ObserverEvent | undefined;
  const unsubscribe = observerBus.subscribe((nextEvent) => {
    received = nextEvent;
  });

  try {
    observerBus.emit(event);
    assert.deepEqual(received, event);
  } finally {
    unsubscribe();
  }
});
