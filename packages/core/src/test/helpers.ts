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

// ---------- Fiori app deployed through the managed approuter ----------

export const FIORI_MTA = CLEAN_MTA.replace(
  'resources:\n',
  `  - name: bookshop-app-content
    type: com.sap.application.content
    path: .
    requires:
      - name: bookshop-repo-host
        parameters:
          content-target: true
    build-parameters:
      build-result: resources
      requires:
        - artifacts:
            - comsapbookshopbrowse.zip
          name: comsapbookshopbrowse
          target-path: resources/
  - name: comsapbookshopbrowse
    type: html5
    path: app/browse
    build-parameters:
      build-result: dist
      builder: custom
      commands:
        - npm ci
        - npm run build:cf
      supported-platforms: []
  - name: bookshop-destination-content
    type: com.sap.application.content
    requires:
      - name: bookshop-destination
        parameters:
          content-target: true
      - name: bookshop-repo-host
        parameters:
          service-key:
            name: bookshop-repo-host-key
      - name: bookshop-auth
        parameters:
          service-key:
            name: bookshop-auth-key
    parameters:
      content:
        instance:
          destinations:
            - Name: bookshop_html_repo_host
              ServiceInstanceName: bookshop-html5-app-host-service
              ServiceKeyName: bookshop-repo-host-key
              sap.cloud.service: bookshop
            - Authentication: OAuth2UserTokenExchange
              Name: bookshop_uaa
              ServiceInstanceName: bookshop-xsuaa-service
              ServiceKeyName: bookshop-auth-key
              sap.cloud.service: bookshop
          existing_destinations_policy: ignore
    build-parameters:
      no-source: true
resources:
  - name: bookshop-repo-host
    type: org.cloudfoundry.managed-service
    parameters:
      service: html5-apps-repo
      service-name: bookshop-html5-app-host-service
      service-plan: app-host
  - name: bookshop-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
      config:
        HTML5Runtime_enabled: true
        init_data:
          instance:
            destinations:
              - Name: srv-api
                Type: HTTP
                URL: ~{srv-api/srv-url}
                ProxyType: Internet
                Authentication: NoAuthentication
                HTML5.ForwardAuthToken: true
            existing_destinations_policy: update
    requires:
      - name: srv-api
`,
).replace('      service: xsuaa\n', '      service: xsuaa\n      service-name: bookshop-xsuaa-service\n');

export const FIORI_FILES: Record<string, string | object> = {
  'mta.yaml': FIORI_MTA,
  'app/browse/package.json': {
    name: 'comsapbookshopbrowse',
    scripts: { 'build:cf': 'ui5 build preload --clean-dest --config ui5-deploy.yaml --include-task=generateCachebusterInfo' },
    devDependencies: { '@ui5/cli': '^4', 'ui5-task-zipper': '^3' },
  },
  'app/browse/ui5-deploy.yaml': `specVersion: '3.0'
metadata:
  name: com.sap.bookshop.browse
type: application
builder:
  resources:
    excludes:
      - /test/**
  customTasks:
    - name: ui5-task-zipper
      afterTask: generateCachebusterInfo
      configuration:
        archiveName: comsapbookshopbrowse
        additionalFiles:
          - xs-app.json
`,
  'app/browse/xs-app.json': {
    welcomeFile: '/index.html',
    authenticationMethod: 'route',
    routes: [
      { source: '^/odata/(.*)$', target: '/odata/$1', destination: 'srv-api', authenticationType: 'xsuaa', csrfProtection: false },
      { source: '^(.*)$', target: '$1', service: 'html5-apps-repo-rt', authenticationType: 'xsuaa' },
    ],
  },
  'app/browse/webapp/manifest.json': {
    'sap.app': {
      id: 'com.sap.bookshop.browse',
      dataSources: { mainService: { uri: 'odata/v4/catalog/', type: 'OData' } },
      crossNavigation: { inbounds: { 'Books-display': { semanticObject: 'Books', action: 'display', signature: { parameters: {}, additionalParameters: 'allowed' } } } },
    },
    'sap.cloud': { public: true, service: 'bookshop' },
  },
};

// ---------- multitenant CAP app with MTX sidecar ----------

export const MTX_PACKAGE = {
  name: 'saas',
  version: '1.0.0',
  dependencies: { '@sap/cds': '^9', '@sap/cds-mtxs': '^3', '@cap-js/hana': '^2', '@sap/xssec': '^4', express: '^4' },
  devDependencies: { '@sap/cds-dk': '^9' },
  engines: { node: '^20' },
  cds: { profile: 'with-mtx-sidecar', requires: { '[production]': { multitenancy: true, db: 'hana', auth: 'xsuaa' } } },
};

export const MTX_MTA = `_schema-version: '3.1'
ID: saas
version: 1.0.0
build-parameters:
  before-all:
    - builder: custom
      commands:
        - npx cds build --production
modules:
  - name: saas-srv
    type: nodejs
    path: gen/srv
    parameters:
      memory: 256M
    requires:
      - name: saas-db
      - name: saas-auth
    provides:
      - name: srv-api
        properties:
          srv-url: \${default-url}
  - name: saas-mtx
    type: nodejs
    path: gen/mtx/sidecar
    requires:
      - name: saas-db
      - name: saas-auth
    provides:
      - name: mtx-api
        properties:
          mtx-url: \${default-url}
  - name: saas
    type: approuter.nodejs
    path: app/router
    properties:
      TENANT_HOST_PATTERN: "^(.*)-\${default-uri}"
    requires:
      - name: srv-api
      - name: mtx-api
      - name: saas-auth
resources:
  - name: saas-db
    type: org.cloudfoundry.managed-service
    parameters:
      service: service-manager
      service-plan: container
  - name: saas-auth
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json
      config:
        xsappname: saas-\${org}-\${space}
        tenant-mode: shared
  - name: saas-registry
    type: org.cloudfoundry.managed-service
    requires:
      - name: mtx-api
    parameters:
      service: saas-registry
      service-plan: application
      config:
        xsappname: saas-\${org}-\${space}
        appName: saas-\${org}-\${space}
        displayName: saas
        appUrls:
          getDependencies: ~{mtx-api/mtx-url}/-/cds/saas-provisioning/dependencies
          onSubscription: ~{mtx-api/mtx-url}/-/cds/saas-provisioning/tenant/{tenantId}
`;

export const MTX_FILES: Record<string, string | object> = {
  'package.json': MTX_PACKAGE,
  'mta.yaml': MTX_MTA,
  'xs-security.json': { xsappname: 'saas', 'tenant-mode': 'shared' },
  'app/router/package.json': { name: 'approuter', dependencies: { '@sap/approuter': '^20' } },
  'app/router/xs-app.json': { routes: [] },
};
