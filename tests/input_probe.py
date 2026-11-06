"""Read held keys and pointer masks on an explicitly supplied private display."""
import ctypes as C
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
from bridge import X11
x = X11(sys.argv[1])
x.x.XQueryKeymap.argtypes = [C.c_void_p, C.POINTER(C.c_ubyte)]
keys = (C.c_ubyte * 32)()
x.x.XQueryKeymap(x.d, keys)
print(json.dumps({'pressedKeys': [i for i in range(256) if keys[i // 8] & (1 << (i % 8))]}))
