/** Display and parse provider wall-clock timestamps without assuming the Mac's zone. */
export function zonedInput(value: string | null | undefined, zone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}
export function zonedIso(value: string, zone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const target = Date.parse(value + ':00Z');
  if (!Number.isFinite(target)) return null;
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const rendered = zonedInput(new Date(instant).toISOString(), zone);
    const offset = Date.parse(rendered + ':00Z') - target;
    if (offset === 0) return new Date(instant).toISOString();
    instant -= offset;
  }
  // Reject nonexistent local times around daylight-saving transitions.
  return null;
}
