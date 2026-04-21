"use client";

import type { ObserverEvent } from "@/types";

type ScopeVisualizerProps = {
  event: ObserverEvent | null;
};

type ScopeEvent = Extract<ObserverEvent, { type: "scope.check" | "scope.denied" }>;
type TokenEvent = Extract<ObserverEvent, { type: "token.verified" | "token.invalid" }>;
type IdentityEvent = Extract<ObserverEvent, { type: "identity.created" | "identity.updated" | "identity.deleted" }>;
type BudgetEvent = Extract<ObserverEvent, { type: "budget.alert" | "budget.suspended" }>;

export function ScopeVisualizer({ event }: ScopeVisualizerProps) {
  if (!event) {
    return (
      <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b border-[var(--border-default)] px-4 py-3">
          <h2 className="brand-kicker">Event Details</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">Click an event to inspect</p>
        </div>
        <EmptyState message="Select an event to inspect its details." />
      </section>
    );
  }

  const eventType = event.type;

  if (eventType === "scope.check" || eventType === "scope.denied") {
    return <ScopeEventDetails event={event as ScopeEvent} />;
  }

  if (eventType === "token.verified" || eventType === "token.invalid") {
    return <TokenEventDetails event={event as TokenEvent} />;
  }

  if (eventType === "identity.created" || eventType === "identity.updated" || eventType === "identity.deleted") {
    return <IdentityEventDetails event={event as IdentityEvent} />;
  }

  if (eventType === "budget.alert" || eventType === "budget.suspended") {
    return <BudgetEventDetails event={event as BudgetEvent} />;
  }

  return (
    <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Event Details</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{eventType}</p>
      </div>
      <JsonDisplay data={event} />
    </section>
  );
}

