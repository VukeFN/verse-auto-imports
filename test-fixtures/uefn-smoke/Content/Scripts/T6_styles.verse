# T6: syntax style, grouping, and sorting settings matrix.
#
# Starting state: braced imports, unsorted, one local (project) import mixed
# with digest imports. Walk the playbook steps flipping:
#   behavior.importSyntax (curly <-> dot)
#   behavior.importGrouping (none / digestFirst / localFirst)
#   behavior.sortImportsAlphabetically
# and run "Verse Auto Imports: Optimize Imports" after each flip. Verify
# layout matches the setting and that repeated runs are idempotent.

using { /Verse.org/Simulation }
using { /Fortnite.com/Devices }
using { Gadgets.Tools }
using { /Verse.org/Colors }

t6_marker := class:
    Tag:string = "t6"
