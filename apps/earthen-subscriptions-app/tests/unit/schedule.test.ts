import { describe, expect, it } from "vitest";
import { addDurationMonths, nextOccurrence } from "../../app/subscriptions/schedule";

describe("subscription schedule", () => {
  it("advances weekly and fortnightly intervals by exact days", () => {
    const start = new Date("2026-01-31T10:00:00.000Z");
    expect(nextOccurrence(start, "weekly").toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(nextOccurrence(start, "fortnightly").toISOString()).toBe("2026-02-14T10:00:00.000Z");
  });

  it("clamps calendar month schedules at month end", () => {
    expect(nextOccurrence(new Date("2026-01-31T10:00:00.000Z"), "monthly").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(nextOccurrence(new Date("2028-01-31T10:00:00.000Z"), "monthly").toISOString()).toBe("2028-02-29T10:00:00.000Z");
  });

  it("supports every longer interval and two-year duration", () => {
    const start = new Date("2026-07-19T00:00:00.000Z");
    expect(nextOccurrence(start, "bimonthly").toISOString()).toContain("2026-09-19");
    expect(nextOccurrence(start, "quarterly").toISOString()).toContain("2026-10-19");
    expect(nextOccurrence(start, "half_yearly").toISOString()).toContain("2027-01-19");
    expect(addDurationMonths(start, 24).toISOString()).toContain("2028-07-19");
  });
});
