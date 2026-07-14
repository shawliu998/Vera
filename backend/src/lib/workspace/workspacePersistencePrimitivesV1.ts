import { z } from "zod";

export const WORKSPACE_PERSISTENCE_PRIMITIVES_V1_MANIFEST = {
  version: "workspace-persistence-primitives-v1",
  uuid: {
    format: "zod.uuid",
  },
  isoDateTime: {
    format: "zod.datetime",
    offset: true,
  },
  stringLength: {
    unit: "unicode_code_points",
    rejectUnpairedSurrogates: true,
    rejectNul: true,
  },
  structuredError: {
    code: { min: 1, max: 120 },
    message: { min: 1, max: 2000 },
    retryable: "boolean",
    details: {
      nullable: true,
      valueTypes: ["string", "finite_number", "boolean", "null"],
      stringMax: 2000,
      blockedKeyRegex:
        "(?:secret|password|credential|private[_-]?key|api[_-]?key|token|authorization|cookie|(?:^|[_-])path(?:$|[_-])|storage[_-]?path|absolute[_-]?path|file[_-]?path|user[_-]?id|client[_-]?id)",
      blockedKeyRegexFlags: "i",
    },
  },
} as const;

export const BLOCKED_STRUCTURED_KEYS_V1 = new RegExp(
  WORKSPACE_PERSISTENCE_PRIMITIVES_V1_MANIFEST.structuredError.details
    .blockedKeyRegex,
  WORKSPACE_PERSISTENCE_PRIMITIVES_V1_MANIFEST.structuredError.details
    .blockedKeyRegexFlags,
);

export const WorkspaceIdSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const NullableWorkspaceIdSchema = WorkspaceIdSchema.nullable();

export function unicodeCodePointLengthV1(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      throw new Error("string contains a NUL code point");
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new Error("string contains an unpaired surrogate");
      }
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("string contains an unpaired surrogate");
      }
      index += 1;
      count += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("string contains an unpaired surrogate");
    }
    count += 1;
  }
  return count;
}

export function hasUnpairedSurrogateV1(value: string): boolean {
  try {
    unicodeCodePointLengthV1(value);
    return false;
  } catch {
    return true;
  }
}

export function UnicodeCodePointStringSchemaV1(input: {
  min?: number;
  max: number;
  trimForMin?: boolean;
}) {
  return z.string().superRefine((value, context) => {
    if (value.includes("\0")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "string must not contain NUL code points",
      });
      return;
    }
    let length: number;
    try {
      length = unicodeCodePointLengthV1(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "string must not contain unpaired surrogate code units",
      });
      return;
    }
    if (length > input.max) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: input.max,
        inclusive: true,
        message: `string must contain at most ${input.max} Unicode code points`,
      });
    }
    const min = input.min ?? 0;
    if (min > 0) {
      const minValue = input.trimForMin ? value.trim() : value;
      let minLength: number;
      try {
        minLength = unicodeCodePointLengthV1(minValue);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "string must not contain unpaired surrogate code units",
        });
        return;
      }
      if (minLength < min) {
        context.addIssue({
          code: z.ZodIssueCode.too_small,
          type: "string",
          minimum: min,
          inclusive: true,
          message: `string must contain at least ${min} Unicode code points`,
        });
      }
    }
  });
}

export const StructuredErrorSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(2_000),
    retryable: z.boolean(),
    details: z
      .record(
        z.union([
          z.string().max(2_000),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .superRefine((value, context) => {
        for (const key of Object.keys(value)) {
          if (BLOCKED_STRUCTURED_KEYS_V1.test(key)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "unsafe error detail key is not allowed",
            });
          }
        }
      })
      .nullable(),
  })
  .strict();

export type StructuredErrorV1 = z.infer<typeof StructuredErrorSchema>;
