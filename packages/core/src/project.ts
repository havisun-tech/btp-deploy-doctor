import * as fs from 'fs';
import * as path from 'path';
import { Document, LineCounter, parseDocument } from 'yaml';
import { resolveProfiles } from './cds-config';
import { deepMerge, isPlainObject, lineAt } from './util';

export interface ParseError {
  message: string;
  line?: number;
}

export interface YamlFile {
  rel: string;
  text: string;
  doc: Document;
  data: Record<string, any>;
  lineCounter: LineCounter;
  errors: ParseError[];
}

export interface JsonFile {
  rel: string;
  text: string;
  data: Record<string, any>;
  error?: ParseError;
}

/** Read-only view of a CAP / MTA project on disk. */
export class Project {
  readonly root: string;
  readonly mta?: YamlFile;
  readonly packageJson?: JsonFile;
  readonly cdsrc?: JsonFile;
  readonly cdsrcPrivate?: JsonFile;

  constructor(root: string) {
    this.root = path.resolve(root);
    const mtaRel = ['mta.yaml', 'mta.yml'].find((f) => this.exists(f));
    if (mtaRel) this.mta = this.readYaml(mtaRel);
    this.packageJson = this.readJson('package.json');
    this.cdsrc = this.readJson('.cdsrc.json');
    this.cdsrcPrivate = this.readJson('.cdsrc-private.json');
  }

  private jsonCache = new Map<string, JsonFile | undefined>();
  private yamlCache = new Map<string, YamlFile | undefined>();

  /** Any JSON file in the project (cached). */
  json(rel: string): JsonFile | undefined {
    const key = rel.replace(/^\.\//, '');
    if (!this.jsonCache.has(key)) this.jsonCache.set(key, this.readJson(key));
    return this.jsonCache.get(key);
  }

  /** Any YAML file in the project (cached). */
  yaml(rel: string): YamlFile | undefined {
    const key = rel.replace(/^\.\//, '');
    if (!this.yamlCache.has(key)) this.yamlCache.set(key, this.exists(key) ? this.readYaml(key) : undefined);
    return this.yamlCache.get(key);
  }

  abs(rel: string): string {
    return path.resolve(this.root, rel);
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }

  readText(rel: string): string | undefined {
    try {
      return fs.readFileSync(this.abs(rel), 'utf8');
    } catch {
      return undefined;
    }
  }

  get dependencies(): Record<string, string> {
    const d = this.packageJson?.data.dependencies;
    return isPlainObject(d) ? d : {};
  }

  get devDependencies(): Record<string, string> {
    const d = this.packageJson?.data.devDependencies;
    return isPlainObject(d) ? d : {};
  }

  /** Version of a package installed in node_modules, if any. */
  installedVersion(name: string): string | undefined {
    const text = this.readText(`node_modules/${name}/package.json`);
    if (!text) return undefined;
    try {
      const v = JSON.parse(text).version;
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /** True when this looks like a CAP project. */
  get isCap(): boolean {
    return (
      '@sap/cds' in this.dependencies ||
      '@sap/cds' in this.devDependencies ||
      isPlainObject(this.packageJson?.data.cds) ||
      !!this.cdsrc
    );
  }

  /** Raw CAP config: .cdsrc.json overlaid with package.json#cds. */
  get cdsRaw(): Record<string, any> {
    const merged = deepMerge({}, this.cdsrc?.data ?? {});
    return deepMerge(merged, this.packageJson?.data.cds ?? {});
  }

  /** Extra profiles the project always activates (cds.profile / cds.profiles). */
  get cdsProfiles(): string[] {
    const raw = this.cdsRaw;
    const list = Array.isArray(raw.profiles) ? raw.profiles : typeof raw.profile === 'string' ? [raw.profile] : Array.isArray(raw.profile) ? raw.profile : [];
    return list.filter((x: unknown): x is string => typeof x === 'string');
  }

  cdsFor(profile: string): any {
    return resolveProfiles(this.cdsRaw, [...this.cdsProfiles, profile]);
  }

  /** Where CAP config lives, for pointing findings at it. */
  cdsConfigLocation(): { file: string; line?: number } {
    if (this.packageJson && isPlainObject(this.packageJson.data.cds)) {
      return { file: 'package.json', line: this.jsonKeyLine(this.packageJson, 'cds') };
    }
    if (this.cdsrc) return { file: this.cdsrc.rel, line: 1 };
    return { file: 'package.json', line: 1 };
  }

  /** 1-based line of a node in mta.yaml (or another YAML file), e.g. ['modules', 0, 'path']. */
  yamlLine(nodePath: (string | number)[], file: YamlFile | undefined = this.mta): number | undefined {
    if (!file) return undefined;
    const node: any = file.doc.getIn(nodePath, true);
    const range: number[] | undefined = node?.range;
    if (!range) return undefined;
    return file.lineCounter.linePos(range[0]).line;
  }

  /** Approximate 1-based line of a (nested) key in a JSON file. */
  jsonKeyLine(file: JsonFile, ...keys: string[]): number | undefined {
    let pos = 0;
    let idx = -1;
    for (const k of keys) {
      idx = file.text.indexOf(JSON.stringify(k), pos);
      if (idx < 0) return undefined;
      pos = idx + 1;
    }
    return idx < 0 ? undefined : lineAt(file.text, idx);
  }

  private readYaml(rel: string): YamlFile {
    const text = this.readText(rel) ?? '';
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter });
    const errors: ParseError[] = doc.errors.map((e) => ({
      message: e.message.split('\n')[0],
      line: e.linePos?.[0]?.line,
    }));
    let data: unknown = {};
    if (errors.length === 0) {
      try {
        data = doc.toJS();
      } catch (e: any) {
        errors.push({ message: String(e?.message ?? e) });
      }
    }
    return { rel, text, doc, data: isPlainObject(data) ? data : {}, lineCounter, errors };
  }

  private readJson(rel: string): JsonFile | undefined {
    const text = this.readText(rel);
    if (text === undefined) return undefined;
    try {
      const data = JSON.parse(text);
      return { rel, text, data: isPlainObject(data) ? data : {} };
    } catch (e: any) {
      const m = /position (\d+)/.exec(String(e?.message));
      return {
        rel,
        text,
        data: {},
        error: { message: String(e?.message ?? e), line: m ? lineAt(text, Number(m[1])) : undefined },
      };
    }
  }
}
