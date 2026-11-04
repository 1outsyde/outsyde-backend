/**
 * Pure tests for request forms (Quotes step 1). No database, no network.
 * Run with: npx tsx server/requests/requestForms.test.ts
 */
import {
  normalizeQuestions,
  resolveServiceForm,
  checkAnswers,
  checkResolvedLimits,
  requestMessageText,
  REQUEST_FORM_MAX_QUESTIONS,
  REQUEST_MAX_PHOTOS_PER_QUESTION,
  REQUEST_MAX_PHOTOS_TOTAL,
} from './requestForms';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

const R2 = 'https://cdn.outsyde.test';
const photo = (n = 1) => `${R2}/requests/0000000${n}-1111-2222-3333-444444444444.jpg`;

console.log('\n── normalizeQuestions ──');
{
  const r = normalizeQuestions([
    { type: 'short_text', label: '  Pickup address  ', required: true },
    { type: 'long_text', label: 'Anything else?' },
    { type: 'choice', label: 'Home size', options: [' Studio ', '1 Bedroom', '1 Bedroom', ''], multiple: false },
    { type: 'date', label: 'Move date', required: true },
    { type: 'photos', label: 'Photos of large items', maxPhotos: 3 },
  ]);
  assert(r.ok === true, 'five question types accepted', r);
  if (r.ok) {
    assert(r.questions.length === 5, 'all five kept');
    assert(r.questions.every((q) => /^[a-z0-9]{8}$/.test(q.id)), 'ids assigned when missing', r.questions.map((q) => q.id));
    assert(new Set(r.questions.map((q) => q.id)).size === 5, 'ids unique');
    assert(r.questions[0].label === 'Pickup address' && r.questions[0].required === true, 'label trimmed, required kept');
    assert(r.questions[1].required === false, 'required defaults to false');
    assert(JSON.stringify(r.questions[2].options) === '["Studio","1 Bedroom"]' && r.questions[2].multiple === false, 'choice options trimmed, blanks and duplicates dropped');
    assert(r.questions[4].maxPhotos === 3, 'maxPhotos kept');
  }
}
{
  const r = normalizeQuestions([{ id: 'keepme12', type: 'short_text', label: 'A' }, { id: 'keepme12', type: 'short_text', label: 'B' }]);
  assert(r.ok === true && r.questions[0].id === 'keepme12' && r.questions[1].id !== 'keepme12', 'an existing id is kept, a duplicate gets a new one', r);
}
assert(normalizeQuestions([{ type: 'photos', label: 'P' }]).ok && (normalizeQuestions([{ type: 'photos', label: 'P' }]) as any).questions[0].maxPhotos === REQUEST_MAX_PHOTOS_PER_QUESTION, 'photos default to the per question max');
assert(!normalizeQuestions([{ type: 'photos', label: 'P', maxPhotos: REQUEST_MAX_PHOTOS_PER_QUESTION + 1 }]).ok, `photos over ${REQUEST_MAX_PHOTOS_PER_QUESTION} refused`);
assert(!normalizeQuestions([{ type: 'choice', label: 'C', options: ['Only one'] }]).ok, 'choice needs at least two options');
assert(!normalizeQuestions([{ type: 'choice', label: 'C', options: Array.from({ length: 21 }, (_, i) => `O${i}`) }]).ok, 'choice over 20 options refused');
assert(!normalizeQuestions([{ type: 'video', label: 'V' }]).ok, 'unknown type refused');
assert(!normalizeQuestions([{ type: 'short_text', label: '   ' }]).ok, 'blank label refused');
assert(!normalizeQuestions([{ type: 'short_text', label: 'x'.repeat(201) }]).ok, 'label over 200 refused');
assert(!normalizeQuestions(Array.from({ length: REQUEST_FORM_MAX_QUESTIONS + 1 }, (_, i) => ({ type: 'short_text', label: `Q${i}` }))).ok, `over ${REQUEST_FORM_MAX_QUESTIONS} questions refused`);
assert(normalizeQuestions(Array.from({ length: REQUEST_FORM_MAX_QUESTIONS }, (_, i) => ({ type: 'short_text', label: `Q${i}` }))).ok, `${REQUEST_FORM_MAX_QUESTIONS} questions allowed`);
assert(!normalizeQuestions('nope').ok && !normalizeQuestions(null).ok, 'not a list refused');
assert(normalizeQuestions([]).ok, 'an empty form is allowed');
{
  const r = normalizeQuestions([{ type: 'short_text', label: 'A', options: ['x', 'y'], multiple: true, maxPhotos: 4 }]);
  assert(r.ok && r.questions[0].options === undefined && r.questions[0].multiple === undefined && r.questions[0].maxPhotos === undefined, 'fields that do not belong to the type are dropped', r);
}

