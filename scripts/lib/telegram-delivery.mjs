import { htmlToPlain, needsRichMessage, toTelegramHtmlChunks } from "./telegram-format.mjs";

export async function deliverTelegramMarkdown({
  markdown,
  sendRich,
  sendHtml,
  sendPlain,
  onFailure = () => {},
  htmlLimit = 4096,
}) {
  const text = String(markdown ?? "");
  if (needsRichMessage(text)) {
    try {
      const result = await sendRich(text);
      if (result?.ok) return { transport: "rich", messages: 1, fellBack: false };
      onFailure("rich-rejected", result);
    } catch (error) {
      onFailure("rich-failed", error);
    }
  }

  let messages = 0;
  let usedPlain = false;
  for (const html of toTelegramHtmlChunks(text, htmlLimit)) {
    if (!html) continue;
    try {
      await sendHtml(html);
    } catch (error) {
      onFailure("html-failed", error);
      usedPlain = true;
      try {
        await sendPlain(htmlToPlain(html));
      } catch (plainError) {
        onFailure("plain-failed", plainError);
        continue;
      }
    }
    messages += 1;
  }
  return { transport: usedPlain ? "plain" : "html", messages, fellBack: usedPlain || needsRichMessage(text) };
}
