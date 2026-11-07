import { FormattingOptions, ParseError, applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { Document, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { Project } from '../project';
import { FileChange } from '../types';

const splitLines = (s: string) => s.split('\n');

/**
 * Applies the line-level difference between `baseline` and `modified` to `original`.
 * `baseline` is `original` re-serialised without changes, so only the lines the edit
 * really touched change, and the rest of the user's formatting survives.
 */
export function applyLineDiff(original: string, baseline: string, modified: string): string {
  if (baseline === original) return modified;
  const o = splitLines(original);
  const b = splitLines(baseline);
  const m = splitLines(modified);
  if (o.length !== b.length || b.length * m.length > 4_000_000) return modified;

  // LCS table on baseline vs modified
  const n = b.length;
  const k = m.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(k + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = k - 1; j >= 0; j--) {
      dp[i][j] = b[i] === m[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < k) {
    if (i < n && j < k && b[i] === m[j]) {
      out.push(o[i]); // unchanged line: keep the user's original text
      i++;
      j++;
    } else if (j < k && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(m[j++]); // inserted
    } else {
      i++; // deleted
    }
  }
  return out.join('\n');
}

/** Smallest character range of `before` to replace with `text` to get `after`. */
export function changedOffsets(before: string, after: string): { start: number; end: number; text: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix++;
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) };
}

/** Line range in `before` that must be replaced by `newLines` to get `after`. */
export function changedRegion(before: string, after: string): { startLine: number; endLine: number; newLines: string[] } {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { startLine: start, endLine: endA, newLines: b.slice(start, endB) };
}

function yamlOptions(text: string) {
  const indentSeq = !/^[\w.-]+:[ \t]*\r?\n-[ \t]/m.test(text);
  const m = /^( +)\S/m.exec(text);
  const indent = m && m[1].length >= 2 && m[1].length <= 8 ? m[1].length : 2;
  return { lineWidth: 0, indentSeq, indent };
}

/** Edits mta.yaml through the YAML document model. Return false from `mutate` to cancel. */
export function editYaml(p: Project, mutate: (doc: Document) => void | false): FileChange | undefined {
  if (!p.mta || p.mta.errors.length) return undefined;
  return editYamlFile(p, p.mta.rel, mutate);
}

/** Edits any YAML file, changing only the lines the edit touches. */
export function editYamlFile(p: Project, rel: string, mutate: (doc: Document) => void | false): FileChange | undefined {
  const original = p.readText(rel);
  if (original === undefined) return undefined;
  if (parseDocument(original).errors.length) return undefined;
  const opts = yamlOptions(original);
  const doc = parseDocument(original);
  const baseline = doc.toString(opts);
  if (mutate(doc) === false) return undefined;
  const after = applyLineDiff(original, baseline, doc.toString(opts));
  return after === original ? undefined : { file: rel, before: original, after };
}

/** One JSON edit. `value: undefined` removes the property. `sorted` inserts new keys alphabetically. */
export interface JsonOp {
  path: (string | number)[];
  value: unknown;
  sorted?: boolean;
}

/** Edits a JSON file with minimal text changes (formatting and key order elsewhere are kept). */
export function editJson(p: Project, rel: string, ops: JsonOp[]): FileChange | undefined {
  const original = p.readText(rel);
  if (original === undefined) return undefined;
  const errors: ParseError[] = [];
  parseJsonc(original, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length) return undefined;
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? '  ';
  const formattingOptions: FormattingOptions = {
    insertSpaces: !indent.includes('\t'),
    tabSize: indent.includes('\t') ? 1 : indent.length,
    eol: original.includes('\r\n') ? '\r\n' : '\n',
  };
  let text = original;
  for (const op of ops) {
    const key = op.path[op.path.length - 1];
    const getInsertionIndex =
      op.sorted && typeof key === 'string'
        ? (props: string[]) => {
            const i = props.findIndex((k) => k.localeCompare(key) > 0);
            return i < 0 ? props.length : i;
          }
        : undefined;
    text = applyEdits(text, modify(text, op.path, op.value, { formattingOptions, getInsertionIndex }));
  }
  return text === original ? undefined : { file: rel, before: original, after: text };
}

/** Ops that set a dependency, keeping the section sorted as npm does. */
export const setDependency = (section: 'dependencies' | 'devDependencies', name: string, version: string): JsonOp => ({
  path: [section, name],
  value: version,
  sorted: true,
});

export const removeDependency = (section: 'dependencies' | 'devDependencies', name: string): JsonOp => ({
  path: [section, name],
  value: undefined,
});

export function createFile(p: Project, rel: string, content: string): FileChange | undefined {
  return p.exists(rel) ? undefined : { file: rel, before: null, after: content };
}

/** Appends lines to a text file, creating it if needed. */
export function appendLines(p: Project, rel: string, lines: string[]): FileChange {
  const before = p.readText(rel);
  const base = before === undefined ? '' : before.length && !before.endsWith('\n') ? `${before}\n` : before;
  return { file: rel, before: before ?? null, after: `${base}${lines.join('\n')}\n` };
}

// ---- mta.yaml operations ----

/** Changes a scalar's value in place, keeping its comment. */
export function setScalar(doc: Document, path: (string | number)[], value: string) {
  const node = doc.getIn(path, true);
  if (isScalar(node)) node.value = value;
  else doc.setIn(path, value);
}

export function addRequire(doc: Document, modIdx: number, name: string, parameters?: Record<string, unknown>) {
  const entry = parameters ? { name, parameters } : { name };
  const seq = doc.getIn(['modules', modIdx, 'requires']);
  if (isSeq(seq)) seq.add(doc.createNode(entry));
  else doc.setIn(['modules', modIdx, 'requires'], doc.createNode([entry]));
}

export function addResource(doc: Document, resource: Record<string, unknown>) {
  const seq = doc.getIn(['resources']);
  if (isSeq(seq)) seq.add(doc.createNode(resource));
  else doc.setIn(['resources'], doc.createNode([resource]));
}

/** Adds a command to the global before-all build step, creating the step if needed. */
export function addBeforeAllCommand(doc: Document, cmd: string) {
  const beforeAll = doc.getIn(['build-parameters', 'before-all']);
  if (isSeq(beforeAll)) {
    for (const item of beforeAll.items) {
      if (isMap(item) && item.get('builder') === 'custom') {
        const commands = item.get('commands', true);
        if (isSeq(commands)) {
          commands.items.unshift(doc.createNode(cmd));
          return;
        }
      }
    }
    beforeAll.add(doc.createNode({ builder: 'custom', commands: [cmd] }));
    return;
  }
  const step = [{ builder: 'custom', commands: [cmd] }];
  if (isMap(doc.getIn(['build-parameters']))) {
    doc.setIn(['build-parameters', 'before-all'], doc.createNode(step));
    return;
  }
  const root = doc.contents;
  if (!isMap(root)) return;
  const pair = doc.createPair('build-parameters', { 'before-all': step });
  const idx = root.items.findIndex((it) => isScalar(it.key) && it.key.value === 'modules');
  root.items.splice(idx < 0 ? root.items.length : idx, 0, pair as any);
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