function ScopeEventDetails({ event }: { event: ScopeEvent }) {
  return (
    <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Scope Evaluation</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">{event.payload.agent}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div>
          <div className="brand-kicker mb-2">Requested Scope</div>
          <code className="brand-soft block px-3 py-2 text-sm font-mono text-[var(--foreground)]">
            {event.payload.requestedScope}
          </code>
        </div>

        <div>
          <div className="brand-kicker mb-2">Agent</div>
          <div className="brand-soft inline-flex items-center gap-2 px-3 py-2 text-sm">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--brand-primary)] text-xs font-bold text-white">
              {event.payload.agent.charAt(0).toUpperCase()}
            </div>
            <span className="text-[var(--foreground)]">{event.payload.agent}</span>
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Granted Scopes</div>
          <ul className="space-y-1.5">
            {event.payload.grantedScopes.map((scope, i) => (
              <li key={i} className="brand-soft flex items-center gap-2 px-3 py-1.5 text-sm font-mono">
                <span className="text-[var(--status-success)]">✓</span>
                <span className="text-[var(--foreground)]">{scope}</span>
              </li>
            ))}
          </ul>
        </div>

        {event.payload.result && (
          <div>
            <div className="brand-kicker mb-2">Result</div>
            <div
              className={[
                "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold",
                event.payload.result === "allowed"
                  ? "bg-[var(--status-success-soft)] text-[var(--status-success)]"
                  : "bg-[var(--status-danger-soft)] text-[var(--status-danger)]",
              ].join(" ")}
            >
              {event.payload.result === "allowed" ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
              {event.payload.result === "allowed" ? "ALLOWED" : "DENIED"}
            </div>
          </div>
        )}

        {"reason" in event.payload && event.payload.reason && (
          <div>
            <div className="brand-kicker mb-2">Reason</div>
            <div className="brand-soft px-3 py-2 text-sm text-[var(--text-secondary)]">
              {event.payload.reason}
            </div>
          </div>
        )}

        {event.payload.evaluation && (
          <div>
            <div className="brand-kicker mb-2">Evaluation</div>
            <div className="brand-soft p-3 text-sm font-mono space-y-1">
              <div className="flex gap-2">
                <span className="text-[var(--text-muted)]">Plane:</span>
                <span className="text-[var(--foreground)]">{event.payload.evaluation.plane}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[var(--text-muted)]">Resource:</span>
                <span className="text-[var(--foreground)]">{event.payload.evaluation.resource}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[var(--text-muted)]">Action:</span>
                <span className="text-[var(--foreground)]">{event.payload.evaluation.action}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[var(--text-muted)]">Path:</span>
                <span className="text-[var(--foreground)]">{event.payload.evaluation.path}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function TokenEventDetails({ event }: { event: TokenEvent }) {
  const isValid = event.type === "token.verified";

  return (
    <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Token Verification</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          <span className={isValid ? "text-[var(--status-success)]" : "text-[var(--status-danger)]"}>
            {isValid ? "Verified" : "Invalid"}
          </span>
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <div className="brand-kicker mb-2">Subject</div>
          <div className="brand-soft px-3 py-2 text-sm font-mono text-[var(--foreground)]">
            {event.payload.sub}
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Organization</div>
          <div className="brand-soft px-3 py-2 text-sm text-[var(--foreground)]">
            {event.payload.org}
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Scopes</div>
          <ul className="space-y-1">
            {event.payload.scopes.map((scope, i) => (
              <li key={i} className="brand-soft flex items-center gap-2 px-3 py-1.5 text-sm font-mono">
                <span className="text-[var(--status-success)]">✓</span>
                <span className="text-[var(--foreground)]">{scope}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="brand-kicker mb-2">Expires In</div>
          <div className="brand-soft px-3 py-2 text-sm text-[var(--foreground)]">
            {event.payload.expiresIn} seconds
          </div>
        </div>
      </div>
    </section>
  );
}

function IdentityEventDetails({ event }: { event: IdentityEvent }) {
  const actionColors: Record<string, string> = {
    "identity.created": "var(--status-success)",
    "identity.updated": "var(--status-warning)",
    "identity.deleted": "var(--status-danger)",
  };

  return (
    <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Identity Event</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5" style={{ color: actionColors[event.type] }}>
          {event.type.replace("identity.", "")}
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <div className="brand-kicker mb-2">Identity ID</div>
          <div className="brand-soft px-3 py-2 text-sm font-mono text-[var(--foreground)]">
            {event.payload.id}
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Name</div>
          <div className="brand-soft px-3 py-2 text-sm text-[var(--foreground)]">
            {event.payload.name}
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Organization</div>
          <div className="brand-soft px-3 py-2 text-sm text-[var(--foreground)]">
            {event.payload.org}
          </div>
        </div>
      </div>
    </section>
  );
}

function BudgetEventDetails({ event }: { event: BudgetEvent }) {
  const isAlert = event.type === "budget.alert";

  return (
    <section className="brand-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Budget Event</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          <span className={isAlert ? "text-[var(--status-danger)]" : "text-[var(--status-warning)]"}>
            {isAlert ? "Alert" : "Suspended"}
          </span>
        </p>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <div className="brand-kicker mb-2">Identity ID</div>
          <div className="brand-soft px-3 py-2 text-sm font-mono text-[var(--foreground)]">
            {event.payload.id}
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Organization</div>
          <div className="brand-soft px-3 py-2 text-sm text-[var(--foreground)]">
            {event.payload.org}
          </div>
        </div>

        <div>
          <div className="brand-kicker mb-2">Usage</div>
          <div className="brand-soft px-3 py-2 text-sm">
            <span className="text-[var(--status-danger)] font-bold">{event.payload.usage}</span>
            <span className="text-[var(--text-muted)]"> / </span>
            <span className="text-[var(--foreground)]">{event.payload.limit}</span>
          </div>
        </div>

        {event.payload.reason && (
          <div>
            <div className="brand-kicker mb-2">Reason</div>
            <div className="brand-soft px-3 py-2 text-sm text-[var(--text-secondary)]">
              {event.payload.reason}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function JsonDisplay({ data }: { data: ObserverEvent }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <pre className="brand-soft text-xs font-mono text-[var(--foreground)] whitespace-pre-wrap">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center">
      <div className="mb-3 rounded-full bg-[var(--surface-muted)] p-3">
        <svg className="h-6 w-6 text-[var(--text-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      </div>
      <p className="text-sm text-[var(--text-muted)]">{message}</p>
    </div>
  );
}

function isScopeEvent(event: ObserverEvent | null): event is ScopeEvent {
  if (!event) return false;
  return event.type === "scope.check" || event.type === "scope.denied";
}

function isTokenEvent(event: ObserverEvent | null): event is TokenEvent {
  if (!event) return false;
  return event.type === "token.verified" || event.type === "token.invalid";
}

function isIdentityEvent(event: ObserverEvent | null): event is IdentityEvent {
  if (!event) return false;
  return event.type === "identity.created" || event.type === "identity.updated" || event.type === "identity.deleted";
}

function isBudgetEvent(event: ObserverEvent | null): event is BudgetEvent {
  if (!event) return false;
  return event.type === "budget.alert" || event.type === "budget.suspended";
}
