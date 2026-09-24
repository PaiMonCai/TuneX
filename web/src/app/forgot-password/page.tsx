import { AuthShell } from "@/components/auth-shell";
import { ForgotPasswordBody } from "./forgot-password-body";

export default function ForgotPasswordPage() {
  return (
    <AuthShell>
      <ForgotPasswordBody />
    </AuthShell>
  );
}
