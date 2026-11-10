// The xs-security.json model lives in the core package, so the MCP server can use it too.
export {
  PREFIX, localName, TEMPLATE_NAME, SCOPE_NAME, parseDescriptor, effectiveDescriptor, applyEdit, EditError,
  roleStatus, attributeStatus, issues, generateDescriptor, analyzeToken,
} from 'btp-deploy-doctor';
export type { Scope, Template, Collection, Attribute, Descriptor, Edit, RoleStatus, AttributeStatus, Issue, TokenReport } from 'btp-deploy-doctor';