{
  const req = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'photos', label: `P${i}`, required: true, maxPhotos: 1 }));
  assert(normalizeQuestions(req(REQUEST_MAX_PHOTOS_TOTAL)).ok, `${REQUEST_MAX_PHOTOS_TOTAL} required photo questions allowed`);
  assert(!normalizeQuestions(req(REQUEST_MAX_PHOTOS_TOTAL + 1)).ok, 'more required photo questions than a request can hold are refused');
}

console.log('\n── checkResolvedLimits (combined form) ──');
{
  const q = (i: number) => ({ id: `q${i}`, type: 'short_text' as const, label: `Q${i}`, required: false });
  assert(checkResolvedLimits(Array.from({ length: REQUEST_FORM_MAX_QUESTIONS }, (_, i) => q(i))).ok, `${REQUEST_FORM_MAX_QUESTIONS} combined questions allowed`);
  assert(!checkResolvedLimits(Array.from({ length: REQUEST_FORM_MAX_QUESTIONS + 1 }, (_, i) => q(i))).ok, `${REQUEST_FORM_MAX_QUESTIONS + 1} combined questions refused`);
}

console.log('\n── resolveServiceForm ──');
const base = [{ id: 'base0001', type: 'short_text' as const, label: 'Base Q', required: true }];
const saved = [{ id: 'save0001', type: 'long_text' as const, label: 'Saved Q', required: false }];
const own = [{ id: 'own00001', type: 'date' as const, label: 'Own Q', required: true }];
{
  const r = resolveServiceForm({ savedForm: saved, base, useBase: true, own });
  assert(r.length === 1 && r[0].label === 'Saved Q' && r[0].id === 'f_save0001', 'a saved form wins, alone', r);
}
{
  const r = resolveServiceForm({ savedForm: null, base, useBase: true, own });
  assert(r.map((q) => q.id).join(',') === 'b_base0001,s_own00001', 'base plus the service\'s extra questions, base first', r);
}
{
  const r = resolveServiceForm({ savedForm: null, base, useBase: false, own });
  assert(r.map((q) => q.id).join(',') === 's_own00001', 'own questions only when the base is not used', r);
}
assert(resolveServiceForm({ savedForm: null, base: null, useBase: true, own: [] }).length === 0, 'no base and no own questions = no questions');

