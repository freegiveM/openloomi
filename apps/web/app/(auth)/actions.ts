"use server";

import { z } from "zod";
import { createUser, getUser } from "@/lib/db/queries";
import { authFormSchema } from "@/lib/auth/validation";
import { signIn } from "./auth";

/**
 * Map error codes to i18n keys
 */
function getErrorI18nKey(errorCode: string): string {
  const errorMap: Record<string, string> = {
    INVALID_CREDENTIALS: "auth.errorInvalidCredentials",
    USER_EXISTS: "auth.errorUserExists",
    USER_NOT_FOUND: "auth.errorUserNotFound",
    MISSING_EMAIL: "auth.errorMissingEmail",
    MISSING_PASSWORD: "auth.errorMissingPassword",
    INVALID_EMAIL: "auth.errorInvalidEmail",
    INVALID_PASSWORD: "auth.errorInvalidPassword",
  };

  return errorMap[errorCode] || errorCode;
}

export interface LoginActionState {
  status: "idle" | "in_progress" | "success" | "failed" | "invalid_data";
  error?: string;
}

/**
 * Local login.
 *
 * Always authenticates against the local database. OpenLoomi is open source
 * and self-hosted, so all auth lives in the local DB.
 */
export const login = async (
  _: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return {
      status: "failed",
      error: getErrorI18nKey(
        error instanceof Error ? error.message : "INVALID_CREDENTIALS",
      ),
    };
  }
};

export interface RegisterActionState {
  status:
    | "idle"
    | "in_progress"
    | "success"
    | "failed"
    | "user_exists"
    | "invalid_data";
  error?: string;
}

/**
 * Local registration.
 *
 * Always creates the user in the local database. The legacy cloud
 * register branch has been removed.
 */
export const register = async (
  _: RegisterActionState,
  formData: FormData,
): Promise<RegisterActionState> => {
  try {
    const validatedData = authFormSchema.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });

    const [user] = await getUser(validatedData.email);

    if (user) {
      return { status: "user_exists" };
    }

    await createUser(validatedData.email, validatedData.password);

    await signIn("credentials", {
      email: validatedData.email,
      password: validatedData.password,
      redirect: false,
    });

    return { status: "success" };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { status: "invalid_data" };
    }

    return { status: "failed" };
  }
};
