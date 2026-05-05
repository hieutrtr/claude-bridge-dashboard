import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/card";
import { readAuthEnv } from "@/src/lib/auth";

import { LoginForm } from "./login-form";

export default function LoginPage() {
  const env = readAuthEnv();
  const configured = !!env.password && !!env.secret;
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <p className="text-sm text-[hsl(var(--foreground))]/70">
            Enter the password configured in <code>DASHBOARD_PASSWORD</code> to
            access the dashboard.
          </p>
        </CardHeader>
        <CardContent>
          {configured ? (
            <LoginForm />
          ) : (
            <p className="text-sm text-[hsl(var(--foreground))]/70">
              Auth is not configured. Set <code>DASHBOARD_PASSWORD</code> and{" "}
              <code>JWT_SECRET</code> in the dashboard environment, then
              restart.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
