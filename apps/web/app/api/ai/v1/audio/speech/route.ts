import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { isTauriMode } from "@/lib/env/constants";
import { AppError } from "@openloomi/shared/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_KOKORO_TTS_BASE_URL = "http://127.0.0.1:8880/v1";
const DEFAULT_KOKORO_TTS_MODEL = "kokoro";
const DEFAULT_KOKORO_TTS_VOICE = "af_bella";
const DEFAULT_KOKORO_TTS_RESPONSE_FORMAT = "mp3";
const DEFAULT_KOKORO_TTS_SPEED = 1;
const HEALTH_TIMEOUT_MS = 5_000;
const SPEECH_TIMEOUT_MS = 600_000;

const supportedResponseFormats = new Set([
  "mp3",
  "wav",
  "opus",
  "flac",
  "m4a",
  "pcm",
]);

type KokoroResponseFormat = "mp3" | "wav" | "opus" | "flac" | "m4a" | "pcm";

type SpeechPayload = {
  input: string;
  model: string;
  voice: string;
  responseFormat: KokoroResponseFormat;
  speed: number;
};

const DISABLED_ENV_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

async function authorize() {
  const session = await auth().catch(() => null);
  if (!session?.user?.id && !isTauriMode()) {
    return false;
  }
  return true;
}

function isEnabledByEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  return !DISABLED_ENV_VALUES.has(normalized);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeKokoroBaseUrl(baseUrl?: string): string {
  const normalized = (baseUrl || DEFAULT_KOKORO_TTS_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  if (!normalized) {
    return DEFAULT_KOKORO_TTS_BASE_URL;
  }
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function readResponseFormat(value: unknown): KokoroResponseFormat | undefined {
  const format = readString(value);
  if (!format) return undefined;
  return supportedResponseFormats.has(format)
    ? (format as KokoroResponseFormat)
    : undefined;
}

function readPayloadResponseFormat(
  value: unknown,
): KokoroResponseFormat | undefined {
  const format = readString(value);
  if (!format) return undefined;
  const responseFormat = readResponseFormat(format);
  if (!responseFormat) {
    throw new AppError(
      "bad_request:api",
      "Unsupported Kokoro response_format.",
    );
  }
  return responseFormat;
}

function readPositiveNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new AppError("bad_request:api", "speed must be a positive number.");
  }
  return numberValue;
}

async function readSpeechPayload(request: Request): Promise<SpeechPayload> {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    throw new AppError("bad_request:api", "Invalid TTS payload.");
  }

  const input = readString(body.input) ?? readString(body.text);
  if (!input) {
    throw new AppError("bad_request:api", "input is required.");
  }

  return {
    input,
    model:
      readString(body.model) ??
      readString(process.env.KOKORO_TTS_MODEL) ??
      DEFAULT_KOKORO_TTS_MODEL,
    voice:
      readString(body.voice) ??
      readString(process.env.KOKORO_TTS_VOICE) ??
      DEFAULT_KOKORO_TTS_VOICE,
    responseFormat:
      readPayloadResponseFormat(body.response_format ?? body.responseFormat) ??
      readResponseFormat(process.env.KOKORO_TTS_RESPONSE_FORMAT) ??
      DEFAULT_KOKORO_TTS_RESPONSE_FORMAT,
    speed: readPositiveNumber(body.speed) ?? DEFAULT_KOKORO_TTS_SPEED,
  };
}

function createRequestSignal(signal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromInput = () => controller.abort();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", abortFromInput, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", abortFromInput);
    },
  };
}

async function readProviderError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) {
    return `Kokoro returned HTTP ${response.status.toString()}`;
  }

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
      detail?: unknown;
    };
    const message =
      typeof parsed.error?.message === "string"
        ? parsed.error.message
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.detail === "string"
            ? parsed.detail
            : null;
    return message ?? text.trim().slice(0, 400);
  } catch {
    return text.trim().slice(0, 400);
  }
}

function extractVoiceIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const voices = (data as { voices?: unknown }).voices;
  if (!Array.isArray(voices)) return [];

  return voices
    .map((voice) => {
      if (typeof voice === "string") return voice;
      if (voice && typeof voice === "object") {
        const id = (voice as { id?: unknown }).id;
        return typeof id === "string" ? id : null;
      }
      return null;
    })
    .filter((voice): voice is string => Boolean(voice));
}

function createForwardedAudioHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
  });

  for (const header of [
    "content-type",
    "content-length",
    "content-disposition",
    "accept-ranges",
  ]) {
    const value = upstreamHeaders.get(header);
    if (value) {
      headers.set(header, value);
    }
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "audio/mpeg");
  }

  return headers;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function GET(request: Request) {
  if (!(await authorize())) {
    return new AppError("unauthorized:auth").toResponse();
  }

  if (!isEnabledByEnv(process.env.NEXT_PUBLIC_ENABLE_KOKORO)) {
    return NextResponse.json(
      {
        ready: false,
        enabled: false,
        message: "Kokoro text-to-speech is disabled.",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const baseUrl = normalizeKokoroBaseUrl(process.env.KOKORO_TTS_BASE_URL);
  const { signal, cleanup } = createRequestSignal(
    request.signal,
    HEALTH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${baseUrl}/audio/voices`, {
      method: "GET",
      signal,
    });

    if (!response.ok) {
      throw new Error(await readProviderError(response));
    }

    const data = (await response.json().catch(() => null)) as unknown;
    return NextResponse.json(
      {
        ready: true,
        baseUrl,
        model:
          readString(process.env.KOKORO_TTS_MODEL) ?? DEFAULT_KOKORO_TTS_MODEL,
        voice:
          readString(process.env.KOKORO_TTS_VOICE) ?? DEFAULT_KOKORO_TTS_VOICE,
        voices: extractVoiceIds(data),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[Audio Speech] Kokoro health check failed", error);
    if (isAbortError(error)) {
      return new AppError(
        "offline:api",
        "Kokoro TTS health check timed out.",
      ).toResponse();
    }
    return new AppError(
      "offline:api",
      error instanceof Error
        ? error.message
        : "Kokoro TTS service is not reachable.",
    ).toResponse();
  } finally {
    cleanup();
  }
}

export async function POST(request: Request) {
  if (!(await authorize())) {
    return new AppError("unauthorized:auth").toResponse();
  }

  if (!isEnabledByEnv(process.env.NEXT_PUBLIC_ENABLE_KOKORO)) {
    return new AppError(
      "offline:api",
      "Kokoro text-to-speech is disabled.",
    ).toResponse();
  }

  try {
    const payload = await readSpeechPayload(request);
    const baseUrl = normalizeKokoroBaseUrl(process.env.KOKORO_TTS_BASE_URL);
    const { signal, cleanup } = createRequestSignal(
      request.signal,
      SPEECH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: payload.model,
          input: payload.input,
          voice: payload.voice,
          response_format: payload.responseFormat,
          speed: payload.speed,
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(await readProviderError(response));
      }

      if (!response.body) {
        throw new Error("Kokoro TTS response did not include audio.");
      }

      return new Response(response.body, {
        status: response.status,
        headers: createForwardedAudioHeaders(response.headers),
      });
    } finally {
      cleanup();
    }
  } catch (error) {
    console.error("[Audio Speech] Failed to generate speech", error);
    if (error instanceof AppError) {
      return error.toResponse();
    }
    if (isAbortError(error)) {
      return new AppError(
        "offline:api",
        "Kokoro TTS request was aborted.",
      ).toResponse();
    }
    return new AppError(
      "offline:api",
      error instanceof Error ? error.message : "Kokoro TTS request failed.",
    ).toResponse();
  }
}
