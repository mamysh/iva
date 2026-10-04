import { mdToTelegramHtml } from "./telegram-format.ts";

export type ScreenCall = (
  method: string,
  body: Record<string, unknown>,
) => Promise<{
  ok?: boolean;
  result?: { message_id?: number };
  description?: string;
}>;

/** A failed edit never sends another message or repeats its business action. */
export async function deliverScreenMessage(
  call: ScreenCall,
  chatId: string | number,
  markdown: string,
  options: {
    messageId?: string | number;
    messageThreadId?: number;
    rich?: boolean;
    keyboard?: Array<Array<{ text: string; callback_data: string }>>;
    replyMarkup?: Record<string, unknown>;
  } = {},
): Promise<number | string> {
  const edit = options.messageId !== undefined;
  const base = {
    chat_id: chatId,
    ...(!edit && options.messageThreadId !== undefined
      ? { message_thread_id: options.messageThreadId }
      : {}),
    ...(edit ? { message_id: options.messageId } : {}),
  };
  if (options.rich) {
    const response = await call(edit ? "editMessageText" : "sendRichMessage", {
      ...base,
      rich_message: { markdown },
      ...(edit ? { reply_markup: { inline_keyboard: [] } } : {}),
    });
    if (response.ok) {
      if (edit) return options.messageId!;
      if (response.result?.message_id !== undefined)
        return response.result.message_id;
      throw new Error("screen delivery missing message id");
    }
    if (edit && response.description?.includes("message is not modified"))
      return options.messageId!;
    // Rich edits cannot safely become HTML: the old embedded buttons may survive.
    throw new Error("rich screen delivery failed");
  }
  const response = await call(edit ? "editMessageText" : "sendMessage", {
    ...base,
    text: mdToTelegramHtml(markdown),
    parse_mode: "HTML",
    reply_markup: options.replyMarkup ?? {
      inline_keyboard: options.keyboard ?? [],
    },
    link_preview_options: { is_disabled: true },
  });
  if (
    edit &&
    (response.ok || response.description?.includes("message is not modified"))
  )
    return options.messageId!;
  if (response.ok && response.result?.message_id !== undefined)
    return response.result.message_id;
  throw new Error("screen delivery failed");
}
