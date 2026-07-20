export type TelegramDeliveryFailureStage = "rich-rejected" | "rich-failed" | "html-failed" | "plain-failed";

export interface TelegramDeliveryResult {
  transport: "rich" | "html" | "plain";
  messages: number;
  fellBack: boolean;
}

export function deliverTelegramMarkdown(options: {
  markdown: string;
  sendRich: (markdown: string) => Promise<{ ok?: boolean } | null | undefined>;
  sendHtml: (html: string) => Promise<unknown>;
  sendPlain: (plain: string) => Promise<unknown>;
  onFailure?: (stage: TelegramDeliveryFailureStage, error: unknown) => void;
  htmlLimit?: number;
}): Promise<TelegramDeliveryResult>;
