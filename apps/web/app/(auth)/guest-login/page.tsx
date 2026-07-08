"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession } from "next-auth/react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Guest login page - automatically creates a guest account and redirects to home.
 * This page is used when users access the app without logging in.
 */
export default function GuestLoginPage() {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    // Create guest account and sign in
    const createGuestAndLogin = async () => {
      if (isCreating) return;
      setIsCreating(true);

      try {
        // Check if already authenticated (to avoid loops when middleware redirects back)
        const session = await getSession();
        if (session?.user) {
          // Already logged in, go to home
          router.push("/");
          return;
        }

        const response = await fetch("/api/auth/guest", {
          method: "POST",
          credentials: "include",
        });

        if (response.ok) {
          // Sync the freshly minted JWT to ~/.openloomi/token in Tauri mode
          // so the desktop loop can authenticate immediately. Done here
          // (right after the session cookie is set) rather than in the
          // root-level `TokenSync` component because the cookie was set by
          // a direct fetch and `useSession` does not pick up the change
          // automatically.
          const isTauri = !!(window as { __TAURI__?: unknown }).__TAURI__;
          if (isTauri) {
            try {
              const tokenRes = await fetch("/api/auth/token", {
                credentials: "include",
              });
              if (tokenRes.ok) {
                const data = (await tokenRes.json()) as { token?: string };
                if (data.token) {
                  await invoke("save_token", { token: data.token });
                  console.log(
                    "[GuestLogin] token synced to ~/.openloomi/token",
                  );
                }
              }
            } catch (err) {
              console.warn("[GuestLogin] failed to sync token:", err);
            }
          }
          // Successful login, go to home
          router.push("/");
        } else {
          console.error("[GuestLogin] Failed to create guest account");
          router.push("/");
        }
      } catch (error) {
        console.error("[GuestLogin] Error:", error);
        router.push("/");
      }
    };

    createGuestAndLogin();
  }, [router, isCreating]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mx-auto mb-4" />
        <p className="text-muted-foreground">Creating guest account...</p>
      </div>
    </div>
  );
}
