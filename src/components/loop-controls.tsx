"use client";

// P3-T4 — client-side composition of the two controls that render on
// `/loops/[loopId]`:
//   * `<LoopApprovalGate>` — only when `pendingApproval` is true, large
//     Approve / Deny buttons.
//   * `<LoopCancelButton>` — only when status is non-terminal.
//
// The page itself is a server component (it `await`s the tRPC caller),
// so this client wrapper exists to (a) own the `useRouter().refresh()`
// call shared by both controls and (b) keep the server file free of
// `"use client"` boundaries. After either action resolves we
// invalidate the page so the polling-free server fetch returns the
// freshly-finalized loop.
//
// `useRouter` is called inside a try/catch so the loop-detail
// `renderToStaticMarkup` test (which has no AppRouterContext) doesn't
// crash. In any real Next.js SSR / browser flow the context is
// present and the catch is dead code; the catch path simply degrades
// to "no client-side refresh" (the user can hard-reload — same UX
// the dispatch dialog ships with per Phase 2 T03 review §4).

import { useRouter } from "next/navigation";

import { LoopApprovalGate } from "@/src/components/loop-approval-gate";
import { LoopCancelButton } from "@/src/components/loop-cancel-button";

interface Props {
  loopId: string;
  status: string | null;
  pendingApproval: boolean;
}

// `useRouter` throws when there is no `AppRouterContext` provider —
// that's the case in the `renderToStaticMarkup` SSR-test flow used by
// `tests/app/loop-detail.test.ts`. The try/catch is a deliberate
// escape hatch: in any real Next.js render path the context is
// mounted and the catch is dead code. The fallback (`window.location
// .reload()`) keeps the user-visible behaviour correct — the page
// just hard-reloads after the action — even if some future test
// scenario lands here.
function useSafeRouterRefresh(): () => void {
  try {
    const router = useRouter();
    return () => router.refresh();
  } catch {
    return () => {
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    };
  }
}

export function LoopControls({ loopId, status, pendingApproval }: Props) {
  const refresh = useSafeRouterRefresh();

  return (
    <div className="space-y-4" data-testid="loop-controls">
      {pendingApproval ? (
        <LoopApprovalGate loopId={loopId} onResolved={refresh} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <LoopCancelButton
          loopId={loopId}
          status={status}
          onCancelled={refresh}
        />
      </div>
    </div>
  );
}
