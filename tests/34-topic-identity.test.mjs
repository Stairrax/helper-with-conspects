import { preserveTopicIdentity } from '../js/topic-identity.js';

export default async ({ ok }) => {
  const previous = { topics: [
    { id: 'old-a', source: 'lecture', text: 'Fact A' },
    { id: 'old-b', source: 'lecture', text: 'Fact B' },
    { id: 'old-c', source: 'lecture', text: 'Repeated' },
  ] };
  const progress = { stats: { 'old-a': { due: 100, right: 2 }, 'old-b': { due: 200 }, 'old-c': { due: 300 } } };
  const next = { topics: [
    { id: 'new-a', source: 'lecture', text: 'Fact A', prereq: [] },
    { id: 'new-b', source: 'lecture', text: 'Fact B changed', prereq: ['new-a'] },
    { id: 'new-c', source: 'lecture', text: 'Repeated', prereq: ['new-b'] },
    { id: 'new-d', source: 'lecture', text: 'Repeated', prereq: [] },
  ], plan: { order: ['new-b', 'new-a', 'new-c', 'new-d'] } };
  const stats = preserveTopicIdentity(next, previous, progress);
  ok(next.topics.map(t => t.id).join() === 'old-a,new-b,old-c,new-d', 'unchanged source text keeps its topic ID; changed and duplicate topics get new IDs');
  ok(next.plan.order.join() === 'new-b,old-a,old-c,new-d' && next.topics[1].prereq[0] === 'old-a', 'plan and prerequisites point to retained IDs');
  ok(stats['old-a']?.due === 100 && stats['old-c']?.due === 300 && !stats['old-b'], 'only unchanged topics retain review history');
};
