"use client";

import { useMemo } from "react";
import type { ObserverEvent } from "@/types";

type AgentMapProps = {
  events: ObserverEvent[];
};

type AgentRecord = {
  id: string;
  org?: string;
  name?: string;
  scopes: string[];
  lastSeen: string;
};

export function AgentMap({ events }: AgentMapProps) {
  const agents = useMemo(() => deriveAgents(events), [events]);

  return (
    <aside className="flex min-h-0 w-full flex-col border-r border-slate-200 bg-slate-50 lg:w-80">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Agents</h2>
        <p className="text-xs text-slate-500">{agents.length} seen in stream</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {agents.length === 0 ? (
          <div className="rounded border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
            Agents appear here after token or scope events arrive.
          </div>
        ) : (
          <ul className="space-y-3">
            {agents.map((agent) => (
              <li key={agent.id} className="rounded border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">{agent.name ?? agent.id}</div>
                    {agent.org ? <div className="mt-1 text-xs text-slate-500">org: {agent.org}</div> : null}
                  </div>
                  <time className="shrink-0 text-xs tabular-nums text-slate-400" dateTime={agent.lastSeen}>
                    {formatTime(agent.lastSeen)}
                  </time>
                </div>

                <div className="mt-3">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Scopes</div>
                  {agent.scopes.length === 0 ? (
                    <p className="text-xs text-slate-500">No scopes observed yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {agent.scopes.map((scope) => (
                        <li key={scope} className="truncate font-mono text-xs text-slate-700">
                          {scope}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function deriveAgents(events: ObserverEvent[]): AgentRecord[] {
  const byId = new Map<string, AgentRecord>();

  for (const event of [...events].reverse()) {
    const update = getAgentUpdate(event);
    if (!update) {
      continue;
    }

    const current = byId.get(update.id);
    byId.set(update.id, {
      id: update.id,
      org: update.org ?? current?.org,
      name: update.name ?? current?.name,
      scopes: update.scopes ?? current?.scopes ?? [],
      lastSeen: event.timestamp,
    });
  }

  return [...byId.values()].sort((left, right) => Date.parse(right.lastSeen) - Date.parse(left.lastSeen));
}

function getAgentUpdate(event: ObserverEvent): Pick<AgentRecord, "id" | "org" | "name"> & { scopes?: string[] } | null {
  switch (event.type) {
    case "token.verified":
      return {
        id: event.payload.sub,
        org: event.payload.org,
        scopes: event.payload.scopes,
      };
    case "scope.check":
    case "scope.denied":
      return {
        id: event.payload.agent,
        scopes: event.payload.grantedScopes,
      };
    case "identity.created":
      return {
        id: event.payload.id,
        org: event.payload.org,
        name: event.payload.name,
      };
    case "budget.alert":
      return {
        id: event.payload.id,
      };
    case "token.invalid":
      return event.payload.sub
        ? {
            id: event.payload.sub,
            org: event.payload.org,
          }
        : null;
  }
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? "--:--"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
