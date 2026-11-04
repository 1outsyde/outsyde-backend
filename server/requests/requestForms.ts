/**
 * Request forms (Quotes in Messages, step 1). Pure rules: no database, no network.
 *
 * Legend 2026-11-03 / 2026-11-04:
 *   - Each business has a form library: one base form plus any number of saved forms.
 *   - Each request only service uses a saved form, OR the base form plus its own extra questions, OR only
 *     its own questions (a brand new form the client can also save to the library as a saved form).
 *   - Question types: short text, long text, choice (single or multiple pick), date, photos.
 *   - Limits: 25 questions per form, 5 photos per photo question, 10 photos per request.
 *
 * A request keeps its own copy of each question's label and type next to the answer, so editing a form later
 * never changes what an old request says.
 */
import { randomBytes } from "crypto";

export const REQUEST_QUESTION_TYPES = ["short_text", "long_text", "choice", "date", "photos"] as const;
export type RequestQuestionType = typeof REQUEST_QUESTION_TYPES[number];

export const REQUEST_FORM_MAX_QUESTIONS = 25;
export const REQUEST_MAX_PHOTOS_PER_QUESTION = 5;
export const REQUEST_MAX_PHOTOS_TOTAL = 10;
const MAX_LABEL = 200;
const MAX_HELP = 300;
const MAX_OPTIONS = 20;
const MAX_OPTION = 100;
const MAX_SHORT = 200;
const MAX_LONG = 2000;
const ID_RE = /^[a-z0-9]{1,16}$/;
const PHOTO_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpeg|jpg|png|webp|heic|heif|gif)$/i;

export interface RequestQuestion {
  id: string;
  type: RequestQuestionType;
  label: string;
  help?: string;
  required: boolean;
  /** choice only */
  options?: string[];
  /** choice only: true = the customer may pick several */
  multiple?: boolean;
  /** photos only: 1 to REQUEST_MAX_PHOTOS_PER_QUESTION */
  maxPhotos?: number;
}

export interface SavedAnswer {
  questionId: string;
  label: string;
  type: RequestQuestionType;
  value: string | string[];
}

type Fail = { ok: false; message: string; field?: string };

function newId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(6).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 8);
    if (id.length === 8 && !taken.has(id)) return id;
  }
}

/** Checks and cleans a form's questions as a business saves them. */
export function normalizeQuestions(input: unknown): { ok: true; questions: RequestQuestion[] } | Fail {
  if (!Array.isArray(input)) return { ok: false, message: "Questions must be a list" };
  if (input.length > REQUEST_FORM_MAX_QUESTIONS) {
    return { ok: false, message: `A form can have up to ${REQUEST_FORM_MAX_QUESTIONS} questions` };
  }
  const taken = new Set<string>();
  const out: RequestQuestion[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i] as Record<string, unknown> | null;
    const where = `Question ${i + 1}`;
    if (!raw || typeof raw !== "object") return { ok: false, message: `${where} is not valid` };
    const type = raw.type as RequestQuestionType;
    if (!(REQUEST_QUESTION_TYPES as readonly string[]).includes(type as string)) {
      return { ok: false, message: `${where} has an unknown type` };
    }
    const label = typeof raw.label === "string" ? raw.label.trim().replace(/\s+/g, " ") : "";
    if (!label) return { ok: false, message: `${where} needs a question` };
    if (label.length > MAX_LABEL) return { ok: false, message: `${where} is longer than ${MAX_LABEL} characters` };
    const help = typeof raw.help === "string" ? raw.help.trim() : "";
    if (help.length > MAX_HELP) return { ok: false, message: `${where} help text is longer than ${MAX_HELP} characters` };

    let id = typeof raw.id === "string" && ID_RE.test(raw.id) && !taken.has(raw.id) ? raw.id : "";
    if (!id) id = newId(taken);
    taken.add(id);

    const q: RequestQuestion = { id, type, label, required: raw.required === true };
    if (help) q.help = help;

    if (type === "choice") {
      const opts = Array.isArray(raw.options) ? raw.options : [];
      const clean: string[] = [];
      for (const o of opts) {
        if (typeof o !== "string") return { ok: false, message: `${where} has an option that is not text` };
        const v = o.trim().replace(/\s+/g, " ");
        if (!v) continue;
        if (v.length > MAX_OPTION) return { ok: false, message: `${where} has an option longer than ${MAX_OPTION} characters` };
        if (!clean.includes(v)) clean.push(v);
      }
      if (clean.length < 2) return { ok: false, message: `${where} needs at least two choices` };
      if (clean.length > MAX_OPTIONS) return { ok: false, message: `${where} can have up to ${MAX_OPTIONS} choices` };
      q.options = clean;
      q.multiple = raw.multiple === true;
    }
    if (type === "photos") {
      const max = raw.maxPhotos === undefined || raw.maxPhotos === null ? REQUEST_MAX_PHOTOS_PER_QUESTION : raw.maxPhotos;
      if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > REQUEST_MAX_PHOTOS_PER_QUESTION) {
        return { ok: false, message: `${where} can ask for 1 to ${REQUEST_MAX_PHOTOS_PER_QUESTION} photos` };
      }
      q.maxPhotos = max;
    }
    out.push(q);
  }
  const limits = checkResolvedLimits(out);
  if (!limits.ok) return limits;
  return { ok: true, questions: out };
}

/**
 * The limits apply to what the customer actually answers, so they are checked on the combined form too
 * (base form plus a service's own questions): at most 25 questions, and required photo questions can't
 * need more photos than one request can hold (each needs at least one).
 */
