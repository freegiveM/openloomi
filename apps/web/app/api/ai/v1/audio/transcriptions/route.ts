import { NextResponse } from "next/server";
import { WhisperPlugin } from "@melandlabs/voice-whisper";

import { auth } from "@/app/(auth)/auth";
import { isTauriMode } from "@/lib/env/constants";
import { MAX_VOICE_UPLOAD_BYTES } from "@/lib/audio/voice-input";
import { AppError } from "@melandlabs/shared/errors";

export const runtime = "nodejs";

type TranscriptionPayload = {
  file: Blob;
  filename: string;
  model?: string;
  responseFormat?: "json" | "text" | "verbose_json" | "srt" | "vtt";
  language?: string;
  prompt?: string;
  temperature?: number;
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

function readResponseFormat(
  value: unknown,
): TranscriptionPayload["responseFormat"] | undefined {
  const format = readString(value);
  if (
    format === "json" ||
    format === "text" ||
    format === "verbose_json" ||
    format === "srt" ||
    format === "vtt"
  ) {
    return format;
  }
  return undefined;
}

function readTemperature(value: unknown): number | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  const temperature = Number(raw);
  return Number.isFinite(temperature) ? temperature : undefined;
}

function inferFilenameFromUrl(audioUrl: string): string {
  try {
    const pathname = new URL(audioUrl).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).at(-1);
    return lastSegment || "voice-input.wav";
  } catch {
    return "voice-input.wav";
  }
}

async function fileFromAudioUrl(
  audioUrl: string,
  request: Request,
): Promise<Pick<TranscriptionPayload, "file" | "filename">> {
  const url = new URL(audioUrl, request.url);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(
      `Unable to fetch audio_url: HTTP ${response.status.toString()}`,
    );
  }

  const contentType = response.headers.get("content-type") || "audio/wav";
  const arrayBuffer = await response.arrayBuffer();
  return {
    file: new Blob([arrayBuffer], { type: contentType }),
    filename: inferFilenameFromUrl(url.toString()),
  };
}

async function parseMultipartPayload(
  request: Request,
): Promise<TranscriptionPayload> {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof Blob)) {
    throw new AppError("bad_request:api", "Audio file is missing.");
  }

  return {
    file,
    filename:
      file instanceof File && typeof file.name === "string"
        ? file.name
        : "voice-input.wav",
    model: readString(formData.get("model")),
    responseFormat: readResponseFormat(formData.get("response_format")),
    language: readString(formData.get("language")),
    prompt: readString(formData.get("prompt")),
    temperature: readTemperature(formData.get("temperature")),
  };
}

async function parseJsonPayload(
  request: Request,
): Promise<TranscriptionPayload> {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) {
    throw new AppError("bad_request:api", "Invalid transcription payload.");
  }

  const audioUrl = readString(body.audio_url);
  if (!audioUrl) {
    throw new AppError("bad_request:api", "audio_url is required.");
  }

  const audio = await fileFromAudioUrl(audioUrl, request);
  return {
    ...audio,
    model: readString(body.model),
    responseFormat: readResponseFormat(body.response_format),
    language: readString(body.language),
    prompt: readString(body.prompt),
    temperature:
      typeof body.temperature === "number"
        ? body.temperature
        : readTemperature(body.temperature),
  };
}

async function parsePayload(request: Request): Promise<TranscriptionPayload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return parseJsonPayload(request);
  }
  return parseMultipartPayload(request);
}

export async function POST(request: Request) {
  if (!(await authorize())) {
    return new AppError("unauthorized:auth").toResponse();
  }

  if (!isEnabledByEnv(process.env.NEXT_PUBLIC_ENABLE_WHISPER)) {
    return new AppError(
      "offline:api",
      "Whisper speech-to-text is disabled.",
    ).toResponse();
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return new AppError(
      "offline:api",
      "OPENAI_API_KEY is not configured for audio transcription.",
    ).toResponse();
  }

  try {
    const payload = await parsePayload(request);
    if (payload.file.size <= 0) {
      return new AppError(
        "bad_request:api",
        "Audio file is empty.",
      ).toResponse();
    }
    if (payload.file.size > MAX_VOICE_UPLOAD_BYTES) {
      return new AppError(
        "bad_request:api",
        "Audio file exceeds the 50MB limit.",
      ).toResponse();
    }

    const model =
      payload.model?.trim() ||
      process.env.OPENAI_AUDIO_TRANSCRIPTION_MODEL?.trim() ||
      "whisper-1";
    const baseUrl =
      process.env.OPENAI_AUDIO_BASE_URL?.trim() || "https://api.openai.com/v1";
    const whisper = new WhisperPlugin({
      enabled: true,
      model,
      apiKey,
      baseUrl,
    });

    const result = await whisper.transcribe({
      file: payload.file,
      filename: payload.filename,
      model,
      responseFormat: payload.responseFormat || "json",
      language: payload.language,
      prompt: payload.prompt,
      temperature: payload.temperature,
      signal: request.signal,
    });

    return NextResponse.json({ text: result.text });
  } catch (error) {
    console.error("[Audio Transcriptions] Failed to transcribe audio", error);
    if (error instanceof AppError) {
      return error.toResponse();
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return new AppError(
        "offline:api",
        "Audio transcription request was aborted.",
      ).toResponse();
    }
    return new AppError(
      "bad_request:api",
      error instanceof Error ? error.message : "Audio transcription failed.",
    ).toResponse();
  }
}
