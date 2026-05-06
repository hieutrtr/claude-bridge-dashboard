"use client";

// P4-T02 — `/settings/users` page table.
//
// Props-driven view + a thin client wrapper. The wrapper owns:
//   * Local state for the invite modal + invite form
//   * Inline role-change select per row (server-confirmed; no optimistic UI)
//   * `<DangerConfirm>` integration for revoke
//   * Refresh-after-mutation by re-fetching the page (Next router.refresh)
//
// Mutations route through `users-client.ts` → tRPC. The invite + role
// change forms surface server errors verbatim (RBAC, validation, last-
// owner) so the user can recover without a console dive.
//
// No optimistic UI: matches the Phase 4 invariant for permission-shaped
// mutations (safety > snappiness). Revoke wraps in `<DangerConfirm>` so
// the user must type the email to confirm.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/src/components/ui/button";
import { DangerConfirm } from "@/src/components/danger-confirm";
import { readCsrfTokenFromCookie } from "@/src/lib/danger-confirm-client";
import {
  buildChangeRoleRequest,
  buildInviteRequest,
  buildRevokeRequest,
  isValidEmail,
  parseTrpcResponse,
  UsersMutationError,
  type UsersInviteInput,
  type UsersMutationResult,
} from "@/src/lib/users-client";
import type { UserListRow } from "@/src/server/routers/users";

export interface UsersTableProps {
  /** Active user rows from `users.list`. */
  items: UserListRow[];
  /** Caller's user id — used to disable self-revoke + last-owner cases in the UI. */
  callerId: string;
}

