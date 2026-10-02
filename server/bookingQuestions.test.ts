/**
 * Free consultation question/answer validation — run with:
 *   npx tsx server/bookingQuestions.test.ts
 */
import assert from "node:assert/strict";
import {
  parseBookingQuestions,
  validateAnswers,
  formatBookingAnswer,
} from "./bookingQuestions";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

const options = (n: number) => Array.from({ length: n }, (_, i) => `Option ${i + 1}`);

// ─── parseBookingQuestions ──────────────────────────────────────────────

test("null/undefined questions → []", () => {
  assert.deepEqual(parseBookingQuestions(null), { ok: true, questions: [] });
  assert.deepEqual(parseBookingQuestions(undefined), { ok: true, questions: [] });
});

test("valid questions get server-generated ids; client ids not in the service are replaced", () => {
  const r = parseBookingQuestions([
    { id: "client-chosen", label: "Your goal", type: "text", required: true },
    { label: "Hair type", type: "select", options: ["Straight", "Curly"] },
    { label: "Event date", type: "date" },
    { label: "Where", type: "address" },
    { label: "Details", type: "long_text" },
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.questions.length, 5);
  assert.notEqual(r.questions[0].id, "client-chosen");
  assert.match(r.questions[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(new Set(r.questions.map(q => q.id)).size, 5);
  assert.equal(r.questions[1].required, false, "required defaults to false");
  assert.deepEqual(r.questions[1].options, ["Straight", "Curly"]);
  assert.equal("options" in r.questions[0], false);
});

test("existing ids are kept on edit, duplicates of an existing id are not", () => {
  const first = parseBookingQuestions([{ label: "A", type: "text" }]);
  assert.ok(first.ok);
  if (!first.ok) return;
  const id = first.questions[0].id;
  const second = parseBookingQuestions(
    [{ id, label: "A renamed", type: "text" }, { id, label: "copy", type: "text" }],
    first.questions,
  );
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.questions[0].id, id);
  assert.notEqual(second.questions[1].id, id);
});

test("label: required, max 120", () => {
  assert.equal(parseBookingQuestions([{ label: "", type: "text" }]).ok, false);
  assert.equal(parseBookingQuestions([{ label: "   ", type: "text" }]).ok, false);
  assert.equal(parseBookingQuestions([{ label: "x".repeat(120), type: "text" }]).ok, true);
  assert.equal(parseBookingQuestions([{ label: "x".repeat(121), type: "text" }]).ok, false);
});

test("type must be one of the five", () => {
  assert.equal(parseBookingQuestions([{ label: "A", type: "number" }]).ok, false);
});

test("select options: 2–20, unique; select-only", () => {
  assert.equal(parseBookingQuestions([{ label: "A", type: "select" }]).ok, false);
  assert.equal(parseBookingQuestions([{ label: "A", type: "select", options: options(1) }]).ok, false);
  assert.equal(parseBookingQuestions([{ label: "A", type: "select", options: options(2) }]).ok, true);
  assert.equal(parseBookingQuestions([{ label: "A", type: "select", options: options(20) }]).ok, true);
  assert.equal(parseBookingQuestions([{ label: "A", type: "select", options: options(21) }]).ok, false);
  assert.equal(parseBookingQuestions([{ label: "A", type: "select", options: ["x", "x"] }]).ok, false);
  assert.equal(parseBookingQuestions([{ label: "A", type: "text", options: options(2) }]).ok, false);
});

test("max 10 questions", () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ label: `Q${i}`, type: "text" }));
  assert.equal(parseBookingQuestions(ten).ok, true);
  assert.equal(parseBookingQuestions([...ten, { label: "Q10", type: "text" }]).ok, false);
});

test("unknown question keys and non-array input rejected", () => {
  assert.equal(parseBookingQuestions([{ label: "A", type: "text", foo: 1 }]).ok, false);
  assert.equal(parseBookingQuestions({ label: "A" }).ok, false);
});

// ─── validateAnswers ─────────────────────────────────────────────────────────

const parsed = parseBookingQuestions([
  { label: "Goal", type: "text", required: true },
  { label: "History", type: "long_text" },
  { label: "Length", type: "select", options: ["Short", "Long"], required: true },
  { label: "Event date", type: "date" },
  { label: "Address", type: "address" },
]);
if (!parsed.ok) throw new Error("fixture questions invalid");
const [qText, qLong, qSelect, qDate, qAddr] = parsed.questions;
const address = { line1: "1 Main St", city: "Albany", state: "NY", zipCode: "12207" };

