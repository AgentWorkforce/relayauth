import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ScenarioId = 1 | 2 | 3 | 4;

const DEFAULT_RELAYAUTH_URL = "http://localhost:8787";
const SCRIPT_RELATIVE_PATH = "../../scripts/observer-demo.ts";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null) as { scenario?: unknown } | null;
  const scenario = parseScenario(body?.scenario);

  if (!scenario) {
    return NextResponse.json({ error: "scenario must be 1, 2, 3, or 4" }, { status: 400 });
  }

  const scriptCwd = findDemoScriptCwd();
  if (scriptCwd) {
    try {
      await spawnDemoScript(scriptCwd, scenario);
      return NextResponse.json({ ok: true, scenario, mode: "script" });
    } catch {
      await runDirectScenario(scenario);
      return NextResponse.json({ ok: true, scenario, mode: "direct" });
    }
  }

  await runDirectScenario(scenario);
  return NextResponse.json({ ok: true, scenario, mode: "direct" });
}

function parseScenario(value: unknown): ScenarioId | null {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

function findDemoScriptCwd(): string | null {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), "packages/observer"),
    resolve(process.cwd(), "..", "observer"),
  ];

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, SCRIPT_RELATIVE_PATH))) {
      return candidate;
    }
  }

  return null;
}

async function spawnDemoScript(cwd: string, scenario: ScenarioId): Promise<void> {
  const child = spawn("tsx", [SCRIPT_RELATIVE_PATH, `--scenario=${scenario}`], {
    cwd,
    detached: true,
    env: {
      ...process.env,
      RELAYAUTH_URL: getRelayAuthUrl(),
    },
    stdio: "ignore",
  });

  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });

  child.unref();
}

async function runDirectScenario(scenario: ScenarioId): Promise<void> {
  switch (scenario) {
    case 1:
      await postJson("/v1/identities", tokenFor("review-agent", ["relayfile:fs:read:/github/*"]), {
        name: `slack-denied-${Date.now()}`,
        sponsorId: "user_demo",
        scopes: ["relayfile:fs:read:/slack/channels/general"],
      });
      return;
    case 2:
      await fetchFromRelayAuth("/v1/identities", {
        headers: {
          authorization: `Bearer ${tokenFor("admin", ["*"])}`,
        },
      });
      return;
    case 3:
      await fetchFromRelayAuth("/v1/identities", {
        headers: {
          authorization: `Bearer ${tokenFor("expired-agent", ["relayauth:identity:read:*"], -60)}`,
        },
      });
      return;
    case 4:
      await postJson("/v1/identities", tokenFor("budget-agent", ["relayauth:identity:manage:*"]), {
        name: `budget-agent-${Date.now()}`,
        sponsorId: "user_demo",
        budget: {
          maxActionsPerHour: 1,
          alertThreshold: 0.5,
          autoSuspend: true,
        },
        scopes: ["relayauth:identity:read:*"],
      });
      return;
  }
}

async function postJson(path: string, token: string, body: unknown): Promise<void> {
  await fetchFromRelayAuth(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function fetchFromRelayAuth(path: string, init: RequestInit): Promise<void> {
  await fetch(new URL(path, getRelayAuthUrl()), {
    ...init,
    cache: "no-store",
  }).catch(() => undefined);
}

function tokenFor(subject: string, scopes: string[], ttlSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: subject,
    org: "org_demo",
    wks: "ws_demo",
    scopes,
    sponsorId: "user_demo",
    sponsorChain: ["user_demo"],
    token_type: "access",
    iss: "relayauth:observer-demo",
    aud: ["relayauth", "relayfile"],
    iat: now,
    exp: now + ttlSeconds,
    jti: `demo-${randomUUID()}`,
  };

  const encodedHeader = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "dev-key" }));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", process.env.SIGNING_KEY ?? "dev-secret")
    .update(unsigned)
    .digest("base64url");

  return `${unsigned}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function getRelayAuthUrl(): string {
  return process.env.RELAYAUTH_URL || DEFAULT_RELAYAUTH_URL;
}
