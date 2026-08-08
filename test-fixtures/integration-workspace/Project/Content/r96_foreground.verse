# Scope regression (issue #96): opened last so it holds focus, which makes
# r96_background.verse the unfocused file the scope must protect.

r96_foreground_device := class:
    var MaybeButton:?button_device = false
