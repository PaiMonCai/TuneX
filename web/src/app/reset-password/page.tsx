import { AuthShell } from "@/components/auth-shell";
import { ResetPasswordBody } from "./reset-password-body";

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <ResetPasswordBody />
    </AuthShell>
  );
}
