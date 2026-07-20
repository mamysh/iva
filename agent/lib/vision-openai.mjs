export async function describeImageOpenAICompatible({
  bytes,
  mimeType,
  baseURL,
  apiKey,
  visionModel,
  prompt,
  maxOutputTokens,
}) {
  const b64 = Buffer.from(bytes).toString("base64");
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: visionModel,
      max_tokens: maxOutputTokens ?? 700,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.choices?.[0]?.message?.content ?? "").trim();
}
