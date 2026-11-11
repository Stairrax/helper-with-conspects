import { reviewResult } from '../js/review-schedule.js';

export default async ({ ok }) => {
  const now = 1700000000000, day = 86400000;
  const sure = reviewResult({}, 1, 'sure', now);
  const guessed = reviewResult({}, 1, 'guessed', now);
  ok(guessed.due < sure.due && guessed.due >= now + day, 'correct guess grows more slowly than a confident answer');
  const wrong = reviewResult(sure, 0, 'unsure', now);
  ok(wrong.due === now + 600000 && wrong.due_at === wrong.due && wrong.ease < sure.ease, 'wrong answer gets a short learning step and a durable due date');
  ok(wrong.best_conf === 'sure' && !reviewResult({}, 0, 'sure', now).best_conf, 'incorrect confidence cannot establish mastery');
  let leech = {};
  for (let i = 0; i < 6; i++) leech = reviewResult(leech, 0, 'unsure', now);
  ok(leech.reviewStatus === 'leech' && leech.lapses === 6 && leech.ease >= 1.3, 'repeated failures are marked and ease has a floor');
};