export function checkResolvedLimits(questions: RequestQuestion[]): { ok: true } | Fail {
  if (questions.length > REQUEST_FORM_MAX_QUESTIONS) {
    return { ok: false, message: `A form can have up to ${REQUEST_FORM_MAX_QUESTIONS} questions, counting the base form` };
  }
  const requiredPhotos = questions.filter((q) => q.type === "photos" && q.required).length;
  if (requiredPhotos > REQUEST_MAX_PHOTOS_TOTAL) {
    return { ok: false, message: `A form can require at most ${REQUEST_MAX_PHOTOS_TOTAL} photo questions, because a request holds up to ${REQUEST_MAX_PHOTOS_TOTAL} photos` };
  }
  return { ok: true };
}

/**
 * The questions a customer answers for one service. Ids are prefixed by where the question comes from
 * (f_ saved form, b_ base form, s_ the service's own), so the same id in two places can never collide.
 */
export function resolveServiceForm(input: {
  savedForm: RequestQuestion[] | null;
  base: RequestQuestion[] | null;
  useBase: boolean;
  own: RequestQuestion[];
}): RequestQuestion[] {
  const tag = (p: string, list: RequestQuestion[]) => list.map((q) => ({ ...q, id: `${p}_${q.id}` }));
  if (input.savedForm) return tag("f", input.savedForm);
  return [...(input.useBase && input.base ? tag("b", input.base) : []), ...tag("s", input.own ?? [])];
}

function isRealDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Checks a customer's answers against the resolved questions and returns the copy to save. */
export function checkAnswers(
  questions: RequestQuestion[],
  input: unknown,
  r2PublicUrl: string | undefined,
): { ok: true; answers: SavedAnswer[]; photoCount: number } | Fail {
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "Answers are not valid" };
  const given = input as Record<string, unknown>;
  const prefixes = r2PublicUrl
    ? Array.from(new Set([`${r2PublicUrl}/requests/`, `${r2PublicUrl.replace(/\/+$/, "")}/requests/`]))
    : [];
  const isUpload = (u: unknown) =>
    typeof u === "string" && u.length <= 2048 && prefixes.some((p) => u.startsWith(p) && PHOTO_NAME.test(u.slice(p.length)));

  const answers: SavedAnswer[] = [];
  let photoCount = 0;
  for (const q of questions) {
    const raw = given[q.id];
    const fail = (message: string): Fail => ({ ok: false, message, field: q.id });
    const save = (value: string | string[]) => answers.push({ questionId: q.id, label: q.label, type: q.type, value });

    if (q.type === "short_text" || q.type === "long_text" || q.type === "date") {
      if (raw !== undefined && raw !== null && typeof raw !== "string") return fail(`"${q.label}" must be text`);
      const v = typeof raw === "string" ? raw.trim() : "";
      if (!v) {
        if (q.required) return fail(`Please answer "${q.label}"`);
        continue;
      }
      if (q.type === "date") {
        if (!isRealDate(v)) return fail(`"${q.label}" must be a date`);
      } else {
        const max = q.type === "short_text" ? MAX_SHORT : MAX_LONG;
        if (v.length > max) return fail(`"${q.label}" can be up to ${max} characters`);
      }
      save(v);
      continue;
    }

    if (q.type === "choice") {
      const opts = q.options ?? [];
      if (q.multiple) {
        if (raw !== undefined && raw !== null && !Array.isArray(raw)) return fail(`"${q.label}" must be a list of choices`);
        const list = (Array.isArray(raw) ? raw : []) as unknown[];
        if (list.some((v) => typeof v !== "string" || !opts.includes(v))) return fail(`Please pick from the choices for "${q.label}"`);
        if (new Set(list).size !== list.length) return fail(`"${q.label}" has the same choice twice`);
        if (list.length === 0) {
          if (q.required) return fail(`Please answer "${q.label}"`);
          continue;
        }
        save(list as string[]);
      } else {
        if (raw === undefined || raw === null || raw === "") {
          if (q.required) return fail(`Please answer "${q.label}"`);
          continue;
        }
        if (typeof raw !== "string" || !opts.includes(raw)) return fail(`Please pick one of the choices for "${q.label}"`);
        save(raw);
      }
      continue;
    }

    // photos
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) return fail(`"${q.label}" must be a list of photos`);
    const urls = (Array.isArray(raw) ? raw : []) as unknown[];
    if (urls.length === 0) {
      if (q.required) return fail(`Please add a photo for "${q.label}"`);
      continue;
    }
    if (urls.length > (q.maxPhotos ?? REQUEST_MAX_PHOTOS_PER_QUESTION)) return fail(`"${q.label}" takes up to ${q.maxPhotos} photos`);
    if (!urls.every(isUpload)) return fail("Photos must be uploaded through Outsyde");
    photoCount += urls.length;
    save(urls as string[]);
  }
  if (photoCount > REQUEST_MAX_PHOTOS_TOTAL) {
    return { ok: false, message: `A request can have up to ${REQUEST_MAX_PHOTOS_TOTAL} photos` };
  }
  return { ok: true, answers, photoCount };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The text of the request card message. Older app builds show only this text, with no card, so it reads on
 * its own and does not point anywhere: the business also gets every detail by email and in its requests list.
 */
export function requestMessageText(input: { serviceName: string | null; preferredDate: string | null }): string {
  const name = (input.serviceName ?? "").trim();
  let when = "";
  const d = (input.preferredDate ?? "").trim();
  if (isRealDate(d)) {
    const [y, m, day] = d.split("-").map(Number);
    when = ` (${MONTHS[m - 1]} ${day}, ${y})`;
  }
  return name ? `Sent a request for ${name}${when}.` : "Sent a request.";
}
