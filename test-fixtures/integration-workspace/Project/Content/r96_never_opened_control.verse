# Scope regression (issue #96): the control for r96_never_opened.verse. Under
# the default allFiles scope the extension does open this one, which is what
# makes the restricted-scope assertion meaningful rather than vacuous.

r96_never_opened_control_device := class:
    var MaybeButton:?button_device = false
