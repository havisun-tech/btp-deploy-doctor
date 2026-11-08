---
name: Wrong or missing finding
about: A check reported something that is fine, missed a real problem, or a fix did the wrong thing
labels: rules
---

**Rule ID** (for example MTA005, UI008):

**What happened**
<!-- The finding or fix, copied from the Problems panel or `btp-doctor check` output. -->

**What you expected**

**Project setup**
<!-- The relevant part of mta.yaml, package.json or manifest.json. Remove secrets, passwords and service keys. -->

```yaml

```

**Did the deployment actually work or fail?**
<!-- This tells us whether the rule is wrong or right. Include the cf deploy error if it failed. -->

**Versions**
- Deploy Doctor for SAP BTP:
- @sap/cds:
- Editor: VS Code / BAS / CLI / MCP
