# Changelog

## 0.1.1 (preview)

- Screenshots in the README.

## 0.1.0 (preview)

First release.

- Checks every destination a deployed app can use, with the same lookup the app makes at runtime: does it exist, and does the Destination service get its OAuth token or credentials.
- Finds destinations that the CAP project uses (cds.requires) but that do not exist, and suggests similar names.
- Checks the configuration: URL, ProxyType, required properties for each authentication type, OnPremise destinations without a Connectivity service binding, https:// on OnPremise destinations, internal hosts on Internet destinations, and missing key store certificates.
- Explains token errors (wrong client, rejected user token, unknown host, TLS) and HTTP answers of test calls.
- "Call from here" sends a test request to Internet destinations with the credentials the Destination service returns. Optional path, e.g. $metadata.
- Tests token exchange (OAuth2UserTokenExchange, OAuth2JWTBearer, OAuth2SAMLBearerAssertion) with a pasted user token.
- Also available as a command-line check: "btp-doctor connectivity --app <name>".
