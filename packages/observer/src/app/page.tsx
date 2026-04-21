"use client";

import { useEffect, useState } from "react";
import { AgentMap } from "@/components/AgentMap";
import { DemoPanel } from "@/components/DemoPanel";
import { EventFeed } from "@/components/EventFeed";
import { ScopeVisualizer } from "@/components/ScopeVisualizer";
import { connectObserver } from "@/lib/sse-client";
import type { ObserverEvent } from "@/types";

const MAX_EVENTS = 200;

export default function ObserverPage() {
  const [events, setEvents] = useState<ObserverEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<ObserverEvent | null>(null);

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
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row gap-4">
          <AgentMap events={events} />
          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.85fr)] gap-4">
              <EventFeed events={events} selectedEvent={selectedEvent} onSelect={setSelectedEvent} />
              <ScopeVisualizer event={selectedEvent} />
            </div>
            <DemoPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
