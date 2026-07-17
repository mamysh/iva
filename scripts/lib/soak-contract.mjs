export function evaluateSoak({ samples, candidateCommit, minimumDays = 7, maximumP0 = 0, maximumP1 = 0, now = Date.now() }) {
  if (!/^[0-9a-f]{40}$/.test(candidateCommit || "")) throw new Error("soak candidate must be a full commit SHA");
  const normalized = (samples || []).map((sample) => ({
    ...sample,
    capturedAt: sample.capturedAt || sample.at,
    commit: sample.commit || sample.release?.commit,
  }));
  const ordered = normalized.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  if (!ordered.length) return { complete: false, reason: "no-samples", observedDays: 0, samples: 0, p0: 0, p1: 0 };
  for (const sample of ordered) {
    if (sample.commit !== candidateCommit) throw new Error("soak samples span more than one candidate commit");
    if (!Number.isFinite(Date.parse(sample.capturedAt))) throw new Error("invalid soak sample timestamp");
  }
  const start = Date.parse(ordered[0].capturedAt);
  const end = Math.min(Date.parse(ordered.at(-1).capturedAt), now);
  const observedDays = Math.max(0, (end - start) / 86_400_000);
  const p0 = ordered.reduce((sum, sample) => sum + (Number(sample.p0) || 0), 0);
  const p1 = ordered.reduce((sum, sample) => sum + (Number(sample.p1) || 0), 0);
  const unhealthy = ordered.filter((sample) => sample.status !== "healthy").length;
  const maximumGapHours = ordered.slice(1).reduce((maximum, sample, index) => {
    const gap = (Date.parse(sample.capturedAt) - Date.parse(ordered[index].capturedAt)) / 3_600_000;
    return Math.max(maximum, gap);
  }, 0);
  const continuous = maximumGapHours <= 2;
  const complete = observedDays >= minimumDays && p0 <= maximumP0 && p1 <= maximumP1 && unhealthy === 0 && continuous;
  return {
    complete,
    reason: complete ? null : observedDays < minimumDays ? "minimum-duration" : !continuous ? "sample-gap" : unhealthy ? "unhealthy-sample" : "severity-budget",
    observedDays: Number(observedDays.toFixed(3)),
    samples: ordered.length,
    p0,
    p1,
    unhealthy,
    maximumGapHours: Number(maximumGapHours.toFixed(3)),
  };
}
