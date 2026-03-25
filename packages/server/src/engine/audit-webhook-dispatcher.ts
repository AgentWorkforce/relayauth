import type { AuditAction, AuditEntry } from "@relayauth/types";

export type AuditWebhookEvent =
  | AuditAction
  | "budget.exceeded"
  | "budget.alert"
  | "scope.escalation_denied";

export type DispatchAuditEntry = Omit<AuditEntry, "action"> & {
  action: AuditWebhookEvent;
};

export type AuditWebhookSubscription = {
  id: string;
  orgId: string;
  url: string;
  events?: string[];
  secret: string;
  createdAt?: string;
};

export type AuditWebhookPayload = {
  type: "audit.event";
  deliveryId: string;
  timestamp: string;
  entry: DispatchAuditEntry;
};

const RETRY_BASE_DELAYS_MS = [500, 1_000, 2_000] as const;
const REQUEST_TIMEOUT_MS = 10_000;
const textEncoder = new TextEncoder();

export async function dispatchWebhook(
  webhook: AuditWebhookSubscription,
  entry: DispatchAuditEntry,
): Promise<void> {
  const payload: AuditWebhookPayload = {
    type: "audit.event",
    deliveryId: generateDeliveryId(),
    timestamp: new Date().toISOString(),
    entry,
  };
  const body = JSON.stringify(payload);
  const signature = await signPayload(body, webhook.secret);

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BASE_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await postWebhook(webhook.url, body, payload.deliveryId, signature);
      if (response.ok) {
        return;
      }

      if (response.status < 500) {
        throw new Error(`Webhook delivery failed with status ${response.status}`);
      }

      lastError = new Error(`Webhook delivery failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < RETRY_BASE_DELAYS_MS.length) {
      const base = RETRY_BASE_DELAYS_MS[attempt];
      const jitter = Math.floor(Math.random() * base * 0.25);
      await sleep(base + jitter);
    }
  }

  throw toError(lastError, "Webhook delivery failed");
}

export function dispatchWebhooksForEntry(
  webhooks: AuditWebhookSubscription[],
  entry: DispatchAuditEntry,
): void {
  for (const webhook of webhooks) {
    if (!shouldDispatch(webhook, entry.action)) {
      continue;
    }

    void dispatchWebhook(webhook, entry).catch((error) => {
      console.error("Failed to deliver audit webhook", {
        webhookId: webhook.id,
        orgId: webhook.orgId,
        action: entry.action,
        error: toError(error, "Webhook delivery failed").message,
      });
    });
  }
}

function shouldDispatch(webhook: AuditWebhookSubscription, action: string): boolean {
  if (!Array.isArray(webhook.events) || webhook.events.length === 0) {
    return true;
  }

  return webhook.events.includes(action);
}

async function postWebhook(
  url: string,
  body: string,
  deliveryId: string,
  signature: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-relayauth-signature": signature,
        "x-relayauth-delivery-id": deliveryId,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function signPayload(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(body));
  return `sha256=${toHex(signature)}`;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateDeliveryId(): string {
  return `awd_${crypto.randomUUID()}`;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function toError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}
