"use client";

import { useState } from "react";

const scenarios = [
  {
    id: 1,
    name: "Cross-Integration Access",
    description: "GitHub-only token tries Slack files → Denied",
    color: "var(--status-danger)",
  },
  {
    id: 2,
    name: "Admin Full Access",
    description: "Admin token accesses any integration → Allowed",
    color: "var(--status-success)",
  },
  {
    id: 3,
    name: "Expired Token",
    description: "Stale JWT rejected at the door",
    color: "var(--status-warning)",
  },
  {
    id: 4,
    name: "Budget Exceeded",
    description: "Agent hits action limit → Auto-suspended",
    color: "var(--brand-warm)",
  },
];

export function DemoPanel() {
  const [running, setRunning] = useState<number | null>(null);

  const runScenario = async (scenarioId: number) => {
    setRunning(scenarioId);
    try {
      const response = await fetch(`/api/demo-scenario`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: scenarioId }),
      });

      if (!response.ok) {
        console.error("Demo failed:", await response.text());
      }
    } catch (err) {
      console.error("Demo error:", err);
    } finally {
      setRunning(null);
    }
  };

  return (
    <section className="brand-card">
      <div className="border-b border-[var(--border-default)] px-4 py-3">
        <h2 className="brand-kicker">Demo Scenarios</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">Trigger sample authorization events</p>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {scenarios.map((scenario) => (
            <button
              key={scenario.id}
              onClick={() => runScenario(scenario.id)}
              disabled={running !== null}
              className="group relative overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3 text-left transition-all hover:border-[var(--brand-primary)] hover:shadow-md disabled:opacity-50"
            >
              <div
                className="absolute left-0 top-0 bottom-0 w-1"
                style={{ background: scenario.color }}
              />
              <div className="pl-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">{scenario.name}</div>
                <div className="text-[0.7rem] text-[var(--text-muted)] mt-0.5">{scenario.description}</div>
              </div>
              {running === scenario.id && (
                <div className="absolute inset-0 flex items-center justify-center bg-[var(--surface-card)]/80">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
