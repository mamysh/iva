export const CORE_CAP: number;
export function coreRecoveryAction(before: string | null | undefined, after: string | null | undefined, cap?: number): "accept" | "restore" | "fail";
export function gitPushFailureAlert(output: unknown, vault: string): string;
