// "Business date" is the calendar date in the outlet's timezone, YYYY-MM-DD.
export function businessDate(timezone = 'Asia/Kolkata', at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at);
}

// Indian FY by default (starts 1 April): 2026-10-27 -> "26-27"
export function financialYear(dateStr, fyStart = '04-01') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [sm, sd] = fyStart.split('-').map(Number);
  const startYear = m > sm || (m === sm && d >= sd) ? y : y - 1;
  const yy = (n) => String(n % 100).padStart(2, '0');
  return `${yy(startYear)}-${yy(startYear + 1)}`;
}
