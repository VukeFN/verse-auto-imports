# Config regression (issue #77): a bare unknown identifier covered by a
# configured behavior.ambiguousImports mapping must auto-import the mapped path.

r77_probe := class:
    var Position:vector3 = vector3{}
