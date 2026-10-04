import {
  renderTelegramInputRequest,
  registerTelegramFreeformPrompt,
  splitTelegramMessageText,
  type TelegramChannelState,
  type TelegramHandle,
} from "eve/channels/telegram";
import { redactNotice } from "./outbox.ts";
import { escHtml } from "./telegram-format.ts";
import { tr } from "./i18n.ts";
import {
  deliverScreenMessage,
  type ScreenCall,
} from "./telegram-screen-message.ts";

type Request = Parameters<typeof renderTelegramInputRequest>[0];
type Resolution = {
  requestId: string;
  outcome: "answered" | "approved" | "denied" | "ignored" | "invalid";
  response?: { optionId?: string; text?: string };
};
type Card = {
  messageId: string | number;
  prompt: string;
  labels: Record<string, string>;
  rich: boolean;
  settledStatus?: string;
};
export type QuestionState = TelegramChannelState & {
  questionCards?: Record<string, Card>;
};
type Handle = Pick<TelegramHandle, "request" | "chatId" | "post"> &
  Partial<Pick<TelegramHandle, "messageThreadId">>;

function transport(tg: Handle): ScreenCall {
  return async (method, body) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Awaited<ReturnType<TelegramHandle["request"]>>;
    try {
      response = await Promise.race([
        tg.request(
          method,
          body as NonNullable<Parameters<TelegramHandle["request"]>[1]>,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("preview edit timeout")),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const payload = response.body as {
      result?: { message_id?: number };
      description?: string;
    };
    return { ok: response.ok, ...payload };
  };
}

/** The channel persists the preview reference with Eve's compact callback mapping. */
export async function postTelegramQuestion(
  request: Request,
  state: QuestionState,
  tg: Handle,
  rich = false,
): Promise<void> {
  const rendered = renderTelegramInputRequest(request, state);
  const prompt = redactNotice(rendered.text);
  const keyboard = (
    rendered.replyMarkup as
      | {
          inline_keyboard?: Array<
            Array<{ text: string; callback_data: string }>
          >;
        }
      | undefined
  )?.inline_keyboard;
  // Keep native questions literal. Formatting rich plugin screens is a separate contract.
  let literal = prompt.replace(/[\\`*_{}[\]()#+.!|<>~=$-]/gu, "\\$&");
  const postNative = async () => {
    // Preserve Eve's literal text, ForceReply and long-message splitting behavior.
    const result = await tg.post({
      text: prompt,
      reply_markup: rendered.replyMarkup,
    });
    literal = splitTelegramMessageText(prompt)[0].replace(
      /[\\`*_{}[\]()#+.!|<>~=$-]/gu,
      "\\$&",
    );
    return result.id;
  };
  let sentRich = false;
  let messageId: number | string;
  if (rich && keyboard) {
    const buttons = keyboard
      .map(
        (row) =>
          `<tg-button-row>${row
            .map(
              (button) =>
                `<tg-button type="callback_data" data="${button.callback_data}">${escHtml(button.text)}</tg-button>`,
            )
            .join("")}</tg-button-row>`,
      )
      .join("\n\n");
    try {
      messageId = await deliverScreenMessage(
        transport(tg),
        tg.chatId,
        `${literal}\n\n${buttons}`,
        { rich: true, messageThreadId: tg.messageThreadId },
      );
      sentRich = true;
    } catch {
      messageId = await postNative();
    }
  } else {
    messageId = await postNative();
  }

  state.questionCards ??= {};
  state.questionCards[request.requestId] = {
    messageId,
    rich: sentRich,
    prompt: literal,
    labels: Object.fromEntries(
      (request.options ?? []).map(({ id, label }) => [id, label]),
    ),
  };
  if (rendered.freeformRequestId !== undefined || request.allowFreeform)
    registerTelegramFreeformPrompt(state, {
      messageId: String(messageId),
      requestId: request.requestId,
    });
}

/** Only the authoritative input.resolved event may settle the preview. */
export async function settleTelegramQuestions(
  resolutions: readonly Resolution[],
  state: QuestionState,
  tg: Handle,
): Promise<void> {
  for (const resolution of resolutions) {
    const card = state.questionCards?.[resolution.requestId];
    if (!card) continue;
    for (const [id, response] of Object.entries(state.hitlCallbacks ?? {}))
      if (response.requestId === resolution.requestId)
        delete state.hitlCallbacks?.[id];
    for (const [id, requestId] of Object.entries(
      state.pendingFreeformReplies ?? {},
    ))
      if (requestId === resolution.requestId)
        delete state.pendingFreeformReplies?.[id];
    // Never render freeform input: it may contain a credential or personal data.
    const label =
      resolution.response?.optionId === undefined
        ? undefined
        : card.labels[resolution.response.optionId];
    const text =
      label === undefined
        ? ["ignored", "invalid"].includes(resolution.outcome)
          ? tr("Question closed", "Вопрос закрыт")
          : tr("Answer received", "Ответ принят")
        : `${tr("Selected", "Выбрано")}: ${label}`;
    card.settledStatus = redactNotice(text).replace(
      /[\\`*_{}[\]()#+.!|<>~=$-]/gu,
      "\\$&",
    );
  }
  await flushSettledTelegramQuestions(state, tg);
}

/** Delivery recovery uses the accepted status, never the answer or business tool again. */
export async function flushSettledTelegramQuestions(
  state: QuestionState,
  tg: Handle,
): Promise<void> {
  for (const [requestId, card] of Object.entries(state.questionCards ?? {})) {
    if (!card.settledStatus) continue;
    try {
      await deliverScreenMessage(
        transport(tg),
        tg.chatId,
        `${card.prompt}\n\n${card.settledStatus}`,
        {
          messageId: card.messageId,
          rich: card.rich,
        },
      );
      delete state.questionCards?.[requestId];
    } catch {
      console.error("[telegram] could not settle question preview");
      if (!card.rich) {
        try {
          await transport(tg)("editMessageReplyMarkup", {
            chat_id: tg.chatId,
            message_id: card.messageId,
            reply_markup: { inline_keyboard: [] },
          });
        } catch {
          /* Retry only delivery when the turn completes or resumes. */
        }
      }
    }
  }
}
