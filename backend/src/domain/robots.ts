/**
 * robots.txt kuralları (RFC 9309): ajanın kendi grubu varsa o, yoksa "*" grubu geçerlidir. Allow ve Disallow kalıpları
 * "*" joker ve sondaki "$" bağıyla eşlenir; birden çok kural eşleşirse en uzun kalıp kazanır, eşitlikte izin verilir.
 */
export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

interface Group {
  agents: string[];
  allow: string[];
  disallow: string[];
}

function groupsOf(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    collectingAgents = false;
    if (!current || !value) continue;
    if (key === 'allow') current.allow.push(value);
    else if (key === 'disallow') current.disallow.push(value);
  }
  return groups;
}

/** Ajan adının ürün kısmı ("JoblessTurtle/1.1 (+…)" → "joblessturtle"); robots.txt grupları bu adla eşlenir. */
export function robotsProductToken(userAgent: string): string {
  return (userAgent.split(/[\s/]/)[0] ?? '').toLowerCase();
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const token = robotsProductToken(userAgent);
  const groups = groupsOf(text);
  const own = groups.filter((g) => token && g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
}

function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function longestMatch(patterns: string[], target: string): number {
  let best = -1;
  for (const pattern of patterns) if (pattern.length > best && patternRegex(pattern).test(target)) best = pattern.length;
  return best;
}

/** Yol ve sorgu ("/jobs?q=x&start=10") kurallara göre taranabilir mi? */
export function robotsPathAllowed(rules: RobotsRules, pathAndQuery: string): boolean {
  if (pathAndQuery === '/robots.txt') return true;
  const disallowed = longestMatch(rules.disallow, pathAndQuery);
  if (disallowed < 0) return true;
  return longestMatch(rules.allow, pathAndQuery) >= disallowed;
}
