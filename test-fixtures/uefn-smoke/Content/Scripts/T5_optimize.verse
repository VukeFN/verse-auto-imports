# T5: Optimize Imports command (issue #42 atomic rewrite) plus the 0.6.3 and
# 0.6.4 local-scope regressions.
#
# This file deliberately contains: a duplicate import, imports scattered
# mid-file, a missing import (fort_character, single-option suggestion), a
# local-scope using inside a function body, and an indented-style using block
# at the bottom.
#
# Run "Verse Auto Imports: Optimize Imports" with general.autoImport ON, then
# again on a re-synced copy with it OFF. Expected in both cases, as ONE atomic
# edit:
#   - all module imports consolidated at the top, deduplicated
#   - using { /Fortnite.com/Characters } ADDED (from the fort_character
#     diagnostic; must be single-option so optimize can apply it)
#   - the indented "using:" block absorbed into the top block
#   - the local-scope "using { Helper }" inside Describe() left untouched
#   - no code between the scattered imports deleted
#   - success toast only if the above actually happened

using { /Verse.org/Simulation }

t5_helper := class:
    GetLabel<public>():string = "t5"

using { /Fortnite.com/Devices }
using { /Verse.org/Simulation }

t5_device := class(creative_device):
    var MaybeCharacter:?fort_character = false

    Describe(Helper:t5_helper):string =
        using { Helper }
        Helper.GetLabel()

using:
    /Fortnite.com/Playspaces
