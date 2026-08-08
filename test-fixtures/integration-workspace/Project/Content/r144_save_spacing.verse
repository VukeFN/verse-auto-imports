# Regression #144: the file-top import block is deliberately NOT followed by a
# blank line, so the on-save spacing pass always has an edit to make. The
# pre-fix code made that edit after the save had already completed, which left
# the tab dirty the instant the user saved it.

using { /Fortnite.com/Devices }
r144_save_spacing := class:
    var MaybeButton:?button_device = false
