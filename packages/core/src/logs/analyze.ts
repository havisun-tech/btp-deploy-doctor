import { LOG_PATTERNS, LogPattern } from './patterns';

export interface LogMatch {
  patternId: string;
  title: string;
  explanation: string;
  fix: string;
  /** 1-based line of the first occurrence. */
  line: number;
  text: string;
  count: number;
}

export interface DiagnoseResult {
  totalLines: number;
  matches: LogMatch[];
  /** MTA operation IDs mentioned in the log (from "cf dmol -i <id>" hints). */
  operationIds: string[];
  /** Error-looking lines that no known pattern explains. */
  otherErrors: { line: number; text: string }[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const ERRORISH = /\b(?:ERR!?|ERROR|Error|FAILED|Failed|failed|Exception|CRASHED)\b/;
const MAX_LINE = 400;

function fill(template: string, groups: string[]): string {
  return template.replace(/\$(\d)/g, (_, i) => groups[Number(i)] ?? '');
}

/** Matches a deploy or runtime log against known BTP / CAP failure signatures. */
export function analyzeLog(text: string, patterns: LogPattern[] = LOG_PATTERNS): DiagnoseResult {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  const byId = new Map<string, LogMatch>();
  const operationIds = new Set<string>();
  const explained = new Set<number>();
  const otherErrors: { line: number; text: string }[] = [];

  lines.forEach((raw, i) => {
    const line = raw.length > 4000 ? raw.slice(0, 4000) : raw;
    for (const m of line.matchAll(/cf (?:dmol|download-mta-op-logs) -i ([\w-]+)/g)) operationIds.add(m[1]);
    let specificHit = false;
    for (const p of [...patterns.filter((x) => !x.generic), ...patterns.filter((x) => x.generic)]) {
      if (p.generic && specificHit) continue;
      const m = p.regex.exec(line);
      if (!m) continue;
      if (!p.generic) specificHit = true;
      explained.add(i);
      const existing = byId.get(p.id);
      if (existing) {
        existing.count++;
        continue;
      }
      const groups = [...m].map((g) => g ?? '');
      byId.set(p.id, {
        patternId: p.id,
        title: p.title,
        explanation: fill(p.explanation, groups),
        fix: fill(p.fix, groups),
        line: i + 1,
        text: line.trim().slice(0, MAX_LINE),
        count: 1,
      });
    }
  });

  lines.forEach((line, i) => {
    if (!explained.has(i) && ERRORISH.test(line) && otherErrors.length < 10) {
      otherErrors.push({ line: i + 1, text: line.trim().slice(0, MAX_LINE) });
    }
  });

  return {
    totalLines: lines.length,
    matches: [...byId.values()].sort((a, b) => a.line - b.line),
    operationIds: [...operationIds],
    otherErrors,
  };
}
