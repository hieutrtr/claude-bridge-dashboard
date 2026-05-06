import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { readAuthEnv } from "@/src/lib/auth";
import { readResendConfig } from "@/src/server/resend";

import { LoginForm } from "./login-form";
import { MagicLinkForm } from "./magic-link-form";
import { LoginErrorBanner } from "./login-error-banner";

interface LoginPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const env = readAuthEnv();
  const passwordConfigured = !!env.password && !!env.secret;
  const magicLinkConfigured = !!readResendConfig() && !!env.secret;
  const params = (await searchParams) ?? {};
  const errorParam = Array.isArray(params.error) ? params.error[0] : params.error;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <p className="text-sm text-[hsl(var(--foreground))]/70">
            Sign in with the dashboard password or request a one-time magic link via email.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {errorParam ? <LoginErrorBanner error={errorParam} /> : null}
          {passwordConfigured ? (
            <section aria-labelledby="login-password-heading">
              <h2 id="login-password-heading" className="text-sm font-medium pb-2">Password</h2>
              <LoginForm />
            </section>
          ) : null}
          {magicLinkConfigured ? (
            <section aria-labelledby="login-magic-link-heading">
              <h2 id="login-magic-link-heading" className="text-sm font-medium pb-2">Email magic link</h2>
              <MagicLinkForm />
            </section>
          ) : (
            <p className="text-sm text-[hsl(var(--foreground))]/70">
              Email magic-link sign-in is not configured. Set <code>RESEND_API_KEY</code> and <code>RESEND_FROM_EMAIL</code> to enable it.
            </p>
          )}
          {!passwordConfigured && !magicLinkConfigured ? (
            <p className="text-sm text-[hsl(var(--foreground))]/70">
              Auth is not configured. Set <code>DASHBOARD_PASSWORD</code> and{" "}
              <code>JWT_SECRET</code> in the dashboard environment, then restart.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
