"""Read-only focus/pointer probe for the simulated human display."""
import ctypes as C
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
from bridge import X11

x=X11(sys.argv[1])
x.x.XDefaultRootWindow.argtypes=[C.c_void_p]
x.x.XDefaultRootWindow.restype=C.c_ulong
x.x.XGetInputFocus.argtypes=[C.c_void_p,C.POINTER(C.c_ulong),C.POINTER(C.c_int)]
focus,revert=C.c_ulong(),C.c_int()
x.x.XGetInputFocus(x.d,C.byref(focus),C.byref(revert))
root,child=C.c_ulong(),C.c_ulong()
rx,ry,wx,wy=C.c_int(),C.c_int(),C.c_int(),C.c_int()
mask=C.c_uint()
x.x.XQueryPointer.argtypes=[C.c_void_p,C.c_ulong,C.POINTER(C.c_ulong),C.POINTER(C.c_ulong),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_uint)]
x.x.XQueryPointer(x.d,x.x.XDefaultRootWindow(x.d),C.byref(root),C.byref(child),C.byref(rx),C.byref(ry),C.byref(wx),C.byref(wy),C.byref(mask))
print(json.dumps({'focus':focus.value,'pointer':[rx.value,ry.value],'buttons':mask.value}))
