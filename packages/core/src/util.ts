export function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asArray<T = any>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Deep-merges src into target (objects merge, everything else is replaced). Returns target. */
export function deepMerge(target: Record<string, any>, src: unknown): Record<string, any> {
  if (!isPlainObject(src)) return target;
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v)) {
      target[k] = deepMerge(isPlainObject(target[k]) ? target[k] : {}, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Parses sizes like "256M", "1G", "512MB" into megabytes. */
export function parseSizeMb(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([MG])B?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return m[2].toUpperCase() === 'G' ? n * 1024 : n;
}
