import React, { useEffect } from "react";
import { Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import { base44 } from "@/api/base44Client";

// Landing point for the Google OAuth flow (server/src/routes/auth.routes.js's
// /auth/google/callback redirects here with ?token=&returnTo=). Stores the
// token client-side, then continues to wherever the operator was headed.
export default function AuthCallback() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const returnTo = params.get("returnTo") || "/";
    if (token) base44.auth.setToken(token);
    const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    window.location.href = safe;
  }, []);

  return (
    <AuthLayout icon={Loader2} title="Signing you in…">
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="w-5 h-5 mr-2 animate-spin" aria-hidden="true" />
        One moment…
      </div>
    </AuthLayout>
  );
}
