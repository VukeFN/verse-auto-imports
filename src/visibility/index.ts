// From outside this module, take the provider and the writer: the provider
// recognizes the diagnostic and the writer applies the change. Everything else
// here is their pure collaborators - the message parser, the marking rule, the
// declaration finder, the resolution step and the definitions renderer - and is
// exported for its own tests, not for callers.
export { ModuleVisibilityCodeActionProvider } from "./ModuleVisibilityCodeActionProvider";
export { ModuleVisibilityWriter } from "./ModuleVisibilityWriter";
export { parseModuleVisibilityMessage, ModuleVisibilityRequest } from "./ModuleVisibilityMessage";
export { planVisibility, toContentSegments, VisibilityPlan, VisibilitySegment } from "./ModuleVisibilityPlanner";
export { findExplicitModuleDeclarations, ModuleDeclaration } from "./moduleDeclarations";
export { resolveVisibility, FoundDeclaration, ResolvedVisibility } from "./visibilityResolution";
export { buildDeclarationBlock, appendDeclarationBlock, DeclarationSpec } from "./definitionsContent";
