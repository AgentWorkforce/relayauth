"use client";

import { useEffect, useState, useMemo } from "react";
import { AgentMap } from "@/components/AgentMap";
import { DemoPanel } from "@/components/DemoPanel";
import { EventFeed } from "@/components/EventFeed";
import { ScopeVisualizer } from "@/components/ScopeVisualizer";
import { connectObserver } from "@/lib/sse-client";
import type { ObserverEvent } from "@/types";

const MAX_EVENTS = 500;

export default function ObserverPage() {
  const [events, setEvents] = useState<ObserverEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<ObserverEvent | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterType, setFilterType] = useState<string>("all");

  useEffect(() => {
    const connection = connectObserver({ url: "/api/observer/events" });

    connection.onEvent((event) => {
      setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
      setSelectedEvent((current) => current ?? event);
    });

    return () => {
      connection.close();
    };
  }, []);

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (filterType !== "all" && event.type !== filterType) {
        return false;
      }
      if (filterText) {
        const searchLower = filterText.toLowerCase();
        const summary = summarizeEvent(event).toLowerCase();
        const payload = event.payload as Record<string, unknown>;
        const agent = String(payload?.agent ?? payload?.sub ?? "");
        const org = String(payload?.org ?? "");
        return (
          summary.includes(searchLower) ||
          agent.toLowerCase().includes(searchLower) ||
          org.toLowerCase().includes(searchLower)
        );
      }
      return true;
    });
  }, [events, filterText, filterType]);

  const eventTypes = useMemo(() => {
    const types = new Set(events.map((e) => e.type));
    return Array.from(types).sort();
  }, [events]);

  return (
    <div className="brand-shell min-h-screen">
      <header className="brand-card mx-4 mt-4 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="brand-title text-2xl font-bold">
              <span className="observer-wordmark">RelayAuth</span> Observer
            </h1>
            <p className="text-sm text-[var(--text-muted)] mt-1">See every file access decision for your relayfile agents</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <span className="text-sm font-medium text-[var(--text-muted)]">Live</span>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col p-4 gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="Search agents, integrations..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] text-sm text-[var(--foreground)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--brand-primary)]"
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-card)] text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--brand-primary)]"
          >
            <option value="all">All events</option>
            {eventTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          {filterText || filterType !== "all" ? (
            <button
              onClick={() => {
                setFilterText("");
                setFilterType("all");
              }}
              className="px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--foreground)]"
            >
              Clear filters
            </button>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row gap-4">
          <AgentMap events={filteredEvents} />
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.85fr)] gap-4">
              <EventFeed events={filteredEvents} selectedEvent={selectedEvent} onSelect={setSelectedEvent} />
              <ScopeVisualizer event={selectedEvent} />
            </div>
            <DemoPanel />
          </div>
        </div>
      </main>
    </div>
  );
}

function summarizeEvent(event: ObserverEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const eventType = event.type;

  if (eventType === "token.verified") {
    const sub = String(payload.sub ?? "unknown");
    const scopes = (payload.scopes as string[] | undefined)?.length ?? 0;
    return `Token verified for ${sub} (${scopes} scopes)`;
  }
  if (eventType === "token.invalid") {
    const sub = String(payload.sub ?? "unknown");
    const reason = String(payload.reason ?? "unknown");
    return `Token invalid for ${sub}: ${reason}`;
  }
  if (eventType === "scope.check" || eventType === "scope.denied") {
    const agent = String(payload.agent ?? payload.sub ?? "unknown");
    const requested = String(payload.requestedScope ?? "unknown");
    const result = String(payload.result ?? "unknown");
    return `${agent} requested ${requested} → ${result}`;
  }
  if (eventType === "identity.created") {
    const name = String(payload.name ?? "unknown");
    const org = String(payload.org ?? "");
    return `Created identity "${name}" in ${org}`;
  }
  if (eventType === "identity.updated") {
    const name = String(payload.name ?? "unknown");
    return `Updated identity "${name}"`;
  }
  if (eventType === "identity.deleted") {
    const name = String(payload.name ?? "unknown");
    return `Deleted identity "${name}"`;
  }
  if (eventType === "budget.alert") {
    const id = String(payload.id ?? "unknown");
    const usage = Number(payload.usage ?? 0);
    const limit = Number(payload.limit ?? 0);
    return `Budget alert: ${id} used ${usage}/${limit} actions`;
  }
  if (eventType === "budget.suspended") {
    const id = String(payload.id ?? "unknown");
    return `Suspended identity ${id} due to budget exceeded`;
  }
  return eventType;
}
