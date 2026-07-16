import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { getUserProfile, updateUserProfile } from "@/lib/db/queries";

const profileUpdateSchema = z.object({
  name: z
    .union([z.string().trim().min(2).max(64), z.literal("")])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === "") return null;
      return value;
    }),
  avatarUrl: z
    // Avatar URLs can be long depending on storage provider/pathname.
    // 2048 keeps us within typical URL limits while avoiding false rejections.
    // Allow both absolute URLs (cloud) and relative paths (local-fs).
    .union([z.string().trim().max(2048), z.literal("")])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      if (value === "") return null;
      return value;
    }),
});

export async function GET(_request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // Profile lives entirely in the local database. No cloud round-trip.
    const profile = await getUserProfile(session.user.id);
    if (!profile) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    return NextResponse.json(
      {
        user: {
          id: profile.id,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
          hasPassword: profile.hasPassword,
          updatedAt: profile.updatedAt,
          lastLoginAt: profile.lastLoginAt,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("[UserProfile] Failed to fetch profile", error);
    return NextResponse.json(
      { error: "failed_to_load_profile" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const payload = await request.json();
    const updates = profileUpdateSchema.parse(payload);

    // Profile lives entirely in the local database. No cloud sync needed.
    const updated = await updateUserProfile(session.user.id, updates);
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    return NextResponse.json(
      {
        user: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          avatarUrl: updated.avatarUrl,
          updatedAt: updated.updatedAt,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "invalid_payload", details: error.flatten() },
        { status: 400 },
      );
    }

    console.error("[UserProfile] Failed to update profile", error);
    return NextResponse.json(
      { error: "failed_to_update_profile" },
      { status: 500 },
    );
  }
}
