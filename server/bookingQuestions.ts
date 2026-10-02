/**
 * Booking intake questions (vendor_services.booking_questions) and the
 * customer's answers (appointments.booking_answers). Generic by design; for
 * now the routes only accept questions on free consultation services.
 *
 * Question ids are server-generated. On edit, an incoming id is kept only when
 * it already belongs to the service, so a client cannot choose its own ids.
 * Answers are stored as a snapshot (label and type copied), so later edits to
 * the questions never change what a booking recorded.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  BookingAddressAnswer,
  BookingAnswer,
  BookingQuestion,
} from "@shared/schema";

export const BOOKING_QUESTION_TYPES = ['text', 'long_text', 'select', 'date', 'address'] as const;
export const MAX_BOOKING_QUESTIONS = 10;
export const MAX_QUESTION_LABEL_LENGTH = 120;
export const MIN_SELECT_OPTIONS = 2;
export const MAX_SELECT_OPTIONS = 20;
export const MAX_TEXT_ANSWER_LENGTH = 500;
export const MAX_LONG_TEXT_ANSWER_LENGTH = 2000;
const MAX_OPTION_LENGTH = 120;
const MAX_ADDRESS_FIELD_LENGTH = 200;

const questionInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().trim().min(1, "Question label is required").max(MAX_QUESTION_LABEL_LENGTH),
  type: z.enum(BOOKING_QUESTION_TYPES),
  required: z.boolean().optional().default(false),
  options: z.array(z.string().trim().min(1).max(MAX_OPTION_LENGTH)).optional(),
}).strict().superRefine((q, ctx) => {
  if (q.type === 'select') {
    const count = q.options?.length ?? 0;
    if (count < MIN_SELECT_OPTIONS || count > MAX_SELECT_OPTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: `Select questions need ${MIN_SELECT_OPTIONS}-${MAX_SELECT_OPTIONS} options`,
      });
    } else if (new Set(q.options).size !== count) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: "Select options must be unique" });
    }
  } else if (q.options !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: "Only select questions take options" });
  }
});

export const bookingQuestionsInputSchema = z.array(questionInputSchema)
  .max(MAX_BOOKING_QUESTIONS, `At most ${MAX_BOOKING_QUESTIONS} questions`);

export type ParseQuestionsResult =
  | { ok: true; questions: BookingQuestion[] }
  | { ok: false; message: string; details: z.ZodIssue[] };

/**
 * Validate vendor-supplied questions and assign ids. null/undefined → [].
 * `existing` is the service's current questions: their ids may be reused.
 */
export function parseBookingQuestions(
  input: unknown,
  existing: BookingQuestion[] | null | undefined = [],
): ParseQuestionsResult {
  const parsed = bookingQuestionsInputSchema.safeParse(input ?? []);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid booking questions", details: parsed.error.issues };
  }
  const existingIds = new Set((existing ?? []).map(q => q.id));
  const usedIds = new Set<string>();
  const questions = parsed.data.map((q): BookingQuestion => {
    const id = q.id && existingIds.has(q.id) && !usedIds.has(q.id) ? q.id : randomUUID();
    usedIds.add(id);
    return {
      id,
      label: q.label,
      type: q.type,
      required: q.required,
      ...(q.type === 'select' ? { options: q.options } : {}),
    };
  });
  return { ok: true, questions };
}

export interface AnswerError {
  questionId?: string;
  message: string;
}

export type ValidateAnswersResult =
  | { ok: true; snapshot: BookingAnswer[] }
  | { ok: false; errors: AnswerError[] };

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function checkAddress(value: unknown): { ok: true; value: BookingAddressAnswer } | { ok: false; message: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, message: "Address must be an object with line1, city, state and zipCode" };
  }
  const v = value as Record<string, unknown>;
  const allowed = new Set(['line1', 'line2', 'city', 'state', 'zipCode']);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) return { ok: false, message: `Unknown address field: ${key}` };
  }
  const out: Record<string, string> = {};
  for (const key of ['line1', 'city', 'state', 'zipCode']) {
    const field = v[key];
    if (typeof field !== 'string' || field.trim() === '') {
      return { ok: false, message: `Address ${key} is required` };
    }
    if (field.trim().length > MAX_ADDRESS_FIELD_LENGTH) {
      return { ok: false, message: `Address ${key} is too long` };
    }
    out[key] = field.trim();
  }
  if (v.line2 !== undefined && v.line2 !== null) {
    if (typeof v.line2 !== 'string' || v.line2.trim().length > MAX_ADDRESS_FIELD_LENGTH) {
      return { ok: false, message: "Address line2 is invalid" };
    }
    if (v.line2.trim() !== '') out.line2 = v.line2.trim();
  }
  return { ok: true, value: out as unknown as BookingAddressAnswer };
}

