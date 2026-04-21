"use client";

import { useMemo } from "react";
import type { ObserverEvent } from "@/types";

type AgentMapProps = {
  events: ObserverEvent[];
};

interface AgentInfo {
  name: string;
  scopes: string[];
  lastSeen: string;
}

export function AgentMap({ events }: AgentMapProps) {
  const agents = useMemo(() => {
    const map = new Map<string, AgentInfo>();

    for (const event of events) {
      let agentName: string | undefined;

      if (event.type === "token.verified" || event.type === "token.invalid") {
        agentName = event.payload.sub;
      } else if (event.type === "scope.check" || event.type === "scope.denied") {
        agentName = event.payload.agent;
      } else if (event.type === "identity.created") {
        agentName = event.payload.name ?? event.payload.id;
      }

      if (agentName) {
        const existing = map.get(agentName);
        const scopes =
          event.type === "token.verified" && Array.isArray(event.payload.scopes)
            ? event.payload.scopes
            : existing?.scopes ?? [];

        map.set(agentName, {
          name: agentName,
          scopes: [...new Set([...scopes, ...(existing?.scopes ?? [])])],
          lastSeen: event.timestamp,
        });
      }
    }

    return Array.from(map.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }, [events]);

  return (
    <aside className="brand-card flex min-h-0 w-full flex-col overflow-hidden lg:w-72">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Agents</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{agents.length} active</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {agents.length === 0 ? (
          <div className="py-6 text-center">
            <div className="mx-auto mb-2 h-8 w-8 rounded-full bg-[var(--surface-muted)] flex items-center justify-center">
              <svg className="h-4 w-4 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <p className="text-xs text-[var(--text-muted)]">No agents seen yet</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {agents.map((agent) => (
              <li key={agent.name} className="brand-soft p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--brand-primary)] text-xs font-bold text-white">
                    {agent.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--foreground)] truncate">{agent.name}</div>
                    <div className="text-[0.65rem] text-[var(--text-muted)]">
                      {formatTimeAgo(agent.lastSeen)}
                    </div>
                  </div>
                </div>
                {agent.scopes.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[0.6rem] uppercase tracking-wider text-[var(--text-faint)] mb-1">Scopes</div>
                    <div className="flex flex-wrap gap-1">
                      {agent.scopes.slice(0, 3).map((scope, i) => (
                        <span
                          key={i}
                          className="inline-block rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[0.6rem] font-mono text-[var(--text-secondary)]"
                        >
                          {scope.split(":").pop()}
                        </span>
                      ))}
                      {agent.scopes.length > 3 && (
                        <span className="text-[0.6rem] text-[var(--text-muted)]">+{agent.scopes.length - 3}</span>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function formatTimeAgo(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return date.toLocaleDateString();
}
