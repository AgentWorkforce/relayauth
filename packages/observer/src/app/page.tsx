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
    <main className="flex h-screen min-h-0 flex-col bg-slate-100 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-5 py-4">
        <h1 className="text-lg font-semibold">RelayAuth Observer</h1>
        <p className="text-sm text-slate-500">Live token, scope, identity, and budget events</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <AgentMap events={events} />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.85fr)]">
            <EventFeed events={events} selectedEvent={selectedEvent} onSelect={setSelectedEvent} />
            <ScopeVisualizer event={selectedEvent} />
          </div>
          <DemoPanel />
        </div>
      </div>
    </main>
  );
}
