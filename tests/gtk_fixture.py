import argparse
import json
from pathlib import Path
import gi
gi.require_version('Gtk','3.0')
from gi.repository import Gtk

parser=argparse.ArgumentParser()
parser.add_argument('--state',required=True)
parser.add_argument('--sentinel',default='')
args=parser.parse_args()
window=Gtk.Window(title='Isolated native accessibility fixture')
window.set_default_size(640,400)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=16)
window.add(box)
entry=Gtk.Entry()
entry.get_accessible().set_name('Native form input')
entry.set_text(args.sentinel)
button=Gtk.Button(label='Count clicks')
button.get_accessible().set_name('Count clicks')
label=Gtk.Label(label='0')
box.pack_start(entry,False,False,10)
box.pack_start(button,False,False,10)
box.pack_start(label,False,False,10)
state={'text':args.sentinel,'clicks':0}
def report(*_):
    state['text']=entry.get_text()
    Path(args.state).write_text(json.dumps(state))
def click(*_):
    state['clicks']+=1
    label.set_text(str(state['clicks']))
    report()
entry.connect('changed',report)
button.connect('clicked',click)
window.connect('destroy',Gtk.main_quit)
window.show_all()
report()
Gtk.main()
