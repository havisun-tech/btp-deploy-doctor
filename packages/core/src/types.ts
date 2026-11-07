export type Severity = 'error' | 'warning' | 'info';

export interface Location {
  /** Path relative to the project root. */
  file: string;
  /** 1-based line number. */
  line?: number;
}

/** Full new content of one file. `before: null` means the file is created. */
export interface FileChange {
  file: string;
  before: string | null;
  after: string;
}

export interface Fix {
  title: string;
  changes: FileChange[];
  /** Something the user must do afterwards, e.g. run npm install. */
  followUp?: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  fix?: string;
  location: Location;
  /** Mechanical fixes. More than one means alternatives; the user picks. */
  fixes?: Fix[];
}

export interface CheckResult {
  root: string;
  findings: Finding[];
  summary: Record<Severity, number>;
}
