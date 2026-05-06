// P4-T01 — error banner for magic-link consume failures.
//
// The consume route redirects to `/login?error=<code>` on failure;
// this component maps the code to friendly copy. Server component
// (no client JS) — keeps the login page lightweight.

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  expired_token: {
    title: "Link expired",
    body: "Magic links expire 15 minutes after they're sent. Request a new one below.",
  },
  used_token: {
    title: "Link already used",
    body: "That magic link has already been used to sign in. Request a fresh one if you need to sign in again.",
  },
  invalid_token: {
    title: "Link not recognised",
    body: "We couldn't find that magic link. Make sure you copied the full URL or request a new link below.",
  },
  missing_token: {
    title: "Link missing token",
    body: "The magic link in your email looks incomplete. Request a new one below.",
  },
  user_revoked: {
    title: "Account access revoked",
    body: "Your dashboard access has been revoked. Ask the workspace owner to restore it.",
  },
  server_error: {
    title: "Something went wrong",
    body: "We couldn't sign you in. Try again, and if the problem persists check the dashboard logs.",
  },
};

export function LoginErrorBanner({ error }: { error: string }) {
  const copy = ERROR_COPY[error] ?? {
    title: "Sign-in failed",
    body: "Something went wrong. Try again or request a new magic link.",
  };
  return (
    <div
      role="alert"
      className="rounded-md border border-red-300/50 bg-red-50/40 p-3 text-sm dark:bg-red-950/30"
    >
      <p className="font-medium">{copy.title}</p>
      <p className="text-[hsl(var(--foreground))]/80">{copy.body}</p>
    </div>
  );
}
