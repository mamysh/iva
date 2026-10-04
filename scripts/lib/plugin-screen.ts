import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { acquireFileLock, releaseFileLock } from "#lib/fs-atomic.ts";
import { saveJsonAtomic } from "#lib/json-store.ts";
import { escHtml } from "#lib/telegram-format.ts";
import {
  deliverScreenMessage,
  type ScreenCall,
} from "#lib/telegram-screen-message.ts";

const action = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(80),
    style: z.enum(["success", "danger"]).optional(),
  })
  .strict();
export const screenViewSchema = z
  .object({
    markdown: z
      .string()
      .min(1)
      .max(12000)
      .refine((value) => !/<\/?(?:tg-button|iva-action)/iu.test(value)),
    rows: z.array(z.array(action).min(1).max(4)).max(12),
  })
  .strict()
  .refine((value) => {
    const ids = value.rows.flat().map((button) => button.id);
    return new Set(ids).size === ids.length;
  });
export const screenResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("show"), view: screenViewSchema }).strict(),
  z
    .object({
      type: z.literal("close"),
      markdown: z
        .string()
        .min(1)
        .max(12000)
        .refine((value) => !/<\/?tg-button/iu.test(value)),
    })
    .strict(),
]);
export type ScreenEvent =
  | { type: "open"; eventId: string }
  | {
      type: "action";
      screen: string;
      revision: number;
      actionId: string;
      eventId: string;
    };