function formatDate(ms: number | null): string {
  if (ms === null || ms === 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function activeOwnerCount(items: UserListRow[]): number {
  let n = 0;
  for (const r of items) {
    if (r.role === "owner") n += 1;
  }
  return n;
}

interface InviteFormState {
  email: string;
  role: "owner" | "member";
  status: "idle" | "submitting" | "success" | "error";
  errorCode: string | null;
  errorMessage: string | null;
  resultBanner: string | null;
}

const EMPTY_INVITE_FORM: InviteFormState = {
  email: "",
  role: "member",
  status: "idle",
  errorCode: null,
  errorMessage: null,
  resultBanner: null,
};

interface RoleChangeState {
  /** id currently mid-flight to avoid duplicate clicks. */
  inFlight: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorForId: string | null;
}

const EMPTY_ROLE_CHANGE: RoleChangeState = {
  inFlight: null,
  errorCode: null,
  errorMessage: null,
  errorForId: null,
};

export function UsersTable(props: UsersTableProps) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState<InviteFormState>(EMPTY_INVITE_FORM);
  const [roleState, setRoleState] = useState<RoleChangeState>(EMPTY_ROLE_CHANGE);

  const ownerCount = activeOwnerCount(props.items);

  const submitInvite = useCallback(async () => {
    setInvite((s) => ({ ...s, status: "submitting", errorCode: null, errorMessage: null }));
    if (!isValidEmail(invite.email)) {
      setInvite((s) => ({
        ...s,
        status: "error",
        errorCode: "BAD_REQUEST",
        errorMessage: "Enter a valid email address.",
      }));
      return;
    }
    const csrf = readCsrfTokenFromCookie(document.cookie);
    if (csrf === null) {
      setInvite((s) => ({
        ...s,
        status: "error",
        errorCode: "csrf_missing",
        errorMessage: "Your session expired — reload the page.",
      }));
      return;
    }

    const input: UsersInviteInput = {
      email: invite.email.trim(),
      role: invite.role,
    };
    const { url, init } = buildInviteRequest(input, csrf);
    try {
      const res = await fetch(url, init);
      const data = (await res.json()) as unknown;
      const out = parseTrpcResponse<UsersMutationResult>(data);
      const banner = out.alreadyExisted
        ? "User already exists — no changes."
        : out.reactivated
          ? "User re-activated."
          : "Invite recorded. Ask the user to sign in via the magic-link form on /login.";
      setInvite({
        ...EMPTY_INVITE_FORM,
        status: "success",
        resultBanner: banner,
      });
      router.refresh();
    } catch (err) {
      const e =
        err instanceof UsersMutationError
          ? err
          : new UsersMutationError("INTERNAL_SERVER_ERROR", String(err));
      setInvite((s) => ({
        ...s,
        status: "error",
        errorCode: e.code,
        errorMessage: e.message,
      }));
    }
  }, [invite.email, invite.role, router]);

  const submitRoleChange = useCallback(
    async (id: string, role: "owner" | "member") => {
      setRoleState((s) => ({
        ...s,
        inFlight: id,
        errorCode: null,
        errorMessage: null,
        errorForId: null,
      }));
      const csrf = readCsrfTokenFromCookie(document.cookie);
      if (csrf === null) {
        setRoleState({
          inFlight: null,
          errorCode: "csrf_missing",
          errorMessage: "Your session expired — reload the page.",
          errorForId: id,
        });
        return;
      }
      const { url, init } = buildChangeRoleRequest({ id, role }, csrf);
      try {
        const res = await fetch(url, init);
        const data = (await res.json()) as unknown;
        parseTrpcResponse<UsersMutationResult>(data);
        setRoleState(EMPTY_ROLE_CHANGE);
        router.refresh();
      } catch (err) {
        const e =
          err instanceof UsersMutationError
            ? err
            : new UsersMutationError("INTERNAL_SERVER_ERROR", String(err));
        setRoleState({
          inFlight: null,
          errorCode: e.code,
          errorMessage: e.message,
          errorForId: id,
        });
      }
    },
    [router],
  );

  const submitRevoke = useCallback(
    async (id: string) => {
      const csrf = readCsrfTokenFromCookie(document.cookie);
      if (csrf === null) {
        throw new UsersMutationError(
          "csrf_missing",
          "Your session expired — reload the page.",
        );
      }
      const { url, init } = buildRevokeRequest({ id }, csrf);
      const res = await fetch(url, init);
      const data = (await res.json()) as unknown;
      parseTrpcResponse<UsersMutationResult>(data);
      router.refresh();
    },
    [router],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          Active dashboard users. Owners manage permissions, dispatch
          tasks, and view all cost data; members can dispatch and kill
          their own tasks.
        </p>
        <Button
          type="button"
          onClick={() => {
            setInvite(EMPTY_INVITE_FORM);
            setInviteOpen(true);
          }}
          data-role="open-invite"
        >
          Invite user
        </Button>
      </div>

      {invite.status === "success" && invite.resultBanner ? (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300"
          data-role="invite-success-banner"
        >
          {invite.resultBanner}
        </div>
      ) : null}

      <div
        className="overflow-x-auto rounded-md border border-[hsl(var(--border))]"
        data-role="users-table-wrapper"
      >
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-[hsl(var(--border))] bg-[hsl(var(--card))]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Email</th>
              <th scope="col" className="px-3 py-2 font-medium">Role</th>
              <th scope="col" className="px-3 py-2 font-medium">Last login</th>
              <th scope="col" className="px-3 py-2 font-medium">Joined</th>
              <th scope="col" className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.items.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-[hsl(var(--muted-foreground))]"
                  data-role="users-empty"
                >
                  No active users yet — invite the first one.
                </td>
              </tr>
            ) : null}
            {props.items.map((u) => {
              const isSelf = u.id === props.callerId;
              const lastOwner = u.role === "owner" && ownerCount <= 1;
              const demoteDisabled = lastOwner;
              const revokeDisabled = isSelf;
              const inFlight = roleState.inFlight === u.id;
              const errorForRow =
                roleState.errorForId === u.id
                  ? `${roleState.errorCode}: ${roleState.errorMessage}`
                  : null;

              return (
                <tr
                  key={u.id}
                  className="border-b border-[hsl(var(--border))]/60 last:border-0"
                  data-role="user-row"
                  data-user-id={u.id}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{u.email}</span>
                    {isSelf ? (
                      <span className="ml-2 rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-[10px] uppercase text-[hsl(var(--muted-foreground))]">
                        you
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <label className="sr-only" htmlFor={`role-${u.id}`}>
                      Change role for {u.email}
                    </label>
                    <select
                      id={`role-${u.id}`}
                      data-role="role-select"
                      value={u.role}
                      disabled={inFlight || demoteDisabled}
                      onChange={(e) =>
                        void submitRoleChange(
                          u.id,
                          e.target.value as "owner" | "member",
                        )
                      }
                      className="h-8 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="member">member</option>
                      <option value="owner">owner</option>
                    </select>
                    {demoteDisabled ? (
                      <p className="mt-1 text-[10px] text-[hsl(var(--muted-foreground))]">
                        Last owner — cannot demote.
                      </p>
                    ) : null}
                    {errorForRow ? (
                      <p
                        className="mt-1 text-[10px] text-red-400"
                        data-role="role-change-error"
                      >
                        {errorForRow}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatDate(u.lastLoginAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {revokeDisabled ? (
                      <span className="text-[10px] text-[hsl(var(--muted-foreground))]">
                        cannot revoke self
                      </span>
                    ) : (
                      <DangerConfirm
                        verb="Revoke"
                        subject={`access for ${u.email}`}
                        expectedConfirmation={u.email}
                        trigger={
                          <Button
                            type="button"
                            variant="outline"
                            data-role="revoke-trigger"
                            className="border-red-500/40 text-red-300 hover:bg-red-500/10"
                          >
                            Revoke
                          </Button>
                        }
                        onSubmit={() => submitRevoke(u.id)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {inviteOpen ? (
        <InviteModal
          state={invite}
          onChange={setInvite}
          onClose={() => setInviteOpen(false)}
          onSubmit={submitInvite}
        />
      ) : null}
    </div>
  );
}

interface InviteModalProps {
  state: InviteFormState;
  onChange: (next: InviteFormState | ((prev: InviteFormState) => InviteFormState)) => void;
  onClose: () => void;
  onSubmit: () => void;
}

function InviteModal(props: InviteModalProps) {
  const { state } = props;
  const submitting = state.status === "submitting";
  const disabled = submitting || state.email.trim().length === 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-user-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] shadow-xl">
        <header className="flex items-center justify-between gap-2 border-b border-[hsl(var(--border))] px-4 py-3">
          <h2
            id="invite-user-title"
            className="text-base font-semibold tracking-tight"
          >
            Invite user
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Close invite dialog"
            className="rounded-md px-2 py-1 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
          >
            ✕
          </button>
        </header>

        <form
          className="space-y-4 px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmit();
          }}
        >
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Inviting creates the user record. Ask the invitee to sign in
            via the magic-link form on the login page — no email is
            sent automatically.
          </p>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-[hsl(var(--muted-foreground))]">Email</span>
            <input
              type="email"
              required
              autoFocus
              value={state.email}
              onChange={(e) =>
                props.onChange((s) => ({
                  ...s,
                  email: e.target.value,
                  status: "idle",
                  errorCode: null,
                  errorMessage: null,
                }))
              }
              maxLength={320}
              className="h-9 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-2 font-mono text-sm"
              data-role="invite-email"
            />
          </label>

          <fieldset className="flex flex-col gap-2 text-xs">
            <legend className="text-[hsl(var(--muted-foreground))]">Role</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="invite-role"
                value="member"
                checked={state.role === "member"}
                onChange={() =>
                  props.onChange((s) => ({ ...s, role: "member" }))
                }
              />
              <span>member — dispatch own tasks, view own cost</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="invite-role"
                value="owner"
                checked={state.role === "owner"}
                onChange={() =>
                  props.onChange((s) => ({ ...s, role: "owner" }))
                }
              />
              <span>owner — full access (manage users + audit)</span>
            </label>
          </fieldset>

          {state.status === "error" ? (
            <p
              className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-300"
              data-role="invite-error"
            >
              <span className="font-mono font-semibold">{state.errorCode}</span>
              {" — "}
              {state.errorMessage}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" type="button" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={disabled} data-role="invite-submit">
              {submitting ? "Inviting…" : "Send invite"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
