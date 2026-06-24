export interface Reminder {
  id: number;
  text: string;
  dueAt: string;
  timezone: string;
  chatId: string | null;
  userId: string | null;
  priority: "low" | "med" | "high" | string;
  repeat: "none" | "daily" | "weekly" | "monthly";
  repeatInterval: number;
  repeatUntil: string | null;
  status: "pending" | "sent" | "cancelled" | "failed";
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  lastSentAt: string | null;
  sentCount: number;
  attempts: number;
  lastError: string | null;
}

export const DATA_DIR: string;
export const REMINDERS_FILE: string;
export const DEFAULT_TIMEZONE: string;

export function loadReminders(file?: string): Promise<Reminder[]>;
export function saveReminders(reminders: Reminder[], file?: string): Promise<void>;
export function nextReminderId(reminders: Reminder[]): number;
export function resolveDueAt(input: {
  dueAt?: string | null;
  dueAtLocal?: string | null;
  dueInMinutes?: number | null;
  dueInSeconds?: number | null;
  timezone?: string;
}): Date;
export function createReminder(
  input: {
    text: string;
    dueAt?: string | null;
    dueAtLocal?: string | null;
    dueInMinutes?: number | null;
    dueInSeconds?: number | null;
    timezone?: string;
    chatId?: string | number | null;
    userId?: string | number | null;
    priority?: "low" | "med" | "high";
    repeat?: "none" | "daily" | "weekly" | "monthly";
    repeatInterval?: number | null;
    repeatUntil?: string | null;
  },
  existing?: Reminder[],
): Reminder;
export function formatReminder(reminder: Reminder, opts?: { now?: Date; timezone?: string }): string;
export function duePending(reminders: Reminder[], now?: Date): Reminder[];
export function markDelivered(reminder: Reminder, sentAt?: Date): void;
export function markFailedAttempt(reminder: Reminder, error: unknown, maxAttempts?: number): void;
