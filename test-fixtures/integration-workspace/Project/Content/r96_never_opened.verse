# Scope regression (issue #96): never opened in a tab by the test. Diagnostics
# are set on its uri directly, the way the Verse LSP publishes them
# project-wide, so the openFiles scope must leave it unedited.

r96_never_opened_device := class:
    var MaybeButton:?button_device = false
