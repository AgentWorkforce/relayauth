"use client";

import { useState } from "react";

type ScenarioId = 1 | 2 | 3 | 4;

const scenarios: Array<{ id: ScenarioId; label: string }> = [
  { id: 1, label: "GitHub-only agent tries Slack" },
  { id: 2, label: "Full-access admin accesses file" },
  { id: 3, label: "Expired token verification" },
  { id: 4, label: "Budget exceeded" },
];

export function DemoPanel() {
  const [running, setRunning] = useState<ScenarioId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function runScenario(scenario: ScenarioId): Promise<void> {
    setRunning(scenario);
    setMessage(null);

    try {
      const response = await fetch("/api/demo-scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? `Scenario ${scenario} failed`);
      }

      setMessage(`Scenario ${scenario} started.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to start scenario.");
    } finally {
      setRunning(null);
    }
  }

  return (
    <section className="border-t border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-900">Demo Scenarios</h2>
          <p className="text-xs text-slate-500">Generate representative observer traffic</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {scenarios.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            onClick={() => void runScenario(scenario.id)}
            disabled={running !== null}
            className="flex items-center justify-between gap-3 rounded border border-slate-300 bg-white px-3 py-2 text-left text-sm text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="min-w-0 truncate">
              {scenario.id}. {scenario.label}
            </span>
            <span className="shrink-0 rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white">
              {running === scenario.id ? "Running" : "Try"}
            </span>
          </button>
        ))}
      </div>

      {message ? <p className="mt-3 text-xs text-slate-500">{message}</p> : null}
    </section>
  );
}
