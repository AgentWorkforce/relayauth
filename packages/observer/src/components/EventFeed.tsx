"use client";

import type { ObserverEvent } from "@/types";

type EventFeedProps = {
  events: ObserverEvent[];
  selectedEvent: ObserverEvent | null;
  onSelect: (event: ObserverEvent) => void;
};

type EventStatus = "ALLOWED" | "DENIED" | "VERIFIED";

const statusStyles: Record<EventStatus, string> = {
  ALLOWED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  DENIED: "border-rose-200 bg-rose-50 text-rose-700",
  VERIFIED: "border-sky-200 bg-sky-50 text-sky-700",
};

export function EventFeed({ events, selectedEvent, onSelect }: EventFeedProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Live Events</h2>
          <p className="text-xs text-slate-500">{events.length} of 200 retained</p>
        </div>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
          Connected
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-10 text-sm text-slate-500">
            Waiting for observer events from the RelayAuth server.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {events.map((event, index) => {
              const status = getEventStatus(event);
              const selected = event === selectedEvent;

              return (
                <li key={`${event.timestamp}-${event.type}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(event)}
                    className={[
                      "grid w-full grid-cols-[4.75rem_auto_1fr] items-center gap-3 px-4 py-3 text-left transition",
                      selected ? "bg-slate-100" : "hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <time className="text-xs tabular-nums text-slate-500" dateTime={event.timestamp}>
                      {formatTime(event.timestamp)}
                    </time>
                    <span
                      className={[
                        "rounded-full border px-2 py-0.5 text-[0.68rem] font-semibold leading-5",
                        statusStyles[status],
                      ].join(" ")}
                    >
                      {status}
                    </span>
                    <span className="min-w-0 truncate text-sm text-slate-700">{summarizeEvent(event)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function getEventStatus(event: ObserverEvent): EventStatus {
  if (event.type === "scope.check") {
    return event.payload.result === "allowed" ? "ALLOWED" : "DENIED";
  }

  if (event.type === "scope.denied" || event.type === "token.invalid" || event.type === "budget.alert") {
    return "DENIED";
  }

  return "VERIFIED";
}

function summarizeEvent(event: ObserverEvent): string {
  switch (event.type) {
    case "token.verified":
      return `${event.payload.sub} token verified with ${event.payload.scopes.length} scope(s)`;
    case "token.invalid":
      return event.payload.sub
        ? `${event.payload.sub} token rejected: ${event.payload.reason}`
        : `Token rejected: ${event.payload.reason}`;
    case "scope.check":
      return `${event.payload.agent} requested ${event.payload.requestedScope}`;
    case "scope.denied":
      return `${event.payload.agent} denied ${event.payload.requestedScope}`;
    case "identity.created":
      return `${event.payload.name ?? event.payload.id} identity created`;
    case "budget.alert":
      return `${event.payload.id} budget ${event.payload.usage}/${event.payload.limit}`;
  }
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