console.log('\n── checkAnswers ──');
const form = resolveServiceForm({
  savedForm: null,
  useBase: true,
  base: [
    { id: 'addr0001', type: 'short_text', label: 'Pickup address', required: true },
    { id: 'size0001', type: 'choice', label: 'Home size', required: true, options: ['Studio', '1 Bedroom'], multiple: false },
  ],
  own: [
    { id: 'rooms001', type: 'choice', label: 'Rooms to pack', required: false, options: ['Kitchen', 'Closets', 'Garage'], multiple: true },
    { id: 'date0001', type: 'date', label: 'Move date', required: true },
    { id: 'note0001', type: 'long_text', label: 'Notes', required: false },
    { id: 'pics0001', type: 'photos', label: 'Photos', required: false, maxPhotos: 3 },
  ],
});
const good = {
  b_addr0001: ' 12 Main St ',
  b_size0001: '1 Bedroom',
  s_rooms001: ['Kitchen', 'Garage'],
  s_date0001: '2026-12-12',
  s_note0001: '',
  s_pics0001: [photo(1), photo(2)],
};
{
  const r = checkAnswers(form, good, R2);
  assert(r.ok === true, 'a complete answer set passes', r);
  if (r.ok) {
    assert(r.answers.length === 5, 'empty optional answers are left out of the saved copy', r.answers.map((a) => a.questionId));
    assert(r.answers[0].label === 'Pickup address' && r.answers[0].value === '12 Main St' && r.answers[0].type === 'short_text', 'saved copy keeps the label and type, text trimmed', r.answers[0]);
    assert(JSON.stringify(r.answers.find((a) => a.questionId === 's_rooms001')!.value) === '["Kitchen","Garage"]', 'multiple choice saved as a list');
    assert(r.photoCount === 2, 'photo count');
  }
}
const without = (k: string) => { const c: Record<string, unknown> = { ...good }; delete c[k]; return c; };
const bad = (patch: Record<string, unknown>) => checkAnswers(form, { ...good, ...patch }, R2);
assert(!checkAnswers(form, without('b_addr0001'), R2).ok && (checkAnswers(form, without('b_addr0001'), R2) as any).field === 'b_addr0001', 'a missing required answer is refused and named');
assert(!bad({ b_addr0001: '   ' }).ok, 'a blank required text is refused');
assert(!bad({ b_addr0001: 'x'.repeat(201) }).ok, 'short text over 200 refused');
assert(!bad({ s_note0001: 'x'.repeat(2001) }).ok && bad({ s_note0001: 'x'.repeat(2000) }).ok, 'long text up to 2000');
assert(!bad({ b_size0001: 'Mansion' }).ok, 'a choice that is not an option is refused');
assert(!bad({ b_size0001: ['Studio'] }).ok, 'single choice must be one value');
assert(!bad({ s_rooms001: ['Kitchen', 'Kitchen'] }).ok, 'multiple choice refuses duplicates');
assert(!bad({ s_rooms001: ['Attic'] }).ok, 'multiple choice refuses values that are not options');
assert(!bad({ s_rooms001: 'Kitchen' }).ok, 'multiple choice must be a list');
assert(!bad({ s_date0001: '12/12/2026' }).ok && !bad({ s_date0001: '2026-02-30' }).ok, 'date must be a real YYYY-MM-DD date');
assert(!bad({ s_pics0001: [photo(1), photo(2), photo(3), photo(4)] }).ok, 'photos over the question max refused');
assert(!bad({ s_pics0001: ['https://evil.test/requests/00000001-1111-2222-3333-444444444444.jpg'] }).ok, 'photos must be uploaded through Outsyde');
assert(!bad({ s_pics0001: [`${R2}/messages/00000001-1111-2222-3333-444444444444.jpg`] }).ok, 'photos must be in the requests folder');
assert(!bad({ s_pics0001: [`${R2}/requests/../x.jpg`] }).ok, 'photo names must be exactly an upload name');
assert(checkAnswers(form, { ...good, s_pics0001: [`${R2}/requests/00000009-1111-2222-3333-444444444444.png`] }, R2 + '/').ok, 'a trailing slash on the R2 address still matches');
assert(!checkAnswers(form, good, undefined).ok, 'photos refused when R2 is not set');
assert(checkAnswers(form, { ...good, s_pics0001: [] }, undefined).ok, 'no photos needed, no R2 needed');
assert(checkAnswers(form, { ...good, zzzz: 'extra' }, R2).ok, 'answers to questions that are not on the form are ignored');
assert(!checkAnswers(form, 'nope', R2).ok, 'answers must be an object');
{
  const many = resolveServiceForm({
    savedForm: null, useBase: false, base: null,
    own: [1, 2, 3].map((i) => ({ id: `pics000${i}`, type: 'photos' as const, label: `P${i}`, required: false, maxPhotos: 5 })),
  });
  const five = [1, 2, 3, 4, 5].map((n) => photo(n));
  const r = checkAnswers(many, { s_pics0001: five, s_pics0002: five, s_pics0003: [photo(6)] }, R2);
  assert(!r.ok, `over ${REQUEST_MAX_PHOTOS_TOTAL} photos on one request refused`, r);
  assert(checkAnswers(many, { s_pics0001: five, s_pics0002: five }, R2).ok, `${REQUEST_MAX_PHOTOS_TOTAL} photos allowed`);
}
assert(checkAnswers([], {}, R2).ok, 'a service with no questions accepts no answers');

console.log('\n── requestMessageText ──');
{
  const t = requestMessageText({ serviceName: 'Standard Move, Weekday ', preferredDate: '2026-12-12' });
  assert(t === 'Sent a request for Standard Move, Weekday (Dec 12, 2026).', 'summary with service and date', t);
  assert(!/ - | — | – /.test(t), 'no dashes in the summary');
  const g = requestMessageText({ serviceName: null, preferredDate: null });
  assert(g === 'Sent a request.', 'summary without a service', g);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