export type ScreenEndpoint = {
  plugin: string;
  command: string;
  fingerprint: string;
  call: (event: ScreenEvent) => Promise<unknown>;
};
const view = screenViewSchema;
const stateSchema = z
  .object({
    schema: z.literal(1),
    plugin: z.string(),
    fingerprint: z.string(),
    chatId: z.number().int(),
    userId: z.number().int(),
    expiresAt: z.number(),
    messageId: z.union([z.number().int(), z.string()]),
    revision: z.number().int().nonnegative(),
    phase: z.enum(["ready", "busy", "closed"]),
    rich: z.boolean(),
    view,
    lastCallback: z.string().optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const PREFIX = "iva_screen:";
const TTL = 15 * 60_000;
const callbackSchema =
  /^iva_screen:([a-f0-9]{32}):(0|[1-9]\d{0,5}):(0|[1-9]\d?)$/u;

export function parseScreenCallback(data: string) {
  const match = callbackSchema.exec(data);
  return match
    ? { id: match[1], revision: Number(match[2]), index: Number(match[3]) }
    : null;
}

export function screenMarkdown(
  state: Pick<State, "view" | "revision">,
  id: string,
): string {
  let index = 0;
  const rows = state.view.rows.map(
    (row) =>
      `<tg-button-row>${row
        .map(
          (button) =>
            `<tg-button type="callback_data" data="${PREFIX}${id}:${state.revision}:${index++}"${button.style ? ` style="${button.style}"` : ""}>${escHtml(button.label)}</tg-button>`,
        )
        .join("")}</tg-button-row>`,
  );
  return [state.view.markdown, ...rows].join("\n\n");
}

/** Bridge-owned screens. No session or model dependency; storage stays private. */
export function createPluginScreens(options: {
  dataDir: string;
  call: ScreenCall;
  endpoints: () => Promise<readonly ScreenEndpoint[]>;
  allowed: (userId: number) => boolean;
  rich: () => boolean;
  now?: () => number;
}) {
  const dir = join(options.dataDir, "telegram-screens");
  const now = options.now ?? Date.now;
  const path = (id: string) => join(dir, `${id}.json`);
  const save = (id: string, state: State) =>
    saveJsonAtomic(path(id), state, { mode: 0o600 });
  const render = async (id: string, state: State) => {
    let index = 0;
    await deliverScreenMessage(
      options.call,
      state.chatId,
      state.rich ? screenMarkdown(state, id) : state.view.markdown,
      {
        messageId: state.messageId,
        rich: state.rich,
        keyboard: state.view.rows.map((row) =>
          row.map((button) => ({
            text: button.label,
            ...(button.style ? { style: button.style } : {}),
            callback_data: `${PREFIX}${id}:${state.revision}:${index++}`,
          })),
        ),
      },
    );
  };
  return {
    async open(
      command: string,
      chatId: number,
      userId: number,
      privateChat: boolean,
    ): Promise<boolean> {
      const matches = (await options.endpoints()).filter(
        (endpoint) => endpoint.command === command,
      );
      if (matches.length === 0) return false;
      if (!privateChat || !options.allowed(userId) || matches.length !== 1)
        return true;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomBytes(16).toString("hex");
      const endpoint = matches[0];
      const result = screenResultSchema.parse(
        await endpoint.call({ type: "open", eventId: `${id}:open` }),
      );
      if (result.type !== "show") return true;
      const state: State = {
        schema: 1,
        plugin: endpoint.plugin,
        fingerprint: endpoint.fingerprint,
        chatId,
        userId,
        expiresAt: now() + TTL,
        revision: 0,
        phase: "ready",
        rich: options.rich(),
        messageId: 0,
        view: result.view,
      };
      // Initial rich sends do not silently switch mode: the receipt must record the actual mode.
      const markdown = state.rich
        ? screenMarkdown(state, id)
        : state.view.markdown;
      let index = 0;
      state.messageId = await deliverScreenMessage(
        options.call,
        chatId,
        markdown,
        {
          rich: state.rich,
          keyboard: state.view.rows.map((row) =>
            row.map((button) => ({
              text: button.label,
              ...(button.style ? { style: button.style } : {}),
              callback_data: `${PREFIX}${id}:0:${index++}`,
            })),
          ),
        },
      );
      await save(id, state);
      return true;
    },
    async tap(input: {
      data: string;
      chatId?: number;
      messageId?: number;
      userId: number;
      privateChat: boolean;
    }): Promise<string> {
      const callback = parseScreenCallback(input.data);
      if (!callback || !input.privateChat || !options.allowed(input.userId))
        return "Screen unavailable";
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const lock = await acquireFileLock(`${path(callback.id)}.lock`, {
        timeoutMs: 1000,
        staleMs: 120000,
        mode: 0o700,
      });
      if (!lock) return "Screen busy";
      try {
        let state: State;
        try {
          state = stateSchema.parse(
            JSON.parse(await readFile(path(callback.id), "utf8")),
          );
        } catch {
          return "Screen expired";
        }
        if (
          state.chatId !== input.chatId ||
          state.userId !== input.userId ||
          String(state.messageId) !== String(input.messageId) ||
          now() > state.expiresAt
        )
          return "Screen expired";
        const endpoint = (await options.endpoints()).find(
          (item) =>
            item.plugin === state.plugin &&
            item.fingerprint === state.fingerprint,
        );
        if (!endpoint) return "Screen expired";
        if (state.lastCallback === input.data && state.phase !== "busy") {
          await render(callback.id, state);
          return "";
        }
        if (
          state.phase !== "ready" ||
          callback.revision !== state.revision ||
          state.revision >= 999999
        )
          return "Screen expired";
        const selected = state.view.rows.flat()[callback.index];
        if (!selected) return "Screen expired";
        // Persist intent before crossing into plugin code. An uncertain action is not replayed.
        state.phase = "busy";
        state.lastCallback = input.data;
        await save(callback.id, state);
        const result = screenResultSchema.parse(
          await endpoint.call({
            type: "action",
            screen: callback.id,
            revision: state.revision,
            actionId: selected.id,
            eventId: `${callback.id}:${state.revision}:${callback.index}`,
          }),
        );
        state.revision += 1;
        state.phase = result.type === "close" ? "closed" : "ready";
        state.view =
          result.type === "show"
            ? result.view
            : { markdown: result.markdown, rows: [] };
        await save(callback.id, state);
        await render(callback.id, state);
        return "";
      } finally {
        releaseFileLock(lock);
      }
    },
  };
}
