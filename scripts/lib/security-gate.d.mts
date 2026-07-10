export interface InboundSecurityResult {
  text: string;
  blocked: boolean;
  flags: string[];
  reason: string;
}

export interface OutboundSecurityResult {
  text: string;
  clean: boolean;
  findings: string[];
}

export function sanitizeInbound(input: unknown, maxChars?: number): InboundSecurityResult;
export function scanOutbound(input: unknown): OutboundSecurityResult;
