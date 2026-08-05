# T9 cases A-C: relative import forms documented in the Book of Verse
# (16_modules, "Local and Relative Imports"). Uncomment ONE case at a time,
# push Verse changes, and record the verbatim outcome (clean compile or the
# exact diagnostic) via "Verse Auto Imports: Capture Diagnostics Corpus".
# Results gate the fix design for issue #65.

# Case A: bare same-directory module import (module folder T9/Sub)
# using { Sub }

# Case B: subdirectory path import
# using { Sub/Deep }

# Case C: sibling-folder import (Scripts is a sibling of T9)
# using { ../Scripts }

# Probe for case A (uncomment together with the case A import):
# T9GetSub():sub_thing = sub_thing{}

t9_relative_placeholder:int = 0
