import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const CLEAN_PACKAGE = {
  name: 'bookshop',
  version: '1.0.0',
  dependencies: { '@sap/cds': '^9', '@cap-js/hana': '^2', '@sap/xssec': '^4', express: '^4' },
  devDependencies: { '@sap/cds-dk': '^9', '@cap-js/sqlite': '^2' },
  engines: { node: '^20' },
  cds: { requires: { '[production]': { db: 'hana', auth: 'xsuaa' } } },
};

export const CLEAN_MTA = `_schema-version: '3.1'
ID: bookshop
version: 1.0.0
build-parameters:
  before-all:
    - builder: custom
      commands:
        - npx cds build --production
modules:
  - name: bookshop-srv
    type: nodejs
    path: gen/srv
    parameters:
      memory: 256M
    requires:
      - name: bookshop-db
      - name: bookshop-auth
    provides:
      - name: srv-api
        properties:
          srv-url: \${default-url}
  - name: bookshop-db-deployer
    type: hdb
    path: gen/db
    requires:
      - name: bookshop-db
resources:
  - name: bookshop-db
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared
  - name: bookshop-auth
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json
`;

/** Writes a project to a temp dir. `null` deletes a default file. */
export function makeProject(files: Record<string, string | object | null> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btp-doctor-test-'));
  const all: Record<string, string | object | null> = {
    'package.json': CLEAN_PACKAGE,
    'mta.yaml': CLEAN_MTA,
    'xs-security.json': '{}',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

export const pkg = (patch: (p: any) => void) => {
  const p = JSON.parse(JSON.stringify(CLEAN_PACKAGE));
  patch(p);
  return p;
};
