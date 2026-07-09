export interface Reminder {
  id: number;
  text: string;
  dueAt: string;
  timezone: string;
  chatId: string | null;
  userId: string | null;
  priority: "low" | "med" | "high";
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

export declare const DATA_DIR: string;
export declare const REMINDERS_FILE: string;
export declare const DEFAULT_TIMEZONE: string;

export declare function loadReminders(file?: string): Promise<Reminder[]>;
export declare function saveReminders(reminders: Reminder[], file?: string): Promise<void>;
export declare function nextReminderId(reminders: Reminder[]): number;
export declare function resolveDueAt(input: {
  dueAt?: string;
  dueAtLocal?: string;
  dueInMinutes?: number;
  dueInSeconds?: number;
  timezone?: string;
}): Date;
export declare function createReminder(input: Partial<Reminder> & {
  text?: string;
  dueAt?: string;
  dueAtLocal?: string;
  dueInMinutes?: number;
  dueInSeconds?: number;
}, existing?: Reminder[]): Reminder;
export declare function formatReminder(reminder: Reminder, options?: { now?: Date; timezone?: string }): string;
export declare function duePending(reminders: Reminder[], now?: Date): Reminder[];
export declare function markDelivered(reminder: Reminder, sentAt?: Date): void;
export declare function markFailedAttempt(reminder: Reminder, error: unknown, maxAttempts?: number): void;
