import type { ModelProvider } from "./model-catalog.mjs";
import type { ModelSelection } from "./model-config-transaction.mjs";

export interface WizardView {
  status: "view" | "close" | "invalid" | "expired" | "forbidden";
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

export function parseModelCallback(data: unknown): { sessionId: string; actionId: string } | null;
export class ModelWizard {
  constructor(options: {
    loadEnvironment(): Record<string, string | undefined> | Promise<Record<string, string | undefined>>;
    providerAvailable(provider: ModelProvider, env: Record<string, string | undefined>): boolean | Promise<boolean>;
    applySelection(selection: ModelSelection): unknown | Promise<unknown>;
    inventory?(provider: ModelProvider, role: "text" | "vision", env: Record<string, string | undefined>): string[] | Promise<string[]>;
    now?: () => number;
    randomId?: () => string;
    ttlMs?: number;
  });
  open(kind: "model" | "think", actor: { userId: string | number; chatId: string | number }): Promise<WizardView>;
  handle(data: unknown, actor: { userId: string | number; chatId: string | number }): Promise<WizardView>;
}
