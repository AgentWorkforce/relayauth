"use client";

import type { ObserverEvent } from "@/types";

type EventFeedProps = {
  events: ObserverEvent[];
  selectedEvent: ObserverEvent | null;
  onSelect: (event: ObserverEvent) => void;
};

type EventStatus = "ALLOWED" | "DENIED" | "VERIFIED";

const statusStyles: Record<EventStatus, string> = {
  ALLOWED: "border-[var(--status-success)] bg-[var(--status-success-soft)] text-[var(--status-success)]",
  DENIED: "border-[var(--status-danger)] bg-[var(--status-danger-soft)] text-[var(--status-danger)]",
  VERIFIED: "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary-strong)]",
};

export function EventFeed({ events, selectedEvent, onSelect }: EventFeedProps) {
  return (
    <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
        <div>
          <h2 className="brand-kicker">Live Events</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{events.length} of 200 retained</p>
        </div>
        <span className="brand-pill text-[var(--status-success)]">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          Connected
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto mb-3 h-10 w-10 rounded-full bg-[var(--surface-muted)] flex items-center justify-center">
              <svg className="h-5 w-5 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            </div>
            <p className="text-sm text-[var(--text-muted)]">Waiting for observer events from the RelayAuth server.</p>
            <p className="text-xs text-[var(--text-faint)] mt-1">Start making authenticated requests to see events stream in.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            {events.map((event, index) => {
              const status = getEventStatus(event);
              const selected = event === selectedEvent;

              return (
                <li key={`${event.timestamp}-${event.type}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(event)}
                    className={[
                      "grid w-full grid-cols-[5rem_auto_1fr] items-center gap-3 px-4 py-3 text-left transition",
                      selected ? "bg-[var(--color-bg-active)]" : "hover:bg-[var(--color-bg-hover)]",
                    ].join(" ")}
                  >
                    <time className="text-xs tabular-nums text-[var(--text-muted)] font-mono" dateTime={event.timestamp}>
                      {formatTime(event.timestamp)}
                    </time>
                    <span
                      className={[
                        "rounded-full border px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wider",
                        statusStyles[status],
                      ].join(" ")}
                    >
                      {status}
                    </span>
                    <span className="min-w-0 truncate text-sm text-[var(--foreground)]">{summarizeEvent(event)}</span>
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
  const p = event.payload as Record<string, unknown>;
  const eventType = event.type;

  if (eventType === "token.verified") {
    const sub = String(p.sub ?? "unknown");
    const scopes = (p.scopes as string[] | undefined)?.length ?? 0;
    return `✓ ${sub} authenticated (${scopes} scopes)`;
  }
  if (eventType === "token.invalid") {
    const sub = String(p.sub ?? "unknown");
    const reason = String(p.reason ?? "invalid");
    return `✗ ${sub} rejected: ${reason}`;
  }
  if (eventType === "scope.check") {
    const agent = String(p.agent ?? p.sub ?? "unknown");
    const requested = String(p.requestedScope ?? "");
    const result = String(p.result ?? "unknown");
    return `${agent} → ${requested} → ${result}`;
  }
  if (eventType === "scope.denied") {
    const agent = String(p.agent ?? p.sub ?? "unknown");
    const requested = String(p.requestedScope ?? "");
    return `✗ ${agent} denied: ${requested}`;
  }
  if (eventType === "identity.created") {
    const name = String(p.name ?? p.id ?? "unknown");
    return `+ Created identity "${name}"`;
  }
  if (eventType === "identity.updated") {
    const name = String(p.name ?? p.id ?? "unknown");
    return `~ Updated identity "${name}"`;
  }
  if (eventType === "identity.deleted") {
    const name = String(p.name ?? p.id ?? "unknown");
    return `- Deleted identity "${name}"`;
  }
  if (eventType === "budget.alert") {
    const id = String(p.id ?? "").slice(0, 12);
    const usage = Number(p.usage ?? 0);
    const limit = Number(p.limit ?? 0);
    return `⚠ Budget alert: ${id} used ${usage}/${limit}`;
  }
  if (eventType === "budget.suspended") {
    const id = String(p.id ?? "").slice(0, 12);
    return `⛔ Suspended ${id} (budget exceeded)`;
  }
  return eventType;
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
