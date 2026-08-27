import assert from "node:assert/strict";
import test from "node:test";

import {
  describePeakHourWindow,
  evaluatePeakHourProtection,
  normalizePeakHourProtection,
} from "../../src/lib/providers/peakHourProtection.ts";

test("peak-hour protection activates inside weekday UTC windows", () => {
  const state = evaluatePeakHourProtection(
    {
      peakHourProtection: {
        enabled: true,
        mode: "block",
        windows: [
          {
            days: ["mon", "tue", "wed", "thu", "fri"],
            startUtc: "01:00",
            endUtc: "04:00",
          },
        ],
      },
    },
    new Date("2026-08-24T01:30:00.000Z")
  );

  assert.equal(state.active, true);
  assert.equal(state.mode, "block");
  assert.equal(state.retryAfter, "2026-08-24T04:00:00.000Z");
  assert.equal(state.retryAfterSeconds, 9000);
});

test("peak-hour protection honors weekdays and end boundary", () => {
  const providerSpecificData = {
    peakHourProtection: {
      enabled: true,
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          startUtc: "06:00",
          endUtc: "10:00",
        },
      ],
    },
  };

  assert.deepEqual(
    evaluatePeakHourProtection(providerSpecificData, new Date("2026-08-22T06:30:00.000Z")),
    { active: false }
  );
  assert.deepEqual(
    evaluatePeakHourProtection(providerSpecificData, new Date("2026-08-24T10:00:00.000Z")),
    { active: false }
  );
});

test("peak-hour protection supports daily Z.ai-style windows", () => {
  const state = evaluatePeakHourProtection(
    {
      peakHourProtection: {
        enabled: true,
        mode: "avoid",
        windows: [{ name: "Z.ai peak", startUtc: "06:00", endUtc: "10:00" }],
      },
    },
    new Date("2026-08-23T06:30:00.000Z")
  );

  assert.equal(state.active, true);
  assert.equal(state.mode, "avoid");
  assert.equal(describePeakHourWindow(state.window), "Z.ai peak daily 06:00-10:00 UTC");
});

test("normalizer drops malformed windows but keeps operator intent", () => {
  assert.deepEqual(
    normalizePeakHourProtection({
      enabled: true,
      mode: "avoid",
      windows: [
        { startUtc: "bad", endUtc: "10:00" },
        { days: ["mon", "nope", "mon"], startUtc: "6:00", endUtc: "10:00" },
      ],
    }),
    {
      enabled: true,
      mode: "avoid",
      windows: [{ days: ["mon"], startUtc: "06:00", endUtc: "10:00" }],
    }
  );
});
