/** Markdown rendering. Terse on purpose — this gets read, not skimmed. */

import { formatCountdown } from './deadline.mjs';

const osloTime = (iso) =>
  new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

function renderDeadline(day) {
  const d = day.deadline;
  return d.hasPassed
    ? `**Frist utløpt** — ordering closed ${osloTime(d.at)}.`
    : `⏳ **${formatCountdown(d.minutesLeft)} left** — order by ${osloTime(d.at)}.`;
}

function renderDagens(dagens) {
  if (!dagens) return ['_Ingen ukesmeny publisert for denne dagen._'];
  const order = ['rett', 'varmrett', 'vegetar', 'vegansk', 'paasmurt'];
  const keys = [...order.filter((k) => dagens[k]), ...Object.keys(dagens).filter((k) => !order.includes(k))];
  const out = [];
  for (const key of keys) {
    const s = dagens[key];
    const price = s.sizes.length
      ? s.sizes.map((v) => `${v.name} ${v.price}`).join(' / ')
      : (s.price ?? '');
    const facts = [
      s.allergener.length ? `allergener: ${s.allergener.join(', ')}` : null,
      s.kcal ? `${s.kcal} kcal` : null,
      s.co2 ? `${s.co2} g CO₂` : null,
    ].filter(Boolean);
    out.push(`- **${s.label}** — ${s.dish || '_ingen beskrivelse_'}`);
    out.push(`  ${[price, ...facts].filter(Boolean).join(' · ')}`);
  }
  return out;
}

function renderAlacarte(groups, { compact = false } = {}) {
  const out = [];
  for (const g of groups) {
    out.push('', `### ${g.name}`);
    for (const item of g.items) {
      const flags = [
        item.minimum ? `min ${item.minimum}` : null,
        item.weekdayHint?.length ? `oppgitt: ${item.weekdayHint.map((d) => d.slice(0, 3)).join('/')}` : null,
      ].filter(Boolean);
      out.push(
        `- **${item.name}** — ${item.price ?? 'pris ukjent'}${flags.length ? ` _(${flags.join(', ')})_` : ''}`,
      );
      if (!compact) {
        const facts = [
          item.allergener.length ? `allergener: ${item.allergener.join(', ')}` : null,
          item.kcal ? `${item.kcal} kcal` : null,
        ].filter(Boolean);
        if (facts.length) out.push(`  ${facts.join(' · ')}`);
      }
    }
  }
  return out;
}

export function renderDay(day, { alacarte = true, compact = false } = {}) {
  const out = [];
  const rot = day.menuRotation ? ` · ${day.menuRotation}` : '';
  out.push(`## ${day.weekday} ${day.deliveryDate} (uke ${day.isoWeek}${rot})`);
  out.push('');
  if (day.isClosed) {
    out.push(`🚫 **Stengt.** ${day.closedMessage ?? ''}`.trim());
    return out.join('\n');
  }
  out.push(renderDeadline(day));
  if (day.ukesmenyIncluded !== false) out.push('', '### Ukesmeny', ...renderDagens(day.dagens));
  if (alacarte) out.push(...renderAlacarte(day.alacarte, { compact }));
  return out.join('\n');
}

export function renderWeek(days, opts = {}) {
  const out = [];
  for (const [i, day] of days.entries()) {
    // The à la carte catalogue is identical every day; print it once at the end.
    out.push(renderDay(day, { ...opts, alacarte: false }));
    out.push('');
    if (i === days.length - 1 && opts.alacarte !== false) {
      // Every open day carries the same catalogue; a fully closed week carries none.
      const withItems = days.find((d) => !d.isClosed && d.alacarte.length);
      if (withItems) {
        out.push('---', '', '## Fast utvalg (alle dager)');
        out.push(...renderAlacarte(withItems.alacarte, { compact: opts.compact }));
      }
    }
  }
  return out.join('\n');
}
