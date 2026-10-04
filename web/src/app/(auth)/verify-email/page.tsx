import { AuthShell } from "@/components/auth-shell";
import { VerifyEmailBody } from "./verify-email-body";

export default function VerifyEmailPage() {
  return (
    <AuthShell>
      <VerifyEmailBody />
    </AuthShell>
  );
}
