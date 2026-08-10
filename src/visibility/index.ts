// From outside this module, take the provider and the writer: the provider
// recognizes the diagnostic and the writer applies the change. Their pure
// collaborators - the message parser, the marking rule, the declaration finder,
// the resolution step and the definitions renderer - have no caller outside
// them, and their tests import them directly.
export { ModuleVisibilityCodeActionProvider } from "./ModuleVisibilityCodeActionProvider";
export { ModuleVisibilityWriter } from "./ModuleVisibilityWriter";
export { ModuleVisibilityRequest } from "./ModuleVisibilityMessage";
