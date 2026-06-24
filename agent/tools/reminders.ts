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
    "Надёжные напоминания пользователя. Всегда используй этот инструмент для просьб «напомни…». " +
    "НЕ используй nohup/sleep/curl/systemd-run для напоминаний. " +
    "action=add создаёт напоминание; укажи text и одно из dueAt (ISO с timezone/Z), dueAtLocal (YYYY-MM-DDTHH:mm в timezone) или dueInMinutes. " +
    "action=list показывает активные; cancel отменяет; done/sent помечает выполненным; remove удаляет. " +
    "Срабатывание делает отдельный systemd timer, без участия workflow.",
  inputSchema: z.object({
    action: z.enum(["add", "list", "cancel", "done", "sent", "remove"]),
    id: z.number().int().positive().optional().describe("ID напоминания для cancel/done/sent/remove"),
    text: z.string().min(1).optional().describe("Текст напоминания для action=add"),
    dueAt: z.string().optional().describe("Абсолютное время ISO, лучше с timezone offset или Z"),
    dueAtLocal: z.string().optional().describe("Локальное время YYYY-MM-DDTHH:mm[:ss], трактуется в timezone"),
    dueInMinutes: z.number().nonnegative().optional().describe("Через сколько минут напомнить"),
    timezone: z.string().optional().describe(`Timezone, по умолчанию ${DEFAULT_TIMEZONE}`),
    chatId: z.string().optional().describe("Telegram chat id; обычно не указывать — возьмётся основной чат"),
    userId: z.string().optional().describe("Telegram user id; обычно не указывать"),
    priority: prioritySchema.optional().describe("Приоритет"),
    repeat: repeatSchema.optional().describe("Повтор: none/daily/weekly/monthly"),
    repeatInterval: z.number().int().positive().optional().describe("Интервал повтора, например daily + 2 = раз в 2 дня"),
    repeatUntil: z.string().optional().describe("ISO-дата, после которой повтор остановится"),
    includeDone: z.boolean().optional().describe("Для list показать sent/cancelled/failed тоже"),
  }),
  async execute(input) {
    const reminders = await loadReminders();

    switch (input.action) {
      case "add": {
        if (!input.text) return { ok: false, error: "Для add нужен text" };
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
        return {
          ok: true,
          count: items.length,
          reminders: items,
          summaries: items.map((r) => formatReminder(r)),
        };
      }
      case "cancel":
      case "done":
      case "sent":
      case "remove": {
        if (!input.id) return { ok: false, error: `Для ${input.action} нужен id` };
        const idx = reminders.findIndex((r) => r.id === input.id);
        if (idx === -1) return { ok: false, error: `Напоминание ${input.id} не найдено` };
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
