# Scope regression (issue #96): open in a tab but not focused. Under the
# openFiles scope the auto-import must still land here, which is what proves
# the tab uris match the uris diagnostics arrive on.

r96_open_unfocused_device := class:
    var MaybeButton:?button_device = false
