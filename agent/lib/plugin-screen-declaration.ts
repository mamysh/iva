import { z } from "zod";

export const screenDeclarationSchema = z
  .object({
    command: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
    server: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
    tool: z.string().regex(/^[A-Za-z0-9_]{1,80}$/u),
  })
  .strict();

export const screenEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("open"), eventId: z.string().min(1).max(128) })
    .strict(),
  z
    .object({
      type: z.literal("action"),
      eventId: z.string().min(1).max(128),
      screen: z.string().regex(/^[a-f0-9]{32}$/u),
      revision: z.number().int().min(0).max(999999),
      actionId: z.string().min(1).max(128),
    })
    .strict(),
]);

export function readScreenDeclaration(
  extensions: Readonly<Record<string, unknown>>,
) {
  const namespace = extensions["sh.iva"];
  const raw: unknown =
    namespace && typeof namespace === "object" && !Array.isArray(namespace)
      ? Reflect.get(namespace, "telegramScreen")
      : undefined;
  return raw === undefined ? null : screenDeclarationSchema.safeParse(raw);
}
