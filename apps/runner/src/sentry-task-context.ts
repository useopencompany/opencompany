type PriorSentryTask = { id: string; result: string | null; links: string[] };

// Reserve room for PR links before summaries. Measuring the serialized content accounts for
// escaped quotes and control characters, so the context remains bounded for hostile summaries.
export function sentryPriorTaskContext(tasks: PriorSentryTask[]): string {
  const rows = tasks.slice(0, 3).map((task) => ({
    id: task.id.slice(0, 128),
    links: task.links.slice(0, 5).map((link) => link.slice(0, 300)),
    result: "",
  }));
  for (const [index, row] of rows.entries()) {
    const summary = (tasks[index]?.result ?? "").replaceAll(
      "</sentry_prior_task_data>",
      "<\\/sentry_prior_task_data>",
    );
    const budget = Math.floor((6000 - JSON.stringify(rows).length) / (rows.length - index));
    let low = 0;
    let high = Math.min(summary.length, 2000);
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      if (JSON.stringify(summary.slice(0, candidate)).length - 2 <= budget) low = candidate;
      else high = candidate - 1;
    }
    row.result = summary.slice(0, low);
  }
  return JSON.stringify(rows);
}
