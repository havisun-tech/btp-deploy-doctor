export interface LogPattern {
  id: string;
  title: string;
  /** Matched per line, case-insensitive. Capture groups can be used as $1, $2 in explanation and fix. */
  regex: RegExp;
  explanation: string;
  fix: string;
  /** Catch-all: only reported for lines that no specific pattern explains. */
  generic?: boolean;
}

/**
 * Known SAP BTP / CAP failure signatures. Order matters: specific patterns first.
 * Add new ones here together with a test in test/logs.test.ts.
 */
export const LOG_PATTERNS: LogPattern[] = [
  {
    id: 'auth-not-bound',
    title: 'Auth service not bound',
    regex: /Authentication kind "?(xsuaa|ias|jwt)"? configured, but no .*instance bound/i,
    explanation: 'CAP is configured for "$1" authentication, but no matching service instance is bound to the app.',
    fix: 'On Cloud Foundry: add the auth resource under the service module\'s "requires" in mta.yaml. Locally: use "mocked" auth outside [production], or run "cds bind -2 <instance>" and "cds watch --profile hybrid".',
  },
  {
    id: 'hdi-build-plugin',
    title: 'Unsupported HDI build plugin',
    regex: /could not find the "?(com\.sap\.hana\.di\.[\w.]+)"? build plugin/i,
    explanation: 'db/src/.hdiconfig declares the plugin "$1", which this HANA version does not provide. The usual cause is an old .hdiconfig with "hdbcds" on HANA Cloud.',
    fix: 'Set "cds": { "requires": { "db": { "kind": "hana", "deploy-format": "hdbtable" } } }, delete the stale .hdiconfig, then run "npx cds build --production" again.',
  },
  {
    id: 'hdi-incompatible-change',
    title: 'Incompatible table change',
    regex: /cannot (?:change|alter) (?:the )?(?:data )?type|SQL error 7: feature not supported/i,
    explanation: 'The HDI deployer cannot apply a model change, such as a changed column type, to a table that already has data.',
    fix: 'Annotate the entity with @cds.persistence.journal to use migration tables, or migrate the data manually. In a disposable dev space you can drop and recreate the HDI container.',
  },
  {
    id: 'hdi-duplicate-key',
    title: 'Duplicate key in deployed data',
    regex: /unique constraint violated|duplicate key/i,
    explanation: 'Initial data (db/data/*.csv) contains rows with the same key, or conflicts with rows already in the table.',
    fix: 'Check the CSV files for duplicate key values. Remember CSV files from imported packages are deployed too.',
  },
  {
    id: 'hdi-privilege',
    title: 'Insufficient privilege during HDI deploy',
    regex: /insufficient privilege|SQL error 258/i,
    explanation: 'The HDI container user lacks privileges, usually for accessing another container or a classic schema.',
    fix: 'Add an .hdbgrants file and bind the user-provided or HDI service that owns the objects to the db-deployer module.',
  },
  {
    id: 'hana-no-instance',
    title: 'No HANA Cloud instance available',
    regex: /(?:No|Could not find (?:a|any)) (?:SAP )?HANA (?:Cloud )?(?:database )?instance/i,
    explanation: 'The hdi-shared service needs a running SAP HANA Cloud instance that is mapped to your Cloud Foundry org and space.',
    fix: 'In SAP HANA Cloud Central, create or start an instance and add an instance mapping for this org/space, or pass "database_id" in the HDI container parameters.',
  },
  {
    id: 'hana-unreachable',
    title: 'HANA Cloud unreachable',
    regex: /(?:hanacloud|hana).{0,200}(?:ECONNREFUSED|ETIMEDOUT|socket (?:closed|hang up)|connection refused)|(?:ECONNREFUSED|ETIMEDOUT|socket (?:closed|hang up)|connection refused).{0,200}(?:hanacloud|hana)/i,
    explanation: 'The connection to SAP HANA Cloud failed. Trial and free-tier instances stop automatically every night, and the allowed-connections list can block Cloud Foundry.',
    fix: 'Start the instance in SAP HANA Cloud Central and check "Allowed connections" includes SAP BTP (or all IP addresses for testing), then redeploy.',
  },
  {
    id: 'service-offering-missing',
    title: 'Service or plan not available',
    regex: /service offering ['"]?([\w-]+)['"]? (?:not found|does not exist)|Could not find service offering|service plan ['"]?([\w-]+)['"]? .*not (?:found|available)/i,
    explanation: 'The subaccount has no entitlement for this service or plan, or it is not available in this region.',
    fix: 'In the BTP cockpit, open your subaccount > Entitlements and add the service plan (for HANA: "SAP HANA Schemas & HDI Containers", plan hdi-shared).',
  },
  {
    id: 'service-name-taken',
    title: 'Service instance name already taken',
    regex: /service instance name is taken|service instance .* already exists/i,
    explanation: 'A service instance with the same name exists in this space, often created by another MTA or by hand.',
    fix: 'Delete the old instance, or give the resource a different "service-name" parameter in mta.yaml.',
  },
  {
    id: 'service-not-found',
    title: 'Referenced service instance not found',
    regex: /service (?:instance )?["']?([^"'\s]+)["']? (?:was )?not found/i,
    explanation: 'The deployment references the service instance "$1", which does not exist in this space.',
    fix: 'Check that the resource name or "service-name" in mta.yaml matches an existing instance. If you see a literal ${...}, the placeholder was not resolved: use an explicit name.',
  },
  {
    id: 'xsappname-conflict',
    title: 'xsappname conflict',
    regex: /xsappname.*(?:invalid|already|not unique|exists)/i,
    explanation: 'The xsappname in xs-security.json must be unique in the subaccount and use only allowed characters.',
    fix: 'Make it unique per space, for example in mta.yaml: config: { xsappname: my-app-${org}-${space} }.',
  },
  {
    id: 'package-json-missing',
    title: 'Module has no package.json',
    regex: /ENOENT: no such file or directory, open '\/home\/vcap\/app\/package\.json'/i,
    explanation: 'The pushed module folder contains no package.json. Typically the module path is gen/srv but "cds build" did not run first.',
    fix: 'Add a before-all step running "npx cds build --production" to mta.yaml, and check the module path.',
  },
  {
    id: 'module-not-found',
    title: 'Module missing at runtime',
    regex: /Cannot find module '([^']+)'/i,
    explanation: 'The deployed app requires "$1", which is not installed. Cloud Foundry only installs "dependencies", not "devDependencies".',
    fix: 'Move "$1" to dependencies in package.json, then rebuild (cds build copies package.json into gen/srv).',
  },
  {
    id: 'cds-not-found',
    title: 'cds command not found during build',
    regex: /(?:^|\s|:)cds: (?:command )?not found|'cds' is not recognized/i,
    explanation: 'The MTA build ran "cds build", but @sap/cds-dk is not installed on the build machine.',
    fix: 'Use "npx cds build --production" in before-all and add @sap/cds-dk to devDependencies.',
  },
  {
    id: 'npm-sap-registry',
    title: 'Old SAP npm registry',
    regex: /npm\.sap\.com/i,
    explanation: 'The npm.sap.com registry is retired. All @sap packages are on the public npm registry.',
    fix: 'Remove "@sap:registry=https://npm.sap.com" from .npmrc and regenerate package-lock.json.',
  },
  {
    id: 'npm-version-missing',
    title: 'npm package version not found',
    regex: /\bETARGET\b|No matching version found for (\S+)/i,
    explanation: 'package.json or package-lock.json asks for a version that does not exist on the registry.',
    fix: 'Pin an existing version and run "npm install" to regenerate package-lock.json.',
  },
  {
    id: 'npm-eresolve',
    title: 'npm peer dependency conflict',
    regex: /ERESOLVE (?:unable to resolve|could not resolve)/i,
    explanation: 'Two packages need incompatible versions of a shared dependency, usually @sap/cds versus a CAP plugin.',
    fix: 'Align @sap/cds and @cap-js/* plugins to the same major version. Use --legacy-peer-deps only as a last resort.',
  },
  {
    id: 'health-check',
    title: 'Health check timed out',
    regex: /health check never passed|failed to accept connections within health check timeout|Timed out after .* health check|Instance never healthy/i,
    explanation: 'The app did not listen on $PORT in time. Either it crashed during startup or startup is slower than the timeout.',
    fix: 'Look for an error just before this line. If startup is just slow, set "health-check-timeout: 180" under the module parameters.',
  },
  {
    id: 'out-of-memory',
    title: 'Out of memory',
    regex: /exceeded (?:its )?memory (?:limit|quota)|JavaScript heap out of memory|status 137|memory quota exceeded/i,
    explanation: 'The app instance used more memory than its quota and was killed.',
    fix: 'Raise "memory" for the module in mta.yaml (CAP services usually need 256M or more), or check for unbounded queries loading large result sets.',
  },
  {
    id: 'disk-quota',
    title: 'Disk quota exceeded',
    regex: /disk quota exceeded|No space left on device|exceeded (?:its )?disk/i,
    explanation: 'The app or staging exceeded its disk quota, often because of a large node_modules folder.',
    fix: 'Raise "disk-quota" for the module, and exclude node_modules from the upload with build-parameters: ignore: ["node_modules/"].',
  },
  {
    id: 'app-too-large',
    title: 'Upload too large',
    regex: /maximum (?:application|app|package) size|413 Request Entity Too Large|Upload of application content failed/i,
    explanation: 'The module upload is larger than Cloud Foundry allows, usually because node_modules or test data was included.',
    fix: 'Add build-parameters: ignore: ["node_modules/", "test/"] to the module in mta.yaml, or a .cfignore file.',
  },
  {
    id: 'destination-not-found',
    title: 'Destination not found',
    regex: /(?:Failed to (?:load|fetch|get) destination|Unable to find (?:a )?destination|destination .*(?:not found|could not be found))/i,
    explanation: 'The destination name in cds.requires.<service>.credentials.destination does not exist, or the destination service is not bound.',
    fix: 'Check the name in BTP cockpit > Connectivity > Destinations (case-sensitive), and bind the destination service to the app.',
  },
  {
    id: 'onprem-connection',
    title: 'On-premise connection failed',
    regex: /(?:ECONNRESET|socket hang up|ECONNREFUSED).*(?:destination|connectivity|proxy|:20003)|(?:destination|connectivity|proxy).*(?:ECONNRESET|socket hang up|ECONNREFUSED)/i,
    explanation: 'A call through the Cloud Connector failed. Locally, on-premise destinations are not reachable without the connectivity proxy.',
    fix: 'Check that the Cloud Connector is connected, the virtual host/port and resource path are exposed, and the location ID matches. The connectivity service must be bound. For local tests, deploy or tunnel with "cf ssh".',
  },
  {
    id: 'auth-forbidden',
    title: 'Request rejected (401/403)',
    regex: /\b(?:401|403)\b.*(?:Unauthorized|Forbidden)|(?:Unauthorized|Forbidden).*\b(?:401|403)\b/i,
    explanation: 'The caller is not logged in or lacks a required scope.',
    fix: 'Check that the user has a role collection containing the roles from xs-security.json, and that the approuter route uses authenticationType "xsuaa".',
  },
  {
    id: 'sqlite-busy',
    title: 'SQLite database locked',
    regex: /SQLITE_BUSY|database is locked/i,
    explanation: 'SQLite allows only one writer at a time. Parallel writes, for example from Promise.all in a data loader, collide.',
    fix: 'Run the writes sequentially, or inside one transaction.',
  },
  {
    id: 'port-in-use',
    title: 'Port already in use',
    regex: /EADDRINUSE.*?:(\d+)/i,
    explanation: 'Another process already listens on port $1, typically an earlier "cds watch".',
    fix: 'Stop the other process, or start on another port: PORT=4005 cds watch',
  },
  {
    id: 'broker-error',
    title: 'Service broker error',
    regex: /Service broker error/i,
    explanation: 'The service broker rejected the create or update request. The text after "Service broker error" explains why.',
    fix: 'Read the broker message on this line. For XSUAA it is usually a problem in xs-security.json (scopes, role templates, xsappname).',
    generic: true,
  },
  {
    id: 'hdi-deploy-failed',
    title: 'HDI deployment failed',
    regex: /Deployment to container .* failed|HDI make failed|Error: .*com\.sap\.hana\.di\./i,
    explanation: 'The HDI deployer reported an error. The specific cause is usually a few lines above this one.',
    fix: 'Read the deployer log in full: cf logs <app>-db-deployer --recent',
    generic: true,
  },
  {
    id: 'app-crashed',
    title: 'App crashed during start',
    regex: /Error starting application "([^"]+)": Some instances have crashed/i,
    explanation: 'Cloud Foundry started "$1", but it exited. The reason is in the app\'s own logs, not in the deploy output.',
    fix: 'Explain the app logs: btp-doctor diagnose --app $1',
    generic: true,
  },
];
