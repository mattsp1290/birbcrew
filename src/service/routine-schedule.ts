/** Five-field cron schedules in UTC: minute hour day-of-month month day-of-week.
 * Each field is a comma list of `*`, `N`, `N-M`, `*\/S`, `N-M/S` or `N/S` (N to the field's
 * maximum). Day-of-week 0 and 7 are Sunday. No names, macros, `?`, `L`, `W` or `#`.
 * When day-of-month and day-of-week are both restricted (neither field is exactly `*`),
 * a day matches either one, as in Vixie cron; otherwise it must match both. Vixie cron
 * also treats a field that starts with `*` (such as `*\/2`) as unrestricted here; this
 * parser does not. */
export interface Schedule {
  readonly minutes: readonly number[];
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly eitherDay: boolean;
}

export const minimumIntervalMinutes = 15;
const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
// A schedule that matches nowhere within this horizon never fires. February 29 recurs
// within eight years (2096 to 2104 skips 2100), so nine years accepts every schedule that fires.
const horizonMs = 9 * 366 * 86_400_000;

function field(text: string, [min, max]: readonly [number, number]): number[] | undefined {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(item);
    if (!match) return undefined;
    const [, star, from, to, by] = match;
    const low = star ? min : Number(from);
    const high = star ? max : to !== undefined ? Number(to) : by !== undefined ? max : low;
    const step = by === undefined ? 1 : Number(by);
    if (low < min || high > max || low > high || step < 1) return undefined;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** The parsed schedule, or undefined for text this grammar does not accept. */
export function parseSchedule(text: string): Schedule | undefined {
  if (text.length > 128 || !/^\S+ \S+ \S+ \S+ \S+$/.test(text)) return undefined;
  const parts = text.split(" ");
  const values = parts.map((part, i) => field(part, ranges[i]));
  if (values.some(value => value === undefined)) return undefined;
  const [minutes, hours, days, months, weekdays] = values as number[][];
  return {
    minutes, hours: new Set(hours), days: new Set(days), months: new Set(months),
    weekdays: new Set(weekdays.map(day => day % 7)), eitherDay: parts[2] !== "*" && parts[4] !== "*",
  };
}

/** A lower bound on the minutes between consecutive windows, from the minute field alone.
 * Two windows in one hour are at least the smallest step between listed minutes apart;
 * windows in different hours are at least (60 - last minute) + first minute apart. It is
 * exact when every hour is scheduled and conservative otherwise: `0,50 9 * * *` is refused
 * (bound 10) although its windows are 50 minutes and 23 hours 10 minutes apart. */
export function minimumGapMinutes(schedule: Schedule): number {
  const { minutes } = schedule;
  let gap = 60 - minutes[minutes.length - 1] + minutes[0];
  for (let i = 1; i < minutes.length; i++) gap = Math.min(gap, minutes[i] - minutes[i - 1]);
  return gap;
}

function dayMatches(schedule: Schedule, time: Date) {
  const day = schedule.days.has(time.getUTCDate()), weekday = schedule.weekdays.has(time.getUTCDay());
  return schedule.eitherDay ? day || weekday : day && weekday;
}

/** The first window strictly after `after`, or undefined if none falls within nine years. */
export function nextWindow(schedule: Schedule, after: Date): Date | undefined {
  const time = new Date(after.getTime());
  time.setUTCSeconds(0, 0);
  time.setUTCMinutes(time.getUTCMinutes() + 1);
  const limit = after.getTime() + horizonMs;
  while (time.getTime() <= limit) {
    if (!schedule.months.has(time.getUTCMonth() + 1)) {
      time.setUTCMonth(time.getUTCMonth() + 1, 1);
      time.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(schedule, time)) {
      time.setUTCDate(time.getUTCDate() + 1);
      time.setUTCHours(0, 0, 0, 0);
    } else if (!schedule.hours.has(time.getUTCHours())) {
      time.setUTCHours(time.getUTCHours() + 1, 0, 0, 0);
    } else {
      const minute = schedule.minutes.find(value => value >= time.getUTCMinutes());
      if (minute !== undefined) {
        time.setUTCMinutes(minute);
        return time;
      }
      time.setUTCHours(time.getUTCHours() + 1, 0, 0, 0);
    }
  }
  return undefined;
}

/** The latest window at or before `now`, starting from a window `due` at or before `now`. */
export function latestWindow(schedule: Schedule, due: Date, now: Date): Date {
  let window = due;
  // After a long gap, start a day back rather than walking every window since `due`.
  const recent = new Date(now.getTime() - 86_400_000);
  if (recent > window) {
    const candidate = nextWindow(schedule, recent);
    if (candidate && candidate <= now) window = candidate;
  }
  for (let next = nextWindow(schedule, window); next && next <= now; next = nextWindow(schedule, window)) window = next;
  return window;
}

/** Why a schedule is refused, or undefined when it is accepted at `now`. */
export function scheduleProblem(text: string, now: Date): "unparsed" | "too_frequent" | "never_fires" | undefined {
  const schedule = parseSchedule(text);
  if (!schedule) return "unparsed";
  if (minimumGapMinutes(schedule) < minimumIntervalMinutes) return "too_frequent";
  if (!nextWindow(schedule, now)) return "never_fires";
  return undefined;
}
