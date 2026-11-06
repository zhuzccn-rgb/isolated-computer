"""Act like a window switcher on the private evaluation display (EWMH source=2)."""
import ctypes as C
import json
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
from bridge import X11
x=X11(sys.argv[1]);lib=x.x
lib.XDefaultRootWindow.argtypes=[C.c_void_p];lib.XDefaultRootWindow.restype=C.c_ulong
lib.XInternAtom.argtypes=[C.c_void_p,C.c_char_p,C.c_int];lib.XInternAtom.restype=C.c_ulong
lib.XGetWindowProperty.argtypes=[C.c_void_p,C.c_ulong,C.c_ulong,C.c_long,C.c_long,C.c_int,C.c_ulong,C.POINTER(C.c_ulong),C.POINTER(C.c_int),C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.POINTER(C.c_ubyte))]
lib.XFree.argtypes=[C.c_void_p]
root=lib.XDefaultRootWindow(x.d)
def property(window,name):
    atom=lib.XInternAtom(x.d,name.encode(),0)
    typ,fmt,count,after=C.c_ulong(),C.c_int(),C.c_ulong(),C.c_ulong();data=C.POINTER(C.c_ubyte)()
    lib.XGetWindowProperty(x.d,window,atom,0,100000,0,0,C.byref(typ),C.byref(fmt),C.byref(count),C.byref(after),C.byref(data))
    if not data:return []
    try:return list(C.cast(data,C.POINTER(C.c_ulong))[:count.value]) if fmt.value==32 else C.string_at(data,count.value).decode(errors='replace')
    finally:lib.XFree(data)
windows=property(root,'_NET_CLIENT_LIST')
target=next(((w,property(w,'_NET_WM_NAME')) for w in windows if sys.argv[2] in property(w,'_NET_WM_NAME')),None)
if not target:raise RuntimeError('Evaluation human window not found')
class MessageData(C.Union):_fields_=[('b',C.c_char*20),('s',C.c_short*10),('l',C.c_long*5)]
class Message(C.Structure):_fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',C.c_void_p),('window',C.c_ulong),('message_type',C.c_ulong),('format',C.c_int),('data',MessageData)]
class Event(C.Union):_fields_=[('message',Message),('pad',C.c_long*24)]
event=Event();event.message.type=33;event.message.display=x.d;event.message.window=target[0];event.message.message_type=lib.XInternAtom(x.d,b'_NET_ACTIVE_WINDOW',0);event.message.format=32;event.message.data.l[0]=2
lib.XSendEvent.argtypes=[C.c_void_p,C.c_ulong,C.c_int,C.c_long,C.POINTER(Event)]
lib.XSendEvent(x.d,root,0,(1<<20)|(1<<19),C.byref(event));lib.XFlush(x.d)
for _ in range(100):
    if property(root,'_NET_ACTIVE_WINDOW')==[target[0]]:break
    time.sleep(.01)
else:raise RuntimeError('Window manager did not activate the evaluation human window')
print(json.dumps({'humanWindow':target[0],'title':target[1],'activeWindow':property(root,'_NET_ACTIVE_WINDOW')[0]}))
