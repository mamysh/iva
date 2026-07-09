import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  DEFAULT_TIMEZONE,
  createReminder,
  formatReminder,
  loadReminders,
  saveReminders,
  type Reminder,
} from "../../scripts/lib/reminders-store.mjs";

const prioritySchema = z.enum(["low", "med", "high"]);
const repeatSchema = z.enum(["none", "daily", "weekly", "monthly"]);

function visible(reminders: Reminder[], includeDone?: boolean): Reminder[] {
  return includeDone ? reminders : reminders.filter((r) => r.status === "pending");
}

export default defineTool({
  description:
    "Reliable user reminders. Always use this tool for requests like 'remind me...'. " +
    "Do not use bash/nohup/sleep/curl/systemd-run/cron for reminders. " +
    "action=add creates a reminder; set text and one of dueAt (ISO), dueAtLocal (YYYY-MM-DDTHH:mm in timezone), or dueInMinutes. " +
    "action=list shows reminders; cancel cancels; done/sent marks delivered; remove deletes. " +
    "Delivery is handled by a short-lived systemd timer outside the workflow.",
  inputSchema: z.object({
    action: z.enum(["add", "list", "cancel", "done", "sent", "remove"]),
    id: z.number().int().positive().optional().describe("Reminder ID for cancel/done/sent/remove"),
    text: z.string().min(1).optional().describe("Reminder text for action=add"),
    dueAt: z.string().optional().describe("Absolute ISO time, preferably with timezone offset or Z"),
    dueAtLocal: z.string().optional().describe("Local time YYYY-MM-DDTHH:mm[:ss], interpreted in timezone"),
    dueInMinutes: z.number().nonnegative().optional().describe("How many minutes from now"),
    timezone: z.string().optional().describe(`IANA timezone, defaults to ${DEFAULT_TIMEZONE}`),
    chatId: z.string().optional().describe("Telegram chat id; usually omit to use the primary chat"),
    userId: z.string().optional().describe("Telegram user id; usually omit"),
    priority: prioritySchema.optional().describe("Priority"),
    repeat: repeatSchema.optional().describe("Repeat frequency"),
    repeatInterval: z.number().int().positive().optional().describe("Repeat interval, e.g. daily + 2 = every 2 days"),
    repeatUntil: z.string().optional().describe("ISO date after which repeat stops"),
    includeDone: z.boolean().optional().describe("For list, include sent/cancelled/failed reminders"),
  }),
  async execute(input) {
    const reminders = await loadReminders();

    switch (input.action) {
      case "add": {
        if (!input.text) return { ok: false, error: "action=add requires text" };
        try {
          const reminder = createReminder(
            {
              text: input.text,
              dueAt: input.dueAt,
              dueAtLocal: input.dueAtLocal,
              dueInMinutes: input.dueInMinutes,
              timezone: input.timezone,
              chatId: input.chatId,
              userId: input.userId,
              priority: input.priority,
              repeat: input.repeat,
              repeatInterval: input.repeatInterval,
              repeatUntil: input.repeatUntil,
            },
            reminders,
          );
          reminders.push(reminder);
          await saveReminders(reminders);
          return { ok: true, reminder, summary: formatReminder(reminder) };
        } catch (error) {
          return { ok: false, error: String((error as Error).message || error) };
        }
      }
      case "list": {
        const items = visible(reminders, input.includeDone);
        return { ok: true, count: items.length, reminders: items, summaries: items.map((r) => formatReminder(r)) };
      }
      case "cancel":
      case "done":
      case "sent":
      case "remove": {
        if (!input.id) return { ok: false, error: `action=${input.action} requires id` };
        const idx = reminders.findIndex((r) => r.id === input.id);
        if (idx === -1) return { ok: false, error: `Reminder ${input.id} not found` };
        if (input.action === "remove") {
          const [removed] = reminders.splice(idx, 1);
          await saveReminders(reminders);
          return { ok: true, removed, total: reminders.length };
        }
        const reminder = reminders[idx];
        reminder.status = input.action === "cancel" ? "cancelled" : "sent";
        reminder.updatedAt = new Date().toISOString();
        if (input.action !== "cancel") reminder.sentAt = reminder.sentAt || reminder.updatedAt;
        await saveReminders(reminders);
        return { ok: true, reminder, summary: formatReminder(reminder) };
      }
    }
  },
});
