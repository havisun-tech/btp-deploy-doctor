# Changelog

## 0.2.1 (preview)

- Added links to the product page and guide on havisun.com.

## 0.2.0 (preview)

- Role checks: roles used in `@requires` and `@restrict` must exist as scopes and be granted by a role template in xs-security.json; role templates and role collections must reference scopes, templates and attributes that exist; `$user` attributes in `where` conditions must be defined. Most come with a one-click fix that keeps the file's formatting.
- Login checks: the approuter must be bound to XSUAA when its routes require login, and destinations to the CAP service must forward the user's token (standalone and managed approuter).
- AMS policy checks for CAP apps on Identity Authentication (IAS): roles no policy assigns, misspelled roles, unknown policies and attributes, duplicate policies, `@sap/ams` as a runtime dependency, and a module that deploys the policies. Validated against SAP's DCL compiler and the AMS sample project.
- Work Zone checks: `sap.cloud.public` and a navigation inbound in manifest.json.
- Sizing and cost hints: unusually large memory, a HANA Cloud database created by the MTA, paid application logging plans.
- Log explanations for 401 and 403 errors: missing role (with the role name), missing scope, token not forwarded, token from another XSUAA instance, expired token, CSRF token, login redirect, and XSUAA rejecting xs-security.json.

## 0.1.1 (preview)

- Renamed to "Deploy Doctor for SAP BTP". The extension ID and settings are unchanged, so existing installs update normally.
- Added a demo animation to the Marketplace page.
- Added a trademark notice: this extension is not affiliated with or endorsed by SAP SE.

## 0.1.0 (preview)

First release.

- Checks for mta.yaml, CAP configuration, Fiori apps in the HTML5 application repository and multitenant (MTX) apps.
- One-click fixes and Fix All, with Undo support and formatting kept.
- Explains cf deploy, cf logs, MTA operation, npm, HDI and UI5 build errors.
