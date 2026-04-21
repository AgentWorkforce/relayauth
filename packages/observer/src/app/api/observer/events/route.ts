import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_RELAYAUTH_URL = "http://localhost:8787";

export async function GET(request: NextRequest): Promise<Response> {
  const upstreamUrl = new URL("/v1/observer/events", getRelayAuthUrl());
  upstreamUrl.search = request.nextUrl.search;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      accept: "text/event-stream",
    },
    cache: "no-store",
    signal: request.signal,
  });

  if (!upstream.body) {
    return Response.json({ error: "Observer event stream unavailable" }, { status: 502 });
  }

  const headers = new Headers(upstream.headers);
  headers.set("content-type", headers.get("content-type") ?? "text/event-stream");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function getRelayAuthUrl(): string {
  return process.env.RELAYAUTH_URL || DEFAULT_RELAYAUTH_URL;
}