test("happy path returns a snapshot in question order with labels and types", () => {
  const r = validateAnswers(parsed.questions, [
    { questionId: qAddr.id, answer: address },
    { questionId: qSelect.id, answer: "Long" },
    { questionId: qText.id, answer: "  Volume  " },
    { questionId: qDate.id, answer: "2026-12-31" },
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.snapshot, [
    { questionId: qText.id, label: "Goal", type: "text", answer: "Volume" },
    { questionId: qLong.id, label: "History", type: "long_text", answer: null },
    { questionId: qSelect.id, label: "Length", type: "select", answer: "Long" },
    { questionId: qDate.id, label: "Event date", type: "date", answer: "2026-12-31" },
    { questionId: qAddr.id, label: "Address", type: "address", answer: address },
  ]);
});

test("no questions + no answers → empty snapshot", () => {
  assert.deepEqual(validateAnswers([], undefined), { ok: true, snapshot: [] });
  assert.deepEqual(validateAnswers(null, null), { ok: true, snapshot: [] });
});

test("required missing / blank rejected", () => {
  const r = validateAnswers(parsed.questions, [{ questionId: qSelect.id, answer: "Short" }, { questionId: qText.id, answer: "  " }]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.errors.map(e => e.questionId), [qText.id]);
});

test("unknown and duplicate question ids rejected", () => {
  const base = [{ questionId: qText.id, answer: "x" }, { questionId: qSelect.id, answer: "Short" }];
  const unknown = validateAnswers(parsed.questions, [...base, { questionId: "nope", answer: "x" }]);
  assert.equal(unknown.ok, false);
  const dup = validateAnswers(parsed.questions, [...base, { questionId: qText.id, answer: "y" }]);
  assert.equal(dup.ok, false);
  assert.equal(validateAnswers(parsed.questions, { [qText.id]: "x" }).ok, false, "object form rejected");
  assert.equal(validateAnswers(parsed.questions, [...base, "junk"]).ok, false);
});

test("select answer must be one of the options", () => {
  const r = validateAnswers(parsed.questions, [{ questionId: qText.id, answer: "x" }, { questionId: qSelect.id, answer: "Medium" }]);
  assert.equal(r.ok, false);
});

test("date must be a real YYYY-MM-DD date", () => {
  const ok = (d: unknown) => validateAnswers(parsed.questions, [
    { questionId: qText.id, answer: "x" }, { questionId: qSelect.id, answer: "Short" }, { questionId: qDate.id, answer: d },
  ]).ok;
  assert.equal(ok("2028-02-29"), true);
  assert.equal(ok("2027-02-29"), false);
  assert.equal(ok("2026-13-01"), false);
  assert.equal(ok("12/31/2026"), false);
  assert.equal(ok("2026-12-31T00:00:00Z"), false);
});

test("address needs line1, city, state, zipCode; no extra fields", () => {
  const ok = (a: unknown) => validateAnswers(parsed.questions, [
    { questionId: qText.id, answer: "x" }, { questionId: qSelect.id, answer: "Short" }, { questionId: qAddr.id, answer: a },
  ]).ok;
  assert.equal(ok(address), true);
  assert.equal(ok({ ...address, line2: "Apt 2" }), true);
  assert.equal(ok({ ...address, city: "" }), false);
  const { zipCode, ...noZip } = address;
  assert.equal(ok(noZip), false);
  assert.equal(ok({ ...address, country: "US" }), false);
  assert.equal(ok("1 Main St"), false);
});

test("text capped at 500, long_text at 2000", () => {
  const base = [{ questionId: qSelect.id, answer: "Short" }];
  assert.equal(validateAnswers(parsed.questions, [...base, { questionId: qText.id, answer: "x".repeat(500) }]).ok, true);
  assert.equal(validateAnswers(parsed.questions, [...base, { questionId: qText.id, answer: "x".repeat(501) }]).ok, false);
  const withText = [...base, { questionId: qText.id, answer: "x" }];
  assert.equal(validateAnswers(parsed.questions, [...withText, { questionId: qLong.id, answer: "x".repeat(2000) }]).ok, true);
  assert.equal(validateAnswers(parsed.questions, [...withText, { questionId: qLong.id, answer: "x".repeat(2001) }]).ok, false);
  assert.equal(validateAnswers(parsed.questions, [...base, { questionId: qText.id, answer: 42 }]).ok, false);
});

test("formatBookingAnswer", () => {
  assert.equal(formatBookingAnswer(null), "—");
  assert.equal(formatBookingAnswer("hi"), "hi");
  assert.equal(formatBookingAnswer({ ...address, line2: "Apt 2" }), "1 Main St, Apt 2, Albany, NY 12207");
});

console.log(`\n${passed} passed`);
