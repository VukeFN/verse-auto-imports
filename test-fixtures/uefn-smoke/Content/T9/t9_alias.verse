# T9 case F: the import(...) module alias expression (book 16_modules,
# "Module Aliases with import"). Live UEFN accepts it, so these lines are
# written live rather than commented out. Expected with the extension active:
# neither alias line is moved, rewritten, or duplicated by auto-import,
# Optimize Imports, or saving, and the `using` below stays a `using` (issue
# #71).

T9Math := import(/Verse.org/SpatialMath)

# The combined form: the alias for qualified access, the `using` for
# unqualified. No "Use absolute path" lens may appear on the `using` line -
# T9Sub names an alias, not a module the workspace can be searched for.
T9Sub := import(/vukefn@fortnite.com/VerseAutoImports/T9/Sub)
using { T9Sub }

# An alias never substitutes for a `using`: it binds one name to one module and
# brings none of its members into scope. So this import is needed even though
# the file already aliases the same path, and the extension must not remove it
# or decline to add it.
using { /Verse.org/SpatialMath }

T9AliasProbe():vector3 = T9Math.vector3{X := 0.0, Y := 0.0, Z := 0.0}

T9AliasSubProbe():int = sub_thing{Value := 1}.Value
