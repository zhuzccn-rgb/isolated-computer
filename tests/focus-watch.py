"""Sample focus/pointer only on the explicitly supplied test display."""
import ctypes as C
import json
import signal
import sys
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
from bridge import X11
x=X11(sys.argv[1])
x.x.XDefaultRootWindow.argtypes=[C.c_void_p];x.x.XDefaultRootWindow.restype=C.c_ulong
x.x.XGetInputFocus.argtypes=[C.c_void_p,C.POINTER(C.c_ulong),C.POINTER(C.c_int)]
x.x.XQueryPointer.argtypes=[C.c_void_p,C.c_ulong,C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_uint)]
root=x.x.XDefaultRootWindow(x.d)
focus,revert=C.c_ulong(),C.c_int()
rr,child=C.c_ulong(),C.c_ulong();rx,ry,wx,wy=C.c_int(),C.c_int(),C.c_int(),C.c_int();mask=C.c_uint()
start=time.monotonic();samples=0;changes=[];running=True
def stop(*_):
 global running
 running=False
signal.signal(signal.SIGTERM,stop)
last=None
while running:
 x.x.XGetInputFocus(x.d,C.byref(focus),C.byref(revert))
 x.x.XQueryPointer(x.d,root,C.byref(rr),C.byref(child),C.byref(rx),C.byref(ry),C.byref(wx),C.byref(wy),C.byref(mask))
 state=(focus.value,rx.value,ry.value,mask.value)
 if state!=last:
  changes.append({'ms':round((time.monotonic()-start)*1000,3),'focus':state[0],'pointer':list(state[1:3]),'buttons':state[3]});last=state
 samples+=1;time.sleep(.005)
Path(sys.argv[2]).write_text(json.dumps({'nominalIntervalMs':5,'samples':samples,'durationMs':(time.monotonic()-start)*1000,'changes':changes}))
