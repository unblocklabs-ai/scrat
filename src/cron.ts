const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const names = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;
const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export type Cron = { minutes: Set<number>; hours: Set<number>; days: Set<number>; months: Set<number>; weekdays: Set<number>; anyDay: boolean; anyWeekday: boolean };

function field(text: string, index: number) {
  const [min, max] = bounds[index]!, label = names[index]!, values = new Set<number>();
  const invalid = () => new Error(`Invalid cron ${label}: ${JSON.stringify(text)}`);
  const number = (part: string) => {
    if (!/^\d+$/.test(part) || Number(part) < min || Number(part) > max) throw invalid();
    return Number(part);
  };
  for (const item of text.split(",")) {
    const [range = "", step, extra] = item.split("/");
    if (extra !== undefined || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) throw invalid();
    const [from, to, more] = range === "*" ? [min, max] : range.split("-").map(number);
    if (more !== undefined || from === undefined || (to !== undefined && to < from)) throw invalid();
    const last = to ?? (step === undefined ? from : max);
    for (let value = from; value <= last; value += Number(step ?? 1)) values.add(index === 4 ? value % 7 : value);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`A cron expression needs 5 fields (minute hour day-of-month month day-of-week): ${JSON.stringify(expression)}`);
  const [minutes, hours, days, months, weekdays] = parts.map(field) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return { minutes, hours, days, months, weekdays, anyDay: parts[2]!.startsWith("*"), anyWeekday: parts[4]!.startsWith("*") };
}

function dayMatches(cron: Cron, date: Date) {
  const day = cron.days.has(date.getUTCDate()), weekday = cron.weekdays.has(date.getUTCDay());
  return cron.anyDay || cron.anyWeekday ? day && weekday : day || weekday;
}

export function nextTick(cron: Cron, after: Date) {
  const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000), limit = t.getTime() + 9 * 366 * unitMs.d;
  while (t.getTime() <= limit) {
    if (!cron.months.has(t.getUTCMonth() + 1)) { t.setUTCMonth(t.getUTCMonth() + 1, 1); t.setUTCHours(0, 0, 0, 0); }
    else if (!dayMatches(cron, t)) { t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(0, 0, 0, 0); }
    else if (!cron.hours.has(t.getUTCHours())) t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    else if (!cron.minutes.has(t.getUTCMinutes())) t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    else return t;
  }
  throw new Error("Cron expression never matches a real date");
}

export function parseWindow(text: string) {
  const match = /^([1-9]\d*)([mhd])$/.exec(text);
  if (!match) throw new Error(`A window must be a number of minutes, hours or days such as 90m, 6h or 1d: ${JSON.stringify(text)}`);
  return Number(match[1]) * unitMs[match[2] as keyof typeof unitMs];
}
