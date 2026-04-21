import type { ObserverEvent } from "@/types";

type ConnectObserverOptions = {
  url: string;
  orgId?: string;
  types?: string[];
};

type ObserverEventCallback = (event: ObserverEvent) => void;

type ObserverConnection = {
  close(): void;
  onEvent: (cb: ObserverEventCallback) => void;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

export function connectObserver({
  url,
  orgId,
  types,
}: ConnectObserverOptions): ObserverConnection {
  const listeners = new Set<ObserverEventCallback>();
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let closed = false;

  function connect(): void {
    if (closed) {
      return;
    }

    reconnectTimer = undefined;
    source = new EventSource(buildObserverUrl(url, orgId, types));

    source.onopen = () => {
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    };

    source.onmessage = (message) => {
      let event: ObserverEvent;

      try {
        event = JSON.parse(message.data) as ObserverEvent;
      } catch (error) {
        console.error("Failed to parse observer event", error);
        return;
      }

      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error("Observer event listener failed", error);
        }
      }
    };

    source.onerror = () => {
      source?.close();
      source = undefined;
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) {
      return;
    }

    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    close(): void {
      closed = true;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }

      source?.close();
      source = undefined;
      listeners.clear();
    },
    onEvent(cb: ObserverEventCallback): void {
      listeners.add(cb);
    },
  };
}

function buildObserverUrl(url: string, orgId?: string, types?: string[]): string {
  const observerUrl = new URL(url, window.location.href);

  if (orgId) {
    observerUrl.searchParams.set("orgId", orgId);
  }

  if (types && types.length > 0) {
    observerUrl.searchParams.set("types", types.join(","));
  }

  return observerUrl.toString();
}
