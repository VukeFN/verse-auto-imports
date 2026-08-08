# Scope regression (issue #96): this file is open but unfocused. Under the
# activeFile scope the debounced auto-import must leave it alone.

r96_background_device := class:
    var MaybeButton:?button_device = false
