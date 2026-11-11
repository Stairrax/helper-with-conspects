// Reuse identity only when the complete source text is unchanged. A similar
// title or AI summary is insufficient evidence that the topic is the same.
export function preserveTopicIdentity(next, previous, progress) {
  const old = new Map();
  for (const topic of previous?.topics || []) {
    const key = JSON.stringify([topic.source, topic.text]);
    if (!old.has(key)) old.set(key, []);
    old.get(key).push(topic);
  }
  const stats = {};
  const renamed = new Map();
  for (const topic of next.topics || []) {
    const match = old.get(JSON.stringify([topic.source, topic.text]))?.shift();
    if (!match) continue;
    renamed.set(topic.id, match.id);
    topic.id = match.id;
    if (progress?.stats?.[match.id]) stats[match.id] = structuredClone(progress.stats[match.id]);
  }
  if (next.plan?.order) next.plan.order = next.plan.order.map(id => renamed.get(id) || id);
  for (const topic of next.topics || []) {
    if (topic.prereq) topic.prereq = topic.prereq.map(id => renamed.get(id) || id);
  }
  return stats;
}
