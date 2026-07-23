/**
 * GET  /api/loop/connectors               → cached
 * GET  /api/loop/connectors?refresh=1     → force refresh
 * POST /api/loop/connectors  {refresh:true} → force refresh
 *
 * Response shape (additive — older fields preserved):
 *   {
 *     items: ConnectorEntry[],           // Loop + native connector rows merged
 *     nativeAccounts?: NativeAccount[],  // NEW: raw native integration rows
 *     lastProbeError?: ProbeErrorInfo,
 *   }
 *
 * `nativeAccounts` is only present for authenticated users — anonymous
 * probes (the bridge's port-discovery ping, simple health checks) still
 * get the pre-merge `{ items }` shape so they don't have to special-case
 * the new key.
 */

import { NextResponse, type NextRequest } from "next/server";
import { authenticateCloudRequest } from "@/lib/auth/cloud-auth";
import { listIntegrationAccountRecordsByUser } from "@/lib/db/queries";
import {
  buildNativeChatConnectorEntries,
  buildNativeConnectorReadinessEntries,
  connectors,
  mergeNativeConnectorEntries,
} from "@/lib/loop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleConnectors(req: NextRequest, refresh: boolean) {
  // `?refresh=1` is a convenience for callers that can't easily POST a
  // JSON body (e.g., `<img src>`, simple `fetch()` probes, server
  // components). The actual refresh path is identical to POST
  // `{refresh:true}` — full 120s probe timeout, no silent-mode
  // short-circuit. Use POST when you want a controlled refresh and
  // don't mind the wait.
  const { items, lastProbeError } = await connectors({ refresh });

  // Surface native integrations on the Loomi online card without writing
  // them into the on-disk connector cache. An unauthenticated probe gets
  // `user === null` and skips this branch entirely.
  const user = await authenticateCloudRequest(req);
  let nativeAccounts:
    | Array<{
        id: string;
        platform: string;
        displayName: string;
        externalId: string;
        status: string;
      }>
    | undefined;
  let mergedItems = items;
  if (user) {
    const records = await listIntegrationAccountRecordsByUser(user.id);
    nativeAccounts = records;
    const nativeEntries = [
      ...buildNativeConnectorReadinessEntries(records),
      ...buildNativeChatConnectorEntries(records),
    ];
    if (nativeEntries.length > 0) {
      mergedItems = mergeNativeConnectorEntries(items, nativeEntries);
    }
  }

  const body: Record<string, unknown> = { items: mergedItems };
  if (nativeAccounts) body.nativeAccounts = nativeAccounts;
  // `lastProbeError` (#391) is only present when the most recent probe
  // failed; omit the key entirely on the happy path so existing
  // clients reading just `items` see no shape change.
  if (lastProbeError) body.lastProbeError = lastProbeError;
  return NextResponse.json(body);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const refresh = url.searchParams.get("refresh") === "1";
    return await handleConnectors(req as NextRequest, refresh);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "connectors failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    let body: { refresh?: boolean } = {};
    try {
      body = (await req.json()) as { refresh?: boolean };
    } catch {
      /* default to no-refresh */
    }
    return await handleConnectors(req as NextRequest, !!body.refresh);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "connectors failed" },
      { status: 500 },
    );
  }
}
