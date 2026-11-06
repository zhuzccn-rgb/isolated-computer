"""Send physical ASCII keys only to the explicit private test display."""
import ctypes as C
import os
import re
import sys
import time

x = C.CDLL('libX11.so.6')
t = C.CDLL('libXtst.so.6')
x.XOpenDisplay.argtypes = [C.c_char_p]
x.XOpenDisplay.restype = C.c_void_p
x.XStringToKeysym.argtypes = [C.c_char_p]
x.XStringToKeysym.restype = C.c_ulong
x.XKeysymToKeycode.argtypes = [C.c_void_p, C.c_ulong]
x.XKeysymToKeycode.restype = C.c_ubyte
x.XFlush.argtypes = [C.c_void_p]
x.XCloseDisplay.argtypes = [C.c_void_p]
t.XTestFakeKeyEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
target = sys.argv[1]
if not re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', target) or target == os.environ.get('DISPLAY'):
    raise RuntimeError('Refusing host or nonlocal test display')
display = x.XOpenDisplay(target.encode())
if not display:
    raise RuntimeError('Cannot open private test display')
try:
    for index, char in enumerate(sys.argv[2].encode('ascii')):
        code = x.XKeysymToKeycode(display, x.XStringToKeysym(bytes([char])))
        if not code:
            raise RuntimeError('Unsupported test key')
        t.XTestFakeKeyEvent(display, code, 1, 0)
        t.XTestFakeKeyEvent(display, code, 0, 0)
        x.XFlush(display)
        print(index, int(time.time() * 1000), flush=True)
        time.sleep(.08)
finally:
    x.XCloseDisplay(display)
