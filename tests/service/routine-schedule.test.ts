import assert from "node:assert/strict";
import { test } from "node:test";
import { latestWindow, minimumGapMinutes, nextWindow, parseSchedule, scheduleProblem } from "../../src/service/routine-schedule.ts";

const at = (text: string) => new Date(text);
const iso = (date: Date | undefined) => date?.toISOString();
function next(schedule: string, after: string) {
  return iso(nextWindow(parseSchedule(schedule)!, at(after)));
}

test("the grammar accepts five numeric fields and nothing else", () => {
  const parsed = parseSchedule("5/20 9-17/4 1,15 */6 1-5")!;
  assert.deepEqual(parsed.minutes, [5, 25, 45]);
  assert.deepEqual([...parsed.hours].sort((a, b) => a - b), [9, 13, 17]);
  assert.deepEqual([...parsed.days].sort((a, b) => a - b), [1, 15]);
  assert.deepEqual([...parsed.months].sort((a, b) => a - b), [1, 7]);
  assert.deepEqual([...parsed.weekdays].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(parsed.eitherDay, true);
  assert.deepEqual([...parseSchedule("0 0 * * 7")!.weekdays], [0], "7 is Sunday");
  assert.equal(parseSchedule("0 0 * * 0,7")!.weekdays.size, 1);
  for (const text of ["* * * *", "* * * * * *", "*  * * * *", " * * * * *", "* * * * * ", "*\t* * * *",
    "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 0 *", "* * * 13 *", "* * * * 8",
    "5-1 * * * *", "*/0 * * * *", "1-2-3 * * * *", "-1 * * * *", "+1 * * * *", "1, * * * *", ",1 * * * *",
    "0 0 * JAN *", "0 0 * * MON", "@hourly", "0 0 ? * *", "0 0 L * *", "0 0 1W * *", "0 0 * * 1#2", "100 * * * *",
    "0" + ",0".repeat(60) + " * * * *"]) {
    assert.equal(parseSchedule(text), undefined, JSON.stringify(text));
  }
});

test("next windows are strictly later, minute-aligned and in UTC", () => {
  assert.equal(next("*/15 * * * *", "2031-01-06T10:07:30.500Z"), "2031-01-06T10:15:00.000Z");
  assert.equal(next("*/15 * * * *", "2031-01-06T10:15:00.000Z"), "2031-01-06T10:30:00.000Z");
  assert.equal(next("*/15 * * * *", "2031-01-06T23:59:00.000Z"), "2031-01-07T00:00:00.000Z");
  assert.equal(next("0 9 * * 1-5", "2031-01-10T10:00:00Z"), "2031-01-13T09:00:00.000Z", "Friday 10:00 to Monday 09:00");
  assert.equal(next("30 23 31 12 *", "2031-06-01T00:00:00Z"), "2031-12-31T23:30:00.000Z");
  assert.equal(next("0 0 1 1 *", "2031-12-31T23:59:59Z"), "2032-01-01T00:00:00.000Z");
  // Both day fields restricted: either matches. 2031-02-13 is a Thursday.
  assert.equal(next("0 0 13 * 5", "2031-02-12T00:00:00Z"), "2031-02-13T00:00:00.000Z");
  assert.equal(next("0 0 13 * 5", "2031-02-13T00:00:00Z"), "2031-02-14T00:00:00.000Z");
  // One unrestricted: both must match, so only Fridays.
  assert.equal(next("0 0 * * 5", "2031-02-12T00:00:00Z"), "2031-02-14T00:00:00.000Z");
  // `*/2` is a restriction here (Vixie cron would treat it as `*`).
  assert.equal(next("0 0 */2 * 5", "2031-02-12T00:00:00Z"), "2031-02-13T00:00:00.000Z");
  assert.equal(next("0 0 29 2 *", "2097-03-01T00:00:00Z"), "2104-02-29T00:00:00.000Z", "2100 is not a leap year");
  assert.equal(next("0 0 30 2 *", "2031-01-01T00:00:00Z"), undefined);
  assert.equal(next("0 0 31 4,6,9,11 *", "2031-01-01T00:00:00Z"), undefined);
});

test("the minimum interval is enforced from the minute field, conservatively", () => {
  const now = at("2031-01-06T10:00:00Z");
  for (const text of ["*/15 * * * *", "0 * * * *", "0,45 * * * *", "7,22,37,52 * * * *", "0 9 * * 1-5", "0 0 29 2 *"]) {
    assert.equal(scheduleProblem(text, now), undefined, text);
  }
  for (const text of ["* * * * *", "*/10 * * * *", "*/14 * * * *", "5,55 * * * *", "0,14 * * * *"]) {
    assert.equal(scheduleProblem(text, now), "too_frequent", text);
  }
  // Legal but refused: across the hour the bound is 60 - 50 + 0 = 10 minutes, although only
  // 09:00 and 09:50 are scheduled and consecutive windows are at least 50 minutes apart.
  assert.equal(minimumGapMinutes(parseSchedule("0,50 9 * * *")!), 10);
  assert.equal(scheduleProblem("0,50 9 * * *", now), "too_frequent");
  assert.equal(scheduleProblem("0 0 30 2 *", now), "never_fires");
  assert.equal(scheduleProblem("0 0 * * MON", now), "unparsed");
});

test("every accepted schedule's windows are at least 15 minutes apart", () => {
  const schedules = ["*/15 * * * *", "0,45 * * * *", "7,22,37,52 */2 * * *", "45 23 * * *", "0,15 0 1 * *",
    "50 * * * 0,6", "0 0 13 * 5", "14,29,44,59 * * * *", "0/20 1-3 * * *"];
  for (const text of schedules) {
    const schedule = parseSchedule(text)!;
    assert.ok(minimumGapMinutes(schedule) >= 15, text);
    let previous = nextWindow(schedule, at("2031-01-01T00:00:00Z"))!;
    for (let i = 0; i < 2000; i++) {
      const window = nextWindow(schedule, previous)!;
      assert.ok(window.getTime() - previous.getTime() >= 15 * 60_000, `${text}: ${iso(previous)} to ${iso(window)}`);
      previous = window;
    }
  }
});

test("the latest window at or before now is found from any due window", () => {
  const every = parseSchedule("*/15 * * * *")!;
  assert.equal(iso(latestWindow(every, at("2031-01-06T10:00:00Z"), at("2031-01-06T12:07:00Z"))), "2031-01-06T12:00:00.000Z");
  assert.equal(iso(latestWindow(every, at("2031-01-06T10:00:00Z"), at("2031-01-06T10:00:00Z"))), "2031-01-06T10:00:00.000Z");
  // Two years of downtime: the day-back shortcut avoids walking every window.
  assert.equal(iso(latestWindow(every, at("2029-01-06T10:00:00Z"), at("2031-01-06T12:07:00Z"))), "2031-01-06T12:00:00.000Z");
  const monthly = parseSchedule("0 6 1 * *")!;
  assert.equal(iso(latestWindow(monthly, at("2030-01-01T06:00:00Z"), at("2031-01-20T00:00:00Z"))), "2031-01-01T06:00:00.000Z");
});
