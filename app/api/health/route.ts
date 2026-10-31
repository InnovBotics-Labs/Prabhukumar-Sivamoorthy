import { NextResponse } from "next/server";

/**
 * Liveness/readiness probe target for the Kubernetes deployment (see k8s/).
 * Deliberately trivial: no rendering, no external calls. If the Node process
 * can answer this, the pod is healthy.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
