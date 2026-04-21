"use client";

import type { ObserverEvent } from "@/types";

type ScopeVisualizerProps = {
  event: ObserverEvent | null;
};

type ScopeEvent = Extract<ObserverEvent, { type: "scope.check" | "scope.denied" }>;

export function ScopeVisualizer({ event }: ScopeVisualizerProps) {
  const scopeEvent = isScopeEvent(event) ? event : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Scope Evaluation</h2>
        <p className="text-xs text-slate-500">Selected event details</p>
      </div>

      {!event ? (
        <EmptyState message="Select an event to inspect its authorization details." />
      ) : !scopeEvent ? (
        <EmptyState message="The selected event does not include a scope evaluation." />
      ) : (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Requested</div>
            <code className="block rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
              {scopeEvent.payload.requestedScope}
            </code>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Agent Scopes</div>
            <ul className="space-y-2">
              {scopeEvent.payload.grantedScopes.map((scope) => {
                const matched = scopeMatchesEvent(scopeEvent, scope);

                return (
                  <li
                    key={scope}
                    className="grid grid-cols-[1fr_auto] gap-3 rounded border border-slate-200 px-3 py-2"
                  >
                    <code className="min-w-0 truncate text-sm text-slate-700">{scope}</code>
                    <span className={matched ? "text-sm font-semibold text-emerald-700" : "text-sm text-rose-600"}>
                      {matched ? "✓ Match" : "✗ No match"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Detail label="Result" value={scopeEvent.payload.result.toUpperCase()} />
            <Detail label="Reason" value={getReason(scopeEvent)} />
          </div>

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Parsed Scope</div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Detail label="Plane" value={scopeEvent.payload.evaluation.plane || "unknown"} />
              <Detail label="Resource" value={scopeEvent.payload.evaluation.resource || "unknown"} />
              <Detail label="Action" value={scopeEvent.payload.evaluation.action || "unknown"} />
              <Detail label="Path" value={scopeEvent.payload.evaluation.path || "unknown"} />
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="px-4 py-10 text-sm text-slate-500">{message}</div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 break-words text-sm text-slate-800">{value}</dd>
    </div>
  );
}

function isScopeEvent(event: ObserverEvent | null): event is ScopeEvent {
  return event?.type === "scope.check" || event?.type === "scope.denied";
}

function scopeMatchesEvent(event: ScopeEvent, scope: string): boolean {
  if (event.payload.matchedScope) {
    return event.payload.matchedScope === scope;
  }

  return event.payload.result === "allowed" && event.payload.requestedScope === scope;
}

function getReason(event: ScopeEvent): string {
  if (event.type === "scope.denied") {
    return event.payload.reason;
  }

  if (event.payload.result === "allowed") {
    return event.payload.matchedScope
      ? `Matched ${event.payload.matchedScope}`
      : "A granted scope satisfied the request.";
  }

  return "No granted scope matched the requested scope.";
}
