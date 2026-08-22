import { GoogleGenAI, Modality } from "@google/genai";

let _ai: GoogleGenAI | null = null;

/**
 * Image generation runs only through the managed Replit AI integration.
 * Env is validated lazily, at first use — merely importing the package (for
 * example, for text chat over a direct key) must never throw when the
 * managed pair is absent.
 */
function getImageClient(): GoogleGenAI {
  if (!_ai) {
    const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
    const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    if (!baseUrl) {
      throw new Error(
        "AI_INTEGRATIONS_GEMINI_BASE_URL must be set. Did you forget to provision the Gemini AI integration?",
      );
    }
    if (!apiKey) {
      throw new Error(
        "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
      );
    }
    _ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "", baseUrl },
    });
  }
  return _ai;
}

/** Lazily-resolved singleton. Throws at first use if env vars are missing. */
export const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    return (getImageClient() as unknown as Record<string | symbol, unknown>)[
      prop
    ];
  },
});

export async function generateImage(
  prompt: string
): Promise<{ b64_json: string; mimeType: string }> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error("No image data in response");
  }

  return {
    b64_json: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}