/**
 * Validate the customer's answers against the service's questions.
 *
 * `answers` is an array of { questionId, answer } (null/undefined → []).
 * Rules: every required question answered; unknown or duplicate question ids
 * rejected; select answers must be one of the options; dates are real
 * YYYY-MM-DD dates; addresses carry line1, city, state, zipCode; text answers
 * are capped at 500 chars, long_text at 2000.
 *
 * Returns a snapshot in question order. Unanswered optional questions are
 * kept with answer null.
 */
export function validateAnswers(
  questions: BookingQuestion[] | null | undefined,
  answers: unknown,
): ValidateAnswersResult {
  const qs = questions ?? [];
  const errors: AnswerError[] = [];
  const input = answers ?? [];

  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ message: "answers must be an array of { questionId, answer }" }] };
  }

  const byId = new Map(qs.map(q => [q.id, q]));
  const given = new Map<string, unknown>();
  for (const item of input) {
    if (typeof item !== 'object' || item === null || typeof (item as any).questionId !== 'string') {
      errors.push({ message: "Each answer needs a questionId" });
      continue;
    }
    const { questionId, answer } = item as { questionId: string; answer: unknown };
    if (!byId.has(questionId)) {
      errors.push({ questionId, message: "Unknown question" });
      continue;
    }
    if (given.has(questionId)) {
      errors.push({ questionId, message: "Question answered more than once" });
      continue;
    }
    given.set(questionId, answer);
  }

  const snapshot: BookingAnswer[] = [];
  for (const q of qs) {
    const raw = given.get(q.id);
    if (isBlank(raw)) {
      if (q.required) errors.push({ questionId: q.id, message: `"${q.label}" is required` });
      snapshot.push({ questionId: q.id, label: q.label, type: q.type, answer: null });
      continue;
    }

    let value: BookingAnswer['answer'] = null;
    switch (q.type) {
      case 'text':
      case 'long_text': {
        const cap = q.type === 'text' ? MAX_TEXT_ANSWER_LENGTH : MAX_LONG_TEXT_ANSWER_LENGTH;
        if (typeof raw !== 'string') {
          errors.push({ questionId: q.id, message: `"${q.label}" must be text` });
        } else if (raw.trim().length > cap) {
          errors.push({ questionId: q.id, message: `"${q.label}" must be at most ${cap} characters` });
        } else {
          value = raw.trim();
        }
        break;
      }
      case 'select': {
        if (typeof raw !== 'string' || !(q.options ?? []).includes(raw)) {
          errors.push({ questionId: q.id, message: `"${q.label}" must be one of the listed options` });
        } else {
          value = raw;
        }
        break;
      }
      case 'date': {
        if (typeof raw !== 'string' || !isValidIsoDate(raw)) {
          errors.push({ questionId: q.id, message: `"${q.label}" must be a date (YYYY-MM-DD)` });
        } else {
          value = raw;
        }
        break;
      }
      case 'address': {
        const check = checkAddress(raw);
        if (!check.ok) {
          errors.push({ questionId: q.id, message: `"${q.label}": ${check.message}` });
        } else {
          value = check.value;
        }
        break;
      }
    }
    snapshot.push({ questionId: q.id, label: q.label, type: q.type, answer: value });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, snapshot };
}

/** One-line text for an answer (emails). */
export function formatBookingAnswer(answer: BookingAnswer['answer']): string {
  if (answer === null || answer === undefined) return '—';
  if (typeof answer === 'string') return answer;
  const parts = [answer.line1, answer.line2, answer.city, `${answer.state} ${answer.zipCode}`].filter(Boolean);
  return parts.join(', ');
}

/** 400 body for invalid booking questions on service create/edit. */
export const invalidQuestionsBody = (message: string, details: unknown = undefined) =>
  ({ error: message, message, code: "INVALID_BOOKING_QUESTIONS", ...(details ? { details } : {}) });

/** True when a request body carries booking questions (non-empty). */
export function hasBookingQuestions(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}
