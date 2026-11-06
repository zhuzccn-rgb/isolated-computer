"""Real GTK3/GTK4 controls for AT-SPI state and lifecycle regression tests."""
import argparse
import json
from pathlib import Path
import gi

parser = argparse.ArgumentParser()
parser.add_argument('--gtk', choices=['3.0', '4.0'], required=True)
parser.add_argument('--state', required=True)
parser.add_argument('--commands', required=True)
args = parser.parse_args()
gi.require_version('Gtk', args.gtk)
from gi.repository import Gtk, GLib
gtk4 = args.gtk == '4.0'
if not gtk4:
    gi.require_version('Atk', '1.0')
    from gi.repository import Atk
state_path, command_path = Path(args.state), Path(args.commands)
state = {'clicks': 0, 'disabledClicks': 0, 'ancestorClicks': 0, 'dynamicClicks': 0, 'fallbackClicks': 0, 'command': None}
last_command = None
window = Gtk.Window(title='Native accessibility regressions ' + args.gtk)
window.set_default_size(640, 600)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
if gtk4:
    window.set_child(box)
else:
    window.add(box)

def append(parent, child):
    if gtk4: parent.append(child)
    else: parent.pack_start(child, False, False, 0)

def name(widget, label):
    if gtk4: widget.update_property([Gtk.AccessibleProperty.LABEL], [label])
    else: widget.get_accessible().set_name(label)

entry = Gtk.Entry(); name(entry, 'Regression input'); append(box, entry)
readonly = Gtk.Entry(); readonly.set_text('READONLY_SENTINEL'); readonly.set_editable(False)
name(readonly, 'Regression readonly'); append(box, readonly)
password = Gtk.PasswordEntry() if gtk4 else Gtk.Entry()
if gtk4: password.set_text('PASSWORD_SENTINEL')
else: password.set_visibility(False); password.set_text('PASSWORD_SENTINEL')
name(password, 'Regression password'); append(box, password)

def report(*_):
    allocation = custom.get_allocation()
    state.update(text=entry.get_text(), readonly=readonly.get_text(), dynamicEnabled=dynamic.get_sensitive(),
                 dynamicVisible=dynamic.get_visible(), dynamicPresent=dynamic.get_parent() is not None,
                 fallbackBounds={'x': allocation.x, 'y': allocation.y, 'width': allocation.width, 'height': allocation.height})
    state_path.write_text(json.dumps(state))

def clicked(_button, key):
    state[key] += 1
    report()

button = Gtk.Button(label='Regression click'); button.connect('clicked', clicked, 'clicks'); append(box, button)
disabled = Gtk.Button(label='Regression disabled'); disabled.set_sensitive(False)
disabled.connect('clicked', clicked, 'disabledClicks'); append(box, disabled)
parent = Gtk.Box(); parent.set_sensitive(False); append(box, parent)
ancestor = Gtk.Button(label='Regression disabled ancestor'); ancestor.connect('clicked', clicked, 'ancestorClicks'); append(parent, ancestor)
dynamic = Gtk.Button(label='Regression dynamic'); dynamic.connect('clicked', clicked, 'dynamicClicks'); append(box, dynamic)
custom = Gtk.Box(accessible_role=Gtk.AccessibleRole.BUTTON) if gtk4 else Gtk.EventBox()
custom.set_size_request(300, 48)
name(custom, 'Regression unsupported')
if not gtk4: custom.get_accessible().set_role(Atk.Role.PUSH_BUTTON)
if gtk4:
    gesture = Gtk.GestureClick(); gesture.connect('released', lambda *_: clicked(custom, 'fallbackClicks'))
    custom.add_controller(gesture)
else:
    custom.connect('button-press-event', lambda *_: clicked(custom, 'fallbackClicks'))
if gtk4: append(custom, Gtk.Label(label='Screenshot fallback target'))
else: custom.add(Gtk.Label(label='Screenshot fallback target'))
append(box, custom)
entry.connect('changed', report)

def commands():
    global last_command
    try: command = json.loads(command_path.read_text())
    except (OSError, ValueError): return True
    if command == last_command: return True
    last_command = command
    operation = command['operation']
    if operation == 'disable': dynamic.set_sensitive(False)
    elif operation == 'enable': dynamic.set_sensitive(True)
    elif operation == 'hide': dynamic.set_visible(False)
    elif operation == 'show': dynamic.set_visible(True)
    elif operation == 'remove': box.remove(dynamic)
    state['command'] = command['id']; report()
    return True

if gtk4:
    window.present(); loop = GLib.MainLoop(); window.connect('close-request', lambda *_: loop.quit())
else:
    window.show_all(); loop = GLib.MainLoop(); window.connect('destroy', lambda *_: loop.quit())
report(); GLib.timeout_add(50, commands); loop.run()
