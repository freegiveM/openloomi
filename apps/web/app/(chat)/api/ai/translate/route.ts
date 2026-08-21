import { auth } from "@/app/(auth)/auth";
import { AppError } from "@melandlabs/shared/errors";
import { resolveLlmProvider } from "@/lib/ai/provider-resolver";

/**
 * POST /api/ai/translate
 *
 * Translate user's reply draft
 * Directly receive text to translate, not dependent on insight ID
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:auth").toResponse();
  }

  try {
    // Parse request body
    const body = await request.json();

    const { draft, targetLanguage } = body as {
      draft?: string;
      targetLanguage?: string;
    };

    if (!draft || draft.trim().length === 0) {
      return new AppError(
        "bad_request:api",
        "Draft content is required",
      ).toResponse();
    }

    if (!targetLanguage) {
      return new AppError(
        "bad_request:api",
        "Target language is required",
      ).toResponse();
    }

    const prompt = `You are a professional translator. Translate the following text to ${targetLanguage}.

Important guidelines:
- Maintain the original meaning and tone
- Use natural, fluent language
- Keep the same formatting (paragraphs, line breaks)
- If the text is already in the target language, improve its clarity and flow

Text to translate:
"""${draft}"""

Provide only the translation without any explanations or preamble.`;

    console.log("[Translate API] Translating draft", {
      draftLength: draft.length,
      targetLanguage,
    });

    const provider = await resolveLlmProvider({
      userId: session.user.id,
      prefer: "chat_completions",
      endpoint: "translate",
    });
    if (!provider) throw new Error("No AI provider configured");
    const { text } = await provider.complete({ userContent: prompt });

    console.log("[Translate API] Translated text length:", text.length);

    // Return translated text
    return Response.json({
      success: true,
      data: {
        translated: text.trim(),
      },
    });
  } catch (error) {
    console.error("[Translate API] Error:", error);

    if (error instanceof AppError) {
      return error.toResponse();
    }

    return new AppError(
      "bad_request:api",
      `Failed to translate draft: ${error instanceof Error ? error.message : String(error)}`,
    ).toResponse();
  }
}
