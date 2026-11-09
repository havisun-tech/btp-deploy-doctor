# Changelog

## 0.1.0 (preview)

First release.

- Visual editor for xs-security.json with Roles, Role collections, Attributes, Settings, Checks and Token tabs. Edits go through the document, so Undo works and formatting is kept.
- Compares the descriptor with the roles and `$user` attributes in the CDS model, including values that mta.yaml adds at deploy.
- Creates xs-security.json from the CDS model.
- Runs the Deploy Doctor checks for roles and login, with one-click fixes.
- Decodes tokens locally and explains which CDS roles they grant.
- Prepares "cf update-service" for the bound XSUAA instance.
- AMS policies view for apps on Identity Authentication (IAS): roles and the policies that give them, policies by package, schema attributes and their CDS mappings, checks with one-click fixes, and an IAS token explainer.
- Syntax highlighting for `.dcl` files.
