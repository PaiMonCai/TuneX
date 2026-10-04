import { Suspense } from "react";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export default function RegisterPage() {
  return (
    <AuthShell>
      <Suspense fallback={null}>
        <AuthForm mode="register" />
      </Suspense>
    </AuthShell>
  );
}
