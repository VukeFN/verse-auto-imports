# T9 case F: the import(...) module alias expression (book 16_modules,
# "Module Aliases with import"). Live UEFN accepts it, so these lines are
# written live rather than commented out (issue #71).
#
# What the file is for, and what to expect with the extension active:
#
# - T9Math aliases a path the file also imports. An alias binds one name to one
#   module and brings none of its members into scope, so the `using` is needed
#   as well: auto-import must re-add it when it is removed, rather than reading
#   the alias as an import already present.
# - T9Sub plus `using { T9Sub }` is the book's combined form. No "Use absolute
#   path" lens may appear on the `using` line - T9Sub names an alias, not a
#   module the workspace can be searched for.
# - Optimize Imports rebuilds the import block above the body, so both alias
#   lines end up BELOW the imports rather than where they started. That is
#   expected. What must hold is that each alias line is byte-identical
#   afterwards, and that neither is duplicated or rewritten.
#
# The prose above deliberately sits in the file header rather than above an
# individual import: a comment written directly above a `using` travels with
# that statement when the block is rebuilt, which would leave it describing a
# different import or nothing at all.

T9Math := import(/Verse.org/SpatialMath)
T9Sub := import(/vukefn@fortnite.com/VerseAutoImports/T9/Sub)

using { /Verse.org/SpatialMath }
using { T9Sub }

T9AliasProbe():vector3 = T9Math.vector3{X := 0.0, Y := 0.0, Z := 0.0}

T9AliasSubProbe():int = sub_thing{Value := 1}.Value
